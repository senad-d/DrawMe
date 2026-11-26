/**
 * Animation analysis and standalone SVG enhancement. draw.io natively emits
 * persistent connector-flow CSS; DrawMe adds a portable opacity timeline for
 * page-level sequences and verifies that the requested motion survived export.
 */
import { readFile, writeFile } from "node:fs/promises";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { DEFAULT_VALIDATION_LIMITS, ValidationStop, createValidationBudget, diagramPages, pageModel, readDiagramXml, type ValidationBudget } from "./diagram-files";
import { type DomEl, attr, elemChildren, firstByTag } from "./dom";
import { collectCells } from "./geometry";
import { assertStandaloneImages, cssString, walkElements } from "./svg-helpers";

const PORTABLE_ACTIONS = new Set(["opacity", "show", "hide", "toggle", "fadeIn", "fadeOut", "fadeTo"]);
const DRAWIO_ONLY_ACTIONS = new Set([
  "wipeIn",
  "wipeOut",
  "popIn",
  "popOut",
  "style",
  "toggleStyle",
  "highlight",
  "flow",
  "select",
  "scroll",
  "viewbox",
  "open",
  "tags",
]);
const FLOW_DIRECTIONS = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const FLOW_TIMINGS = new Set(["linear", "ease", "ease-in", "ease-out", "ease-in-out"]);
const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_FADE_DURATION_MS = 1000;
const INSTANT_EPSILON_MS = 0.01;
// Match the validation sink's excerpt ceiling on the arrays used by tool failures.
const MAX_ANIMATION_DIAGNOSTIC_LENGTH = 512;

type JsonObject = Record<string, unknown>;
type Report = (level: "error" | "warning" | "observation", message: string) => void;

export function createAnimationBudget(): ValidationBudget {
  return createValidationBudget(DEFAULT_VALIDATION_LIMITS, () => {});
}

export function reportAnimationFinding(
  budget: ValidationBudget, level: Parameters<Report>[0], findings: string[], message: string,
): void {
  const excerpt = message.length > MAX_ANIMATION_DIAGNOSTIC_LENGTH
    ? `${message.slice(0, MAX_ANIMATION_DIAGNOSTIC_LENGTH - 1)}…`
    : message;
  budget.finding(level, excerpt);
  findings.push(excerpt);
}

export interface NativeAnimationSequence {
  enabled: boolean;
  loop: boolean;
  steps: JsonObject[];
}

export interface PageAnimationAnalysis {
  pageName: string;
  flowEdgeIds: string[];
  sequence: NativeAnimationSequence | null;
  cells: Map<string, DomEl>;
  animatableCellIds: string[];
  errors: string[];
  warnings: string[];
  observations: string[];
}

export interface AnimatedSvgSummary {
  page: string;
  connectorFlows: number;
  sequenceSteps: number;
  sequenceDurationMs: number;
  sequenceCompiled: boolean;
  verified: boolean;
}

interface OpacityPoint {
  time: number;
  value: number;
}

interface CompiledTimeline {
  css: string;
  durationMs: number;
  targetCellIds: string[];
  hasMotion: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function styleMap(style: string | null, budget?: ValidationBudget): Map<string, string> {
  budget?.work(Math.ceil((style?.length ?? 0) / 64));
  const values = new Map<string, string>();
  for (const item of (style ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator > 0) values.set(item.slice(0, separator), item.slice(separator + 1));
  }
  return values;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function animationGraphRoot(model: DomEl, budget?: ValidationBudget): DomEl | null {
  budget?.work(model.childNodes.length);
  return firstByTag(model, "root");
}

function animationAttribute(root: DomEl | null, budget?: ValidationBudget): string | null {
  if (!root) return null;
  budget?.work(root.childNodes.length);
  for (const child of elemChildren(root)) {
    if (attr(child, "id") !== "0") continue;
    const direct = attr(child, "animation");
    if (direct !== null) return direct;
    budget?.work(child.childNodes.length);
    const inner = firstByTag(child, "mxCell");
    const nested = inner ? attr(inner, "animation") : null;
    if (nested !== null) return nested;
  }
  return null;
}

function parseSequence(raw: string | null, report: Report, budget?: ValidationBudget): NativeAnimationSequence | null {
  budget?.work(Math.ceil((raw?.length ?? 0) / 64));
  if (raw === null || raw.trim() === "") return null;
  if (!raw.trimStart().startsWith("{")) {
    report("warning", "legacy text page animations cannot be compiled to standalone animated SVG; save the animation as JSON");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    report("error", `page animation contains malformed JSON: ${(error as Error).message}`);
    return null;
  }

  if (!isObject(parsed)) {
    report("error", "page animation JSON must be an object");
    return null;
  }
  const value = isObject(parsed.animation) ? parsed.animation : parsed;
  if (!Array.isArray(value.steps)) {
    report("error", "page animation JSON must contain a steps array");
    return null;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    report("error", "page animation enabled must be a boolean");
  }
  if (value.loop !== undefined && typeof value.loop !== "boolean") {
    report("error", "page animation loop must be a boolean");
  }

  const steps = parseSequenceSteps(value.steps, report, budget);
  return {
    enabled: value.enabled === undefined ? true : value.enabled === true,
    loop: value.loop === undefined ? true : value.loop === true,
    steps,
  };
}

function parseSequenceSteps(raw: unknown[], report: Report, budget?: ValidationBudget): JsonObject[] {
  const steps: JsonObject[] = [];
  raw.forEach((step, index) => {
    budget?.work();
    if (!isObject(step)) report("error", `page animation step ${index + 1} must be an object`);
    else steps.push(step);
  });
  return steps;
}

function isAnimatable(cell: DomEl): boolean {
  return cell.getAttribute("vertex") === "1" || cell.getAttribute("edge") === "1";
}

function collectCellData(cells: DomEl[], budget?: ValidationBudget): { byId: Map<string, DomEl>; animatable: string[] } {
  budget?.work(cells.length);
  const byId = new Map<string, DomEl>();
  const animatable: string[] = [];
  for (const cell of cells) {
    const id = attr(cell, "id");
    if (id === null) continue;
    byId.set(id, cell);
    if (isAnimatable(cell)) animatable.push(id);
  }
  return { byId, animatable };
}

function validateFlowAnimations(cells: DomEl[], report: Report, flowEdgeIds: string[], budget?: ValidationBudget): void {
  for (const cell of cells) {
    budget?.work();
    const style = styleMap(attr(cell, "style"), budget);
    const flow = style.get("flowAnimation");
    const id = attr(cell, "id") ?? "?";
    if (flow !== undefined && flow !== "0" && flow !== "1") {
      report("error", `cell '${id}' has invalid flowAnimation '${flow}' (expected 0 or 1)`);
      continue;
    }
    if (flow !== "1") continue;
    if (cell.getAttribute("edge") !== "1") {
      report("error", `cell '${id}' uses flowAnimation=1 but is not an edge`);
      continue;
    }
    flowEdgeIds.push(id);

    validateFlowStyle(style, id, report);
  }
}

function validateFlowStyle(style: Map<string, string>, id: string, report: Report): void {
  const duration = style.get("flowAnimationDuration");
  if (duration !== undefined && (Number(duration) <= 0 || !Number.isFinite(Number(duration)))) {
    report("error", `edge '${id}' has invalid flowAnimationDuration '${duration}' (expected a positive millisecond value)`);
  }
  const direction = style.get("flowAnimationDirection");
  if (direction !== undefined && !FLOW_DIRECTIONS.has(direction)) {
    report("error", `edge '${id}' has invalid flowAnimationDirection '${direction}'`);
  }
  const timing = style.get("flowAnimationTimingFunction");
  if (timing !== undefined && !FLOW_TIMINGS.has(timing)) {
    report("error", `edge '${id}' has invalid flowAnimationTimingFunction '${timing}'`);
  }
}

function selectorIds(
  params: JsonObject,
  stepNumber: number,
  action: string,
  page: Pick<PageAnimationAnalysis, "cells" | "animatableCellIds">,
  report: Report | undefined,
  budget?: ValidationBudget,
): string[] {
  if (params.layers !== undefined || params.tags !== undefined) {
    report?.("warning",
      `page animation step ${stepNumber} action '${action}' uses layer/tag selectors, which standalone animated SVG does not support`,
    );
  }
  if (!Array.isArray(params.cells)) {
    report?.("error", `page animation step ${stepNumber} action '${action}' must provide a cells array`);
    return [];
  }

  const requested = new Set<string>();
  for (const cellId of params.cells) {
    budget?.work();
    if (typeof cellId !== "string") {
      report?.("error", `page animation step ${stepNumber} action '${action}' has a non-string cell id`);
    } else if (cellId === "*") {
      budget?.work(page.animatableCellIds.length);
      for (const id of page.animatableCellIds) requested.add(id);
    } else {
      const cell = page.cells.get(cellId);
      if (!cell) report?.("error", `page animation step ${stepNumber} action '${action}' references missing cell '${cellId}'`);
      else if (!isAnimatable(cell)) {
        report?.("error", `page animation step ${stepNumber} action '${action}' references non-animatable cell '${cellId}'`);
      } else requested.add(cellId);
    }
  }

  excludeSelectorIds(params.excludeCells, requested, stepNumber, action, report, budget);
  budget?.work(requested.size);
  return [...requested];
}

function excludeSelectorIds(
  raw: unknown, requested: Set<string>, stepNumber: number, action: string, report?: Report, budget?: ValidationBudget,
): void {
  if (raw === undefined) return;
  const invalid = () => report?.("error", `page animation step ${stepNumber} action '${action}' has an invalid excludeCells array`);
  if (!Array.isArray(raw)) return invalid();
  budget?.work(raw.length);
  if (raw.some((id) => typeof id !== "string")) return invalid();
  budget?.work(raw.length);
  for (const id of raw) {
    if (id === "*") requested.clear();
    else requested.delete(id);
  }
}

function validateActionParameters(action: string, params: JsonObject, stepNumber: number, report: Report): void {
  if (action === "opacity" || action === "fadeTo") {
    const value = finiteNumber(params.value);
    if (value === null || value < 0 || value > 1) {
      report("error", `page animation step ${stepNumber} action '${action}' needs value between 0 and 1`);
    }
  }
  if (action.startsWith("fade") && params.delay !== undefined) {
    const delay = finiteNumber(params.delay);
    if (delay === null || delay < 0) {
      report("error", `page animation step ${stepNumber} action '${action}' has an invalid delay`);
    }
  }
}

function validateSequence(
  sequence: NativeAnimationSequence, page: PageAnimationAnalysis, report: Report, budget?: ValidationBudget,
): void {
  if (sequence.enabled && sequence.steps.length === 0) report("error", "enabled page animation must contain at least one step");
  let hasPortableVisualAction = false;
  for (let index = 0; index < sequence.steps.length; index++) {
    budget?.work();
    const step = sequence.steps[index];
    const stepNumber = index + 1;
    if (step.immediate !== undefined && typeof step.immediate !== "boolean") {
      report("error", `page animation step ${stepNumber} immediate must be a boolean`);
    }

    let hasAction = false;
    for (const action in step) {
      budget?.work();
      if (action === "immediate" || !Object.hasOwn(step, action)) continue;
      hasAction = true;
      const portable = validateSequenceAction(action, step[action], stepNumber, page, report, budget);
      hasPortableVisualAction ||= portable;
    }
    if (!hasAction) report("error", `page animation step ${stepNumber} has no action`);
  }
  if (sequence.enabled && sequence.steps.length > 0 && !hasPortableVisualAction && page.flowEdgeIds.length === 0) {
    report("error", "enabled page animation must contain at least one portable visual action");
  }
}

function validateSequenceAction(
  action: string, raw: unknown, stepNumber: number, page: PageAnimationAnalysis, report: Report, budget?: ValidationBudget,
): boolean {
  if (action === "wait") {
    const delay = finiteNumber(raw);
    if (delay === null || delay < 0) report("error", `page animation step ${stepNumber} wait must be a non-negative number`);
    return false;
  }
  if (DRAWIO_ONLY_ACTIONS.has(action) || !PORTABLE_ACTIONS.has(action)) {
    report("warning", `page animation step ${stepNumber} action '${action}' is not supported in standalone animated SVG`);
    return false;
  }
  if (!isObject(raw)) {
    report("error", `page animation step ${stepNumber} action '${action}' must be an object`);
    return true;
  }
  selectorIds(raw, stepNumber, action, page, report, budget);
  validateActionParameters(action, raw, stepNumber, report);
  return true;
}

export function analyzeAnimationPage(diagram: DomEl, budget = createAnimationBudget()): PageAnimationAnalysis {
  const page: PageAnimationAnalysis = {
    pageName: attr(diagram, "name") ?? "?",
    flowEdgeIds: [],
    sequence: null,
    cells: new Map(),
    animatableCellIds: [],
    errors: [],
    warnings: [],
    observations: [],
  };
  const findings = { error: page.errors, warning: page.warnings, observation: page.observations };
  const report: Report = (level, message) => reportAnimationFinding(budget, level, findings[level], message);
  if (diagram.tagName !== "mxGraphModel") budget.work(diagram.childNodes.length);
  const model = pageModel(diagram);
  if (!model) {
    report("error", "compressed or missing page model cannot be inspected for animation");
    return page;
  }

  const root = animationGraphRoot(model, budget);
  const cells = collectCells(root, budget.work);
  const { byId, animatable } = collectCellData(cells, budget);
  page.cells = byId;
  page.animatableCellIds = animatable;
  const { flowEdgeIds } = page;
  validateFlowAnimations(cells, report, flowEdgeIds, budget);
  if (flowEdgeIds.length > 0) {
    const shown = flowEdgeIds.slice(0, 8).map((id) => id.slice(0, 48));
    const connectorIds = shown.map((id) => "'" + id + "'").join(", ") + (shown.length < flowEdgeIds.length ? ", …" : "");
    report("observation",
      `${flowEdgeIds.length} connector(s) use persistent flow animation; SVG preserves it, static formats do not: ${connectorIds}`,
    );
  }
  const sequence = parseSequence(animationAttribute(root, budget), report, budget);
  page.sequence = sequence;
  if (sequence) {
    validateSequence(sequence, page, report, budget);
    report("observation",
      sequence.enabled
        ? `page animation contains ${sequence.steps.length} step(s); standalone animated SVG supports visibility, opacity, fade, and wait actions`
        : `page animation contains ${sequence.steps.length} step(s) but autoplay is disabled`,
    );
  }
  return page;
}

export function analyzeDrawioAnimation(xml: string, pageIndex = 1, budget = createAnimationBudget()): PageAnimationAnalysis {
  if (!Number.isInteger(pageIndex) || pageIndex < 1) throw new Error("pageIndex must be a positive 1-based integer");
  budget.work(Math.ceil(xml.length / 64));
  let parserStop: ValidationStop | undefined;
  let doc: ReturnType<DOMParser["parseFromString"]>;
  try {
    doc = new DOMParser({ onError: (level, message) => {
      try {
        budget.finding(level === "warning" ? "warning" : "error", message);
      } catch (error) {
        if (error instanceof ValidationStop) parserStop = error;
        throw error;
      }
    } }).parseFromString(xml, "text/xml");
  } catch (error) {
    throw parserStop ?? error;
  }
  const root = doc.documentElement as unknown as DomEl | null;
  if (!root) throw new Error("no root element (malformed XML)");
  budget.work(root.childNodes.length);
  const pages = diagramPages(root);
  const page = pages[pageIndex - 1];
  if (!page) throw new Error(`pageIndex ${pageIndex} is out of range (diagram has ${pages.length} page(s))`);
  return analyzeAnimationPage(page, budget);
}

function actionDuration(action: string, value: unknown): number {
  if (action === "wait") return finiteNumber(value) ?? 0;
  if (!action.startsWith("fade") || !isObject(value)) return 0;
  return finiteNumber(value.delay) ?? DEFAULT_FADE_DURATION_MS;
}

export function baseOpacity(style: string | null, budget?: ValidationBudget): number {
  const raw = styleMap(style, budget).get("opacity");
  const opacity = raw === undefined ? 1 : Number(raw) / 100;
  return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
}

function putPoint(points: OpacityPoint[], time: number, value: number, budget: ValidationBudget): void {
  budget.work(points.length);
  const existing = points.find((point) => Math.abs(point.time - time) < 1e-9);
  if (existing) existing.value = value;
  else points.push({ time, value });
}

function putInstant(points: OpacityPoint[], time: number, before: number, after: number, budget: ValidationBudget): void {
  if (time > 0) putPoint(points, Math.max(0, time - INSTANT_EPSILON_MS), before, budget);
  putPoint(points, time, after, budget);
}

type TimeWindow = [start: number, end: number];

function opacityWindows(points: OpacityPoint[], duration: number, onlyChanges: boolean, budget: ValidationBudget): TimeWindow[] {
  budget.work(points.length);
  const windows: TimeWindow[] = [];
  for (let index = 0; index < points.length; index++) {
    const { time, value } = points[index];
    const next = points[index + 1];
    const end = next?.time ?? duration;
    const nextValue = next?.value ?? value;
    const present = onlyChanges ? value !== nextValue : value > 0 || nextValue > 0;
    if (!present || time >= end) continue;
    if (windows.at(-1)?.[1] === time) windows.at(-1)![1] = end;
    else windows.push([time, end]);
  }
  return windows;
}

function intersectWindows(left: TimeWindow[], right: TimeWindow[], budget: ValidationBudget): TimeWindow[] {
  const overlap: TimeWindow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    budget.work();
    const start = Math.max(left[i][0], right[j][0]);
    const end = Math.min(left[i][1], right[j][1]);
    if (start < end) overlap.push([start, end]);
    if (left[i][1] <= right[j][1]) i++;
    else j++;
  }
  return overlap;
}

function hasVisibleOpacityChange(
  tracks: Map<string, OpacityPoint[]>, analysis: PageAnimationAnalysis, duration: number, budget: ValidationBudget,
): boolean {
  const parents = new Map<string, TimeWindow[]>();
  for (const [id, points] of tracks) {
    let changes = opacityWindows(points, duration, true, budget);
    const seen = new Set([id]);
    const cell = analysis.cells.get(id)!;
    if (attr(cell, "visible") === "0") continue;
    let parent = attr(cell, "parent");
    while (changes.length > 0 && parent !== null && !seen.has(parent)) {
      budget.work();
      seen.add(parent);
      const ancestor = analysis.cells.get(parent);
      if (!ancestor) break;
      let visible = parents.get(parent);
      if (!visible) {
        const track = tracks.get(parent);
        if (attr(ancestor, "visible") === "0") visible = [];
        else if (track) visible = opacityWindows(track, duration, false, budget);
        else visible = baseOpacity(attr(ancestor, "style"), budget) > 0 ? [[0, duration]] : [];
        parents.set(parent, visible);
      }
      changes = intersectWindows(changes, visible, budget);
      parent = attr(ancestor, "parent");
    }
    if (changes.length > 0) return true;
  }
  return false;
}

function compileOpacityTimeline(analysis: PageAnimationAnalysis, budget: ValidationBudget): CompiledTimeline | null {
  const sequence = analysis.sequence;
  if (!sequence?.enabled || sequence.steps.length === 0) return null;

  const initial = new Map<string, number>();
  const states = new Map<string, number>();
  const tracks = new Map<string, OpacityPoint[]>();
  for (const id of analysis.animatableCellIds) {
    budget.work();
    const value = baseOpacity(attr(analysis.cells.get(id)!, "style"), budget);
    initial.set(id, value);
    states.set(id, value);
    tracks.set(id, [{ time: 0, value }]);
  }

  let time = 0;
  for (let index = 0; index < sequence.steps.length; ) {
    budget.work();
    const batch: JsonObject[] = [sequence.steps[index++]];
    while (index < sequence.steps.length && sequence.steps[index].immediate === true) {
      budget.work();
      batch.push(sequence.steps[index++]);
    }
    time += compileOpacityBatch(batch, analysis, states, tracks, time, budget);
    if (!Number.isFinite(time)) throw new Error("page animation duration is too large");
  }

  const durationMs = Math.max(1, time);
  const reducedMotionRules: string[] = [];
  const rules: string[] = [];
  const targetCellIds: string[] = [];
  let animations = 0;
  for (const [id, points] of tracks) {
    budget.work(points.length);
    const value = points[0].value;
    const hasChanges = points.some((point) => point.value !== value);
    if (!hasChanges && value === initial.get(id)) continue;
    budget.work(Math.ceil(id.length / 64));
    const selector = `g[data-cell-id=${cssString(id)}]`;
    targetCellIds.push(id);
    reducedMotionRules.push(`  ${selector} { animation: none !important; opacity: ${initial.get(id)} !important; }`);
    if (!hasChanges) {
      // A t=0 change is a playback baseline, not an animation keyframe. It
      // must win even when the renderer wrote the authored opacity inline.
      rules.push(`${selector} { opacity: ${value} !important; }`);
      continue;
    }
    putPoint(points, durationMs, states.get(id) ?? 1, budget);
    budget.work(points.length * Math.ceil(Math.log2(points.length + 1)));
    points.sort((a, b) => a.time - b.time);
    const name = `drawme-opacity-${++animations}`;
    const keyframes = points
      .map((point) => `  ${((point.time / durationMs) * 100).toFixed(9)}% { opacity: ${point.value}; }`)
      .join("\n");
    rules.push(
      `@keyframes ${name} {\n${keyframes}\n}`,
      `${selector} { animation: ${name} ${durationMs}ms ease-in-out 0ms ${sequence.loop ? "infinite" : "1"} normal forwards; }`,
    );
  }
  const hasMotion = animations > 0 && hasVisibleOpacityChange(tracks, analysis, durationMs, budget);
  if (!hasMotion && analysis.flowEdgeIds.length === 0) throw new Error("page animation has no visible opacity change to compile");
  if (rules.length === 0) return null;
  rules.push(
    `@media (prefers-reduced-motion: reduce) {\n${reducedMotionRules.join("\n")}\n  g[data-cell-id] * { animation: none !important; }\n}`,
  );
  return { css: rules.join("\n"), durationMs, targetCellIds, hasMotion };
}

function opacityEndpoints(action: string, params: JsonObject, current: number): [number, number] {
  switch (action) {
    case "opacity":
    case "fadeTo": return [current, params.value as number];
    case "show": return [current, 1];
    case "hide": return [current, 0];
    case "toggle": return [current, current > 0 ? 0 : 1];
    case "fadeIn": return [0, 1];
    case "fadeOut": return [1, 0];
    default: return [current, current];
  }
}

function compileOpacityAction(
  action: string, params: JsonObject, id: string, states: Map<string, number>,
  tracks: Map<string, OpacityPoint[]>, time: number, budget: ValidationBudget,
): number {
  const current = states.get(id) ?? 1;
  const points = tracks.get(id)!;
  const [from, target] = opacityEndpoints(action, params, current);
  const duration = actionDuration(action, params);
  if (duration > 0) {
    if (Math.abs(current - from) > 1e-9) putInstant(points, time, current, from, budget);
    else putPoint(points, time, from, budget);
    putPoint(points, time + duration, target, budget);
  } else {
    putInstant(points, time, current, target, budget);
  }
  return target;
}

function compileOpacityBatch(
  batch: JsonObject[], analysis: PageAnimationAnalysis, states: Map<string, number>,
  tracks: Map<string, OpacityPoint[]>, time: number, budget: ValidationBudget,
): number {
  let duration = 0;
  const updates = new Map<string, number>();
  for (const step of batch) {
    for (const action in step) {
      budget.work();
      if (action === "immediate" || !Object.hasOwn(step, action)) continue;
      const raw = step[action];
      duration = Math.max(duration, actionDuration(action, raw));
      if (action === "wait") continue;
      const params = raw as JsonObject;
      for (const id of selectorIds(params, 0, action, analysis, undefined, budget)) {
        budget.work();
        if (updates.has(id)) {
          throw new Error(`parallel animation actions target cell '${id}' more than once in the same batch`);
        }
        updates.set(id, compileOpacityAction(action, params, id, states, tracks, time, budget));
      }
    }
  }
  for (const [id, value] of updates) states.set(id, value);
  return duration;
}

function hasAnimatedPath(root: DomEl): boolean {
  return walkElements(root).some((element) => {
    if (element.tagName !== "path") return false;
    const style = attr(element, "style") ?? "";
    return /(?:^|;)\s*animation\s*:/.test(style);
  });
}

export function verifyFlowGroups(ids: string[], groups: Map<string, DomEl>): void {
  const missing = ids.filter((id) => !groups.has(id));
  if (missing.length > 0) {
    throw new Error(`SVG is missing animated connector group(s): ${missing.join(", ")}`);
  }
  const staticGroups = ids.filter((id) => !hasAnimatedPath(groups.get(id)!));
  if (staticGroups.length > 0) {
    throw new Error(`draw.io did not preserve flow animation for connector(s): ${staticGroups.join(", ")}`);
  }
}

function verifyTimelineGroups(timeline: CompiledTimeline | null, groups: Map<string, DomEl>): void {
  if (!timeline) return;
  const missing = timeline.targetCellIds.filter((id) => !groups.has(id));
  if (missing.length > 0) {
    throw new Error(
      `SVG is missing page-animation cell group(s): ${missing.join(", ")}; do not use visible=0 for cells revealed by an animation`,
    );
  }
}

export async function enhanceAnimatedSvg(
  input: string,
  output: string,
  pageIndex = 1,
): Promise<AnimatedSvgSummary> {
  const source = await readDiagramXml(input);
  const budget = createAnimationBudget();
  const analysis = analyzeDrawioAnimation(source, pageIndex, budget);
  const blockers = [
    ...analysis.errors,
    ...(analysis.sequence?.enabled === false ? [] : analysis.warnings),
  ];
  if (blockers.length > 0) throw new Error(blockers.join("; "));
  const activeSequence = analysis.sequence?.enabled === true && analysis.sequence.steps.length > 0;
  if (analysis.flowEdgeIds.length === 0 && !activeSequence) {
    throw new Error("the selected page has no enabled page sequence or connector with flowAnimation=1");
  }

  const svg = await readFile(output, "utf8");
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgRoot = doc.documentElement as unknown as DomEl | null;
  if (svgRoot?.tagName !== "svg") throw new Error("draw.io output is not valid SVG");

  const groupElements = new Map(
    walkElements(svgRoot)
      .map((element) => [attr(element, "data-cell-id"), element] as const)
      .filter((entry): entry is readonly [string, DomEl] => entry[0] !== null),
  );
  verifyFlowGroups(analysis.flowEdgeIds, groupElements);

  const timeline = compileOpacityTimeline(analysis, budget);
  verifyTimelineGroups(timeline, groupElements);

  const flowReducedMotion = analysis.flowEdgeIds.length > 0
    ? `@media (prefers-reduced-motion: reduce) {\n${analysis.flowEdgeIds
        .map((id) => `  g[data-cell-id=${cssString(id)}] * { animation: none !important; }`)
        .join("\n")}\n}`
    : "";
  const injectedCss = [timeline?.css, flowReducedMotion].filter(Boolean).join("\n");
  if (injectedCss) {
    const documentNode = doc;
    let defs = walkElements(svgRoot).find((element) => element.tagName === "defs");
    if (!defs) {
      defs = documentNode.createElementNS(SVG_NS, "defs") as unknown as DomEl;
      const rootNode = svgRoot as unknown as { firstChild: unknown; insertBefore(node: unknown, before: unknown): void };
      rootNode.insertBefore(defs, rootNode.firstChild);
    }
    const style = documentNode.createElementNS(SVG_NS, "style");
    style.setAttribute("type", "text/css");
    style.setAttribute("data-drawme-animation", timeline ? "opacity-timeline" : "reduced-motion"); // NOSONAR: xmldom XML elements have no browser dataset API.
    style.appendChild(documentNode.createTextNode(injectedCss));
    (defs as unknown as { appendChild(node: unknown): void }).appendChild(style);
  }
  const finished = injectedCss ? new XMLSerializer().serializeToString(doc) : svg;
  assertStandaloneImages(finished);
  if (injectedCss) await writeFile(output, finished, "utf8");

  return {
    page: analysis.pageName,
    connectorFlows: analysis.flowEdgeIds.length,
    sequenceSteps: activeSequence ? analysis.sequence!.steps.length : 0,
    sequenceDurationMs: timeline?.durationMs ?? 0,
    sequenceCompiled: timeline?.hasMotion ?? false,
    verified: analysis.flowEdgeIds.length > 0 || (timeline?.hasMotion ?? false),
  };
}
