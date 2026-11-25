/**
 * Animation analysis and standalone SVG enhancement. draw.io natively emits
 * persistent connector-flow CSS; DrawMe adds a portable opacity timeline for
 * page-level sequences and verifies that the requested motion survived export.
 */
import { readFile, writeFile } from "node:fs/promises";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { type DomEl, ELEMENT_NODE, attr, diagramPages, directText, firstByTag, pageModel } from "./dom";
import { collectCells } from "./geometry";
import { SVG_NS, cssString, verifyStandaloneImages, walkElements } from "./svg-helpers";
import type { ValidationBudget } from "./validation-budget";
import { readDiagramXml } from "./xml-input";

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
const DEFAULT_FADE_DURATION_MS = 1000;
const INSTANT_EPSILON_MS = 0.01;

type JsonObject = Record<string, unknown>;

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
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function styleMap(style: string | null, budget?: ValidationBudget): Map<string, string> {
  const values = new Map<string, string>();
  if (style === null) return values;
  for (let start = 0; start < style.length; ) {
    budget?.work();
    const next = style.indexOf(";", start);
    const end = next === -1 ? style.length : next;
    const item = style.slice(start, end);
    const separator = item.indexOf("=");
    if (separator > 0) values.set(item.slice(0, separator), item.slice(separator + 1));
    start = end + 1;
  }
  return values;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function animationAttribute(root: DomEl | null, budget?: ValidationBudget): string | null {
  if (!root) return null;
  for (let i = 0; i < root.childNodes.length; i++) {
    budget?.work();
    const child = root.childNodes[i];
    if (child.nodeType !== ELEMENT_NODE || attr(child, "id") !== "0") continue;
    const direct = attr(child, "animation");
    if (direct !== null) return direct;
    budget?.work(child.childNodes.length);
    const inner = firstByTag(child, "mxCell");
    const nested = inner ? attr(inner, "animation") : null;
    if (nested !== null) return nested;
  }
  return null;
}

function parseSequence(raw: string | null, errors: string[], warnings: string[], budget?: ValidationBudget): NativeAnimationSequence | null {
  if (raw === null || raw.trim() === "") return null;
  if (!raw.trimStart().startsWith("{")) {
    budget?.diagnostic();
    warnings.push("legacy text page animations cannot be compiled to standalone animated SVG; save the animation as JSON");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    budget?.diagnostic();
    errors.push(`page animation contains malformed JSON: ${(error as Error).message}`);
    return null;
  }

  if (!isObject(parsed)) {
    budget?.diagnostic();
    errors.push("page animation JSON must be an object");
    return null;
  }
  const value = isObject(parsed.animation) ? parsed.animation : parsed;
  if (!Array.isArray(value.steps)) {
    budget?.diagnostic();
    errors.push("page animation JSON must contain a steps array");
    return null;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    budget?.diagnostic();
    errors.push("page animation enabled must be a boolean");
  }
  if (value.loop !== undefined && typeof value.loop !== "boolean") {
    budget?.diagnostic();
    errors.push("page animation loop must be a boolean");
  }

  const steps = parseSequenceSteps(value.steps, errors, budget);
  return {
    enabled: value.enabled === undefined ? true : value.enabled === true,
    loop: value.loop === undefined ? true : value.loop === true,
    steps,
  };
}

function parseSequenceSteps(raw: unknown[], errors: string[], budget?: ValidationBudget): JsonObject[] {
  const steps: JsonObject[] = [];
  raw.forEach((step, index) => {
    budget?.work();
    if (!isObject(step)) {
      budget?.diagnostic();
      errors.push(`page animation step ${index + 1} must be an object`);
    } else steps.push(step);
  });
  return steps;
}

function collectCellData(cells: DomEl[], budget?: ValidationBudget): { byId: Map<string, DomEl>; animatable: Set<string> } {
  const byId = new Map<string, DomEl>();
  const animatable = new Set<string>();
  for (const cell of cells) {
    budget?.work();
    const id = attr(cell, "id");
    if (id === null) continue;
    byId.set(id, cell);
    if (cell.getAttribute("vertex") === "1" || cell.getAttribute("edge") === "1") animatable.add(id);
  }
  return { byId, animatable };
}

function validateFlowAnimations(cells: DomEl[], errors: string[], flowEdgeIds: string[], budget?: ValidationBudget): void {
  for (const cell of cells) {
    budget?.work();
    const style = styleMap(attr(cell, "style"), budget);
    const flow = style.get("flowAnimation");
    const id = attr(cell, "id") ?? "?";
    if (flow !== undefined && flow !== "0" && flow !== "1") {
      budget?.diagnostic();
      errors.push(`cell '${id}' has invalid flowAnimation '${flow}' (expected 0 or 1)`);
      continue;
    }
    if (flow !== "1") continue;
    if (cell.getAttribute("edge") !== "1") {
      budget?.diagnostic();
      errors.push(`cell '${id}' uses flowAnimation=1 but is not an edge`);
      continue;
    }
    flowEdgeIds.push(id);

    validateFlowStyle(style, id, errors, budget);
  }
}

function validateFlowStyle(style: Map<string, string>, id: string, errors: string[], budget?: ValidationBudget): void {
  const duration = style.get("flowAnimationDuration");
  if (duration !== undefined && (Number(duration) <= 0 || !Number.isFinite(Number(duration)))) {
    budget?.diagnostic();
    errors.push(`edge '${id}' has invalid flowAnimationDuration '${duration}' (expected a positive millisecond value)`);
  }
  const direction = style.get("flowAnimationDirection");
  if (direction !== undefined && !FLOW_DIRECTIONS.has(direction)) {
    budget?.diagnostic();
    errors.push(`edge '${id}' has invalid flowAnimationDirection '${direction}'`);
  }
  const timing = style.get("flowAnimationTimingFunction");
  if (timing !== undefined && !FLOW_TIMINGS.has(timing)) {
    budget?.diagnostic();
    errors.push(`edge '${id}' has invalid flowAnimationTimingFunction '${timing}'`);
  }
}

function validateSelectors(
  params: JsonObject,
  stepNumber: number,
  action: string,
  cells: Map<string, DomEl>,
  animatable: Set<string>,
  errors: string[],
  warnings: string[],
  budget?: ValidationBudget,
): void {
  if (params.layers !== undefined || params.tags !== undefined) {
    budget?.diagnostic();
    warnings.push(
      `page animation step ${stepNumber} action '${action}' uses layer/tag selectors, which standalone animated SVG does not support`,
    );
  }
  if (!Array.isArray(params.cells)) {
    budget?.diagnostic();
    errors.push(`page animation step ${stepNumber} action '${action}' must provide a cells array`);
    return;
  }

  for (const cellId of params.cells) {
    budget?.work();
    // The wildcard refers only to known animatable cells; there is no need to expand it during validation.
    if (cellId === "*") continue;
    if (typeof cellId !== "string") {
      budget?.diagnostic();
      errors.push(`page animation step ${stepNumber} action '${action}' has a non-string cell id`);
    } else if (!cells.has(cellId)) {
      budget?.diagnostic();
      errors.push(`page animation step ${stepNumber} action '${action}' references missing cell '${cellId}'`);
    } else if (!animatable.has(cellId)) {
      budget?.diagnostic();
      errors.push(`page animation step ${stepNumber} action '${action}' references non-animatable cell '${cellId}'`);
    }
  }

  const excluded = params.excludeCells;
  if (excluded !== undefined && (!Array.isArray(excluded) || excluded.some((id) => {
    budget?.work();
    return typeof id !== "string";
  }))) {
    budget?.diagnostic();
    errors.push(`page animation step ${stepNumber} action '${action}' has an invalid excludeCells array`);
  }
}

function validateActionParameters(action: string, params: JsonObject, stepNumber: number, errors: string[], budget?: ValidationBudget): void {
  if (action === "opacity" || action === "fadeTo") {
    const value = finiteNumber(params.value);
    if (value === null || value < 0 || value > 1) {
      budget?.diagnostic();
      errors.push(`page animation step ${stepNumber} action '${action}' needs value between 0 and 1`);
    }
  }
  if (action.startsWith("fade") && params.delay !== undefined) {
    const delay = finiteNumber(params.delay);
    if (delay === null || delay < 0) {
      budget?.diagnostic();
      errors.push(`page animation step ${stepNumber} action '${action}' has an invalid delay`);
    }
  }
}

function validateSequence(
  sequence: NativeAnimationSequence,
  cells: Map<string, DomEl>,
  animatable: Set<string>,
  errors: string[],
  warnings: string[],
  budget?: ValidationBudget,
): void {
  if (sequence.enabled && sequence.steps.length === 0) {
    budget?.diagnostic();
    errors.push("enabled page animation must contain at least one step");
  }
  let hasPortableVisualAction = false;
  for (let index = 0; index < sequence.steps.length; index++) {
    budget?.work();
    const step = sequence.steps[index];
    const stepNumber = index + 1;
    if (step.immediate !== undefined && typeof step.immediate !== "boolean") {
      budget?.diagnostic();
      errors.push(`page animation step ${stepNumber} immediate must be a boolean`);
    }

    let hasAction = false;
    for (const action in step) {
      budget?.work();
      if (!Object.hasOwn(step, action) || action === "immediate") continue;
      hasAction = true;
      const portable = validateSequenceAction(action, step[action], stepNumber, cells, animatable, errors, warnings, budget);
      hasPortableVisualAction ||= portable;
    }
    if (!hasAction) {
      budget?.diagnostic();
      errors.push(`page animation step ${stepNumber} has no action`);
    }
  }
  if (sequence.enabled && sequence.steps.length > 0 && !hasPortableVisualAction) {
    budget?.diagnostic();
    errors.push("enabled page animation must contain at least one portable visual action");
  }
}

function validateSequenceAction(
  action: string, raw: unknown, stepNumber: number, cells: Map<string, DomEl>,
  animatable: Set<string>, errors: string[], warnings: string[], budget?: ValidationBudget,
): boolean {
  if (action === "wait") {
    const delay = finiteNumber(raw);
    if (delay === null || delay < 0) {
      budget?.diagnostic();
      errors.push(`page animation step ${stepNumber} wait must be a non-negative number`);
    }
    return false;
  }
  if (DRAWIO_ONLY_ACTIONS.has(action) || !PORTABLE_ACTIONS.has(action)) {
    budget?.diagnostic();
    warnings.push(`page animation step ${stepNumber} action '${action}' is not supported in standalone animated SVG`);
    return false;
  }
  if (!isObject(raw)) {
    budget?.diagnostic();
    errors.push(`page animation step ${stepNumber} action '${action}' must be an object`);
    return true;
  }
  validateSelectors(raw, stepNumber, action, cells, animatable, errors, warnings, budget);
  validateActionParameters(action, raw, stepNumber, errors, budget);
  return true;
}

export function analyzeAnimationPage(diagram: DomEl, budget?: ValidationBudget): PageAnimationAnalysis {
  const pageName = attr(diagram, "name") ?? "?";
  const errors: string[] = [];
  const warnings: string[] = [];
  const observations: string[] = [];
  if (diagram.tagName !== "mxGraphModel") budget?.work(diagram.childNodes.length);
  const model = pageModel(diagram);
  if (!model) {
    budget?.diagnostic();
    budget?.work(diagram.childNodes.length);
    const kind = directText(diagram).trim() ? "compressed" : "missing";
    errors.push(`${kind} page model cannot be inspected for animation`);
    return {
      pageName,
      flowEdgeIds: [],
      sequence: null,
      cells: new Map(),
      animatableCellIds: [],
      errors,
      warnings,
      observations,
    };
  }

  budget?.work(model.childNodes.length);
  const root = firstByTag(model, "root");
  const cells = collectCells(root, budget);
  const { byId, animatable } = collectCellData(cells, budget);
  const flowEdgeIds: string[] = [];
  validateFlowAnimations(cells, errors, flowEdgeIds, budget);
  const sequence = parseSequence(animationAttribute(root, budget), errors, warnings, budget);
  if (sequence) validateSequence(sequence, byId, animatable, errors, warnings, budget);

  if (flowEdgeIds.length > 0) {
    budget?.diagnostic();
    budget?.work(flowEdgeIds.length);
    const connectorIds = flowEdgeIds.map((id) => "'" + id + "'").join(", ");
    observations.push(
      `${flowEdgeIds.length} connector(s) use persistent flow animation; SVG preserves it, static formats do not: ${connectorIds}`,
    );
  }
  if (sequence) {
    budget?.diagnostic();
    observations.push(
      sequence.enabled
        ? `page animation contains ${sequence.steps.length} step(s); standalone animated SVG supports visibility, opacity, fade, and wait actions`
        : `page animation contains ${sequence.steps.length} step(s) but autoplay is disabled`,
    );
  }

  budget?.work(animatable.size);
  return {
    pageName,
    flowEdgeIds,
    sequence,
    cells: byId,
    animatableCellIds: [...animatable],
    errors,
    warnings,
    observations,
  };
}

export function analyzeDrawioAnimation(xml: string, pageIndex = 1): PageAnimationAnalysis {
  if (!Number.isInteger(pageIndex) || pageIndex < 1) throw new Error("pageIndex must be a positive 1-based integer");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement as unknown as DomEl | null;
  if (!root) throw new Error("no root element (malformed XML)");
  const pages = diagramPages(root);
  const page = pages[pageIndex - 1];
  if (!page) throw new Error(`pageIndex ${pageIndex} is out of range (diagram has ${pages.length} page(s))`);
  return analyzeAnimationPage(page);
}

function actionDuration(action: string, value: unknown): number {
  if (action === "wait") return finiteNumber(value) ?? 0;
  if (!action.startsWith("fade") || !isObject(value)) return 0;
  return finiteNumber(value.delay) ?? DEFAULT_FADE_DURATION_MS;
}

function baseOpacity(cell: DomEl): number {
  const raw = styleMap(attr(cell, "style")).get("opacity");
  const opacity = raw === undefined ? 1 : Number(raw) / 100;
  return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
}

function putPoint(points: OpacityPoint[], time: number, value: number): void {
  const existing = points.find((point) => Math.abs(point.time - time) < 1e-9);
  if (existing) existing.value = value;
  else points.push({ time, value });
}

function putInstant(points: OpacityPoint[], time: number, before: number, after: number): void {
  if (time > 0) putPoint(points, Math.max(0, time - INSTANT_EPSILON_MS), before);
  putPoint(points, time, after);
}

function selectedIds(params: JsonObject, analysis: PageAnimationAnalysis): string[] {
  const include = new Set<string>();
  for (const value of params.cells as string[]) {
    if (value === "*") for (const id of analysis.animatableCellIds) include.add(id);
    else include.add(value);
  }
  for (const value of (params.excludeCells as string[] | undefined) ?? []) {
    if (value === "*") include.clear();
    else include.delete(value);
  }
  return [...include];
}

function compileOpacityTimeline(analysis: PageAnimationAnalysis): CompiledTimeline | null {
  const sequence = analysis.sequence;
  if (!sequence?.enabled || sequence.steps.length === 0) return null;

  const bases = new Map<string, number>();
  const states = new Map<string, number>();
  const tracks = new Map<string, OpacityPoint[]>();
  for (const id of analysis.animatableCellIds) {
    const value = baseOpacity(analysis.cells.get(id)!);
    bases.set(id, value);
    states.set(id, value);
    tracks.set(id, [{ time: 0, value }]);
  }

  let time = 0;
  for (let index = 0; index < sequence.steps.length; ) {
    const batch: JsonObject[] = [sequence.steps[index++]];
    while (index < sequence.steps.length && sequence.steps[index].immediate === true) batch.push(sequence.steps[index++]);

    time += compileOpacityBatch(batch, analysis, states, tracks, time);
  }

  const durationMs = Math.max(1, time);
  const reducedMotionRules: string[] = [];
  const rules: string[] = [];
  const targetCellIds: string[] = [];
  let animatedCount = 0;
  for (const [id, points] of tracks) {
    const value = points[0].value;
    const base = bases.get(id)!;
    const changes = points.some((point) => point.value !== value);
    if (!changes && value === base) continue;
    const selector = `g[data-cell-id=${cssString(id)}]`;
    targetCellIds.push(id);
    reducedMotionRules.push(`  ${selector} { animation: none !important; opacity: ${base} !important; }`);
    if (!changes) {
      // A time-zero action can replace the base state without creating an animated track.
      rules.push(`${selector} { opacity: ${value} !important; }`);
      continue;
    }
    putPoint(points, durationMs, states.get(id) ?? 1);
    points.sort((a, b) => a.time - b.time);
    const name = `drawme-opacity-${++animatedCount}`;
    const keyframes = points
      .map((point) => `  ${((point.time / durationMs) * 100).toFixed(9)}% { opacity: ${point.value}; }`)
      .join("\n");
    rules.push(
      `@keyframes ${name} {\n${keyframes}\n}`,
      `${selector} { animation: ${name} ${durationMs}ms ease-in-out 0ms ${sequence.loop ? "infinite" : "1"} normal forwards; }`,
    );
  }
  if (animatedCount === 0) throw new Error("page animation has no visible opacity change to compile");
  rules.push(
    `@media (prefers-reduced-motion: reduce) {\n${reducedMotionRules.join("\n")}\n  g[data-cell-id] * { animation: none !important; }\n}`,
  );
  return { css: rules.join("\n"), durationMs, targetCellIds };
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
  tracks: Map<string, OpacityPoint[]>, time: number,
): number {
  const current = states.get(id) ?? 1;
  const points = tracks.get(id)!;
  const [from, target] = opacityEndpoints(action, params, current);
  const duration = actionDuration(action, params);
  if (duration > 0) {
    if (Math.abs(current - from) > 1e-9) putInstant(points, time, current, from);
    else putPoint(points, time, from);
    putPoint(points, time + duration, target);
  } else {
    putInstant(points, time, current, target);
  }
  return target;
}

function compileOpacityBatch(
  batch: JsonObject[], analysis: PageAnimationAnalysis, states: Map<string, number>,
  tracks: Map<string, OpacityPoint[]>, time: number,
): number {
  let duration = 0;
  const touched = new Set<string>();
  const updates = new Map<string, number>();
  for (const [action, raw] of batch.flatMap((step) => Object.entries(step))) {
    if (action === "immediate") continue;
    duration = Math.max(duration, actionDuration(action, raw));
    if (action === "wait") continue;
    const params = raw as JsonObject;
    for (const id of selectedIds(params, analysis)) {
      if (touched.has(id)) {
        throw new Error(`parallel animation actions target cell '${id}' more than once in the same batch`);
      }
      touched.add(id);
      updates.set(id, compileOpacityAction(action, params, id, states, tracks, time));
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
  const analysis = analyzeDrawioAnimation(source, pageIndex);
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

  const elements = walkElements(svgRoot);
  verifyStandaloneImages(elements);
  const groupElements = new Map(
    elements
      .map((element) => [attr(element, "data-cell-id"), element] as const)
      .filter((entry): entry is readonly [string, DomEl] => entry[0] !== null),
  );
  verifyFlowGroups(analysis.flowEdgeIds, groupElements);

  const timeline = compileOpacityTimeline(analysis);
  verifyTimelineGroups(timeline, groupElements);

  const flowReducedMotion = analysis.flowEdgeIds.length > 0
    ? `@media (prefers-reduced-motion: reduce) {\n${analysis.flowEdgeIds
        .map((id) => `  g[data-cell-id=${cssString(id)}] * { animation: none !important; }`)
        .join("\n")}\n}`
    : "";
  const injectedCss = [timeline?.css, flowReducedMotion].filter(Boolean).join("\n");
  if (injectedCss) {
    const documentNode = doc;
    let defs = elements.find((element) => element.tagName === "defs");
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
    await writeFile(output, new XMLSerializer().serializeToString(doc), "utf8");
  }

  return {
    page: analysis.pageName,
    connectorFlows: analysis.flowEdgeIds.length,
    sequenceSteps: activeSequence ? analysis.sequence!.steps.length : 0,
    sequenceDurationMs: timeline?.durationMs ?? 0,
    sequenceCompiled: timeline !== null,
    verified: analysis.flowEdgeIds.length > 0 || timeline !== null,
  };
}
