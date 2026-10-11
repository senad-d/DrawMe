/**
 * Animation analysis and standalone SVG enhancement. draw.io natively emits
 * persistent connector-flow CSS; DrawMe adds a portable opacity timeline for
 * page-level sequences and verifies that the requested motion survived export.
 */
import { readFile, writeFile } from "node:fs/promises";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { type DomEl, attr, childrenByTag, elemChildren, firstByTag } from "./dom";
import { collectCells } from "./geometry";

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
  animatedCellIds: string[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function styleMap(style: string | null): Map<string, string> {
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

/** Quote an arbitrary draw.io cell id as a CSS attribute-selector string. */
function cssString(value: string): string {
  let escaped = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === "\\") escaped += `\\${char}`;
    else if (code <= 0x1f || code === 0x7f) escaped += `\\${code.toString(16)} `;
    else escaped += char;
  }
  return `${escaped}"`;
}

function pageModel(diagram: DomEl): DomEl | null {
  return firstByTag(diagram, "mxGraphModel");
}

function animationAttribute(model: DomEl): string | null {
  const root = firstByTag(model, "root");
  if (!root) return null;
  for (const child of elemChildren(root)) {
    if (attr(child, "id") !== "0") continue;
    const direct = attr(child, "animation");
    if (direct !== null) return direct;
    const inner = firstByTag(child, "mxCell");
    const nested = inner ? attr(inner, "animation") : null;
    if (nested !== null) return nested;
  }
  return null;
}

function parseSequence(raw: string | null, errors: string[], warnings: string[]): NativeAnimationSequence | null {
  if (raw === null || raw.trim() === "") return null;
  if (!raw.trimStart().startsWith("{")) {
    warnings.push("legacy text page animations cannot be compiled to standalone animated SVG; save the animation as JSON");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    errors.push(`page animation contains malformed JSON: ${(error as Error).message}`);
    return null;
  }

  if (!isObject(parsed)) {
    errors.push("page animation JSON must be an object");
    return null;
  }
  const value = isObject(parsed.animation) ? parsed.animation : parsed;
  if (!Array.isArray(value.steps)) {
    errors.push("page animation JSON must contain a steps array");
    return null;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    errors.push("page animation enabled must be a boolean");
  }
  if (value.loop !== undefined && typeof value.loop !== "boolean") {
    errors.push("page animation loop must be a boolean");
  }

  const steps: JsonObject[] = [];
  for (let index = 0; index < value.steps.length; index++) {
    const step = value.steps[index];
    if (!isObject(step)) errors.push(`page animation step ${index + 1} must be an object`);
    else steps.push(step);
  }
  return {
    enabled: value.enabled === undefined ? true : value.enabled === true,
    loop: value.loop === undefined ? true : value.loop === true,
    steps,
  };
}

function collectCellData(cells: DomEl[]): { byId: Map<string, DomEl>; animatable: string[] } {
  const byId = new Map<string, DomEl>();
  const animatable: string[] = [];
  for (const cell of cells) {
    const id = attr(cell, "id");
    if (id === null) continue;
    byId.set(id, cell);
    if (cell.getAttribute("vertex") === "1" || cell.getAttribute("edge") === "1") animatable.push(id);
  }
  return { byId, animatable };
}

function validateFlowAnimations(cells: DomEl[], errors: string[], flowEdgeIds: string[]): void {
  for (const cell of cells) {
    const style = styleMap(attr(cell, "style"));
    const flow = style.get("flowAnimation");
    const id = attr(cell, "id") ?? "?";
    if (flow !== undefined && flow !== "0" && flow !== "1") {
      errors.push(`cell '${id}' has invalid flowAnimation '${flow}' (expected 0 or 1)`);
      continue;
    }
    if (flow !== "1") continue;
    if (cell.getAttribute("edge") !== "1") {
      errors.push(`cell '${id}' uses flowAnimation=1 but is not an edge`);
      continue;
    }
    flowEdgeIds.push(id);

    const duration = style.get("flowAnimationDuration");
    if (duration !== undefined && (!(Number(duration) > 0) || !Number.isFinite(Number(duration)))) {
      errors.push(`edge '${id}' has invalid flowAnimationDuration '${duration}' (expected a positive millisecond value)`);
    }
    const direction = style.get("flowAnimationDirection");
    if (direction !== undefined && !FLOW_DIRECTIONS.has(direction)) {
      errors.push(`edge '${id}' has invalid flowAnimationDirection '${direction}'`);
    }
    const timing = style.get("flowAnimationTimingFunction");
    if (timing !== undefined && !FLOW_TIMINGS.has(timing)) {
      errors.push(`edge '${id}' has invalid flowAnimationTimingFunction '${timing}'`);
    }
  }
}

function selectorIds(
  params: JsonObject,
  stepNumber: number,
  action: string,
  cells: Map<string, DomEl>,
  animatable: string[],
  errors: string[],
  warnings: string[],
): string[] {
  if (params.layers !== undefined || params.tags !== undefined) {
    warnings.push(
      `page animation step ${stepNumber} action '${action}' uses layer/tag selectors, which standalone animated SVG does not support`,
    );
  }
  if (!Array.isArray(params.cells)) {
    errors.push(`page animation step ${stepNumber} action '${action}' must provide a cells array`);
    return [];
  }

  const requested = new Set<string>();
  const animatableIds = new Set(animatable);
  for (const cellId of params.cells) {
    if (typeof cellId !== "string") {
      errors.push(`page animation step ${stepNumber} action '${action}' has a non-string cell id`);
      continue;
    }
    if (cellId === "*") {
      for (const id of animatable) requested.add(id);
    } else if (!cells.has(cellId)) {
      errors.push(`page animation step ${stepNumber} action '${action}' references missing cell '${cellId}'`);
    } else if (!animatableIds.has(cellId)) {
      errors.push(`page animation step ${stepNumber} action '${action}' references non-animatable cell '${cellId}'`);
    } else {
      requested.add(cellId);
    }
  }

  if (params.excludeCells !== undefined) {
    if (!Array.isArray(params.excludeCells) || params.excludeCells.some((id) => typeof id !== "string")) {
      errors.push(`page animation step ${stepNumber} action '${action}' has an invalid excludeCells array`);
    } else {
      for (const id of params.excludeCells as string[]) {
        if (id === "*") requested.clear();
        else requested.delete(id);
      }
    }
  }
  return [...requested];
}

function validateActionParameters(action: string, params: JsonObject, stepNumber: number, errors: string[]): void {
  if (action === "opacity" || action === "fadeTo") {
    const value = finiteNumber(params.value);
    if (value === null || value < 0 || value > 1) {
      errors.push(`page animation step ${stepNumber} action '${action}' needs value between 0 and 1`);
    }
  }
  if (action.startsWith("fade") && params.delay !== undefined) {
    const delay = finiteNumber(params.delay);
    if (delay === null || delay < 0) {
      errors.push(`page animation step ${stepNumber} action '${action}' has an invalid delay`);
    }
  }
}

function validateSequence(
  sequence: NativeAnimationSequence,
  cells: Map<string, DomEl>,
  animatable: string[],
  errors: string[],
  warnings: string[],
): void {
  if (sequence.enabled && sequence.steps.length === 0) errors.push("enabled page animation must contain at least one step");
  let hasPortableVisualAction = false;
  for (let index = 0; index < sequence.steps.length; index++) {
    const step = sequence.steps[index];
    const stepNumber = index + 1;
    if (step.immediate !== undefined && typeof step.immediate !== "boolean") {
      errors.push(`page animation step ${stepNumber} immediate must be a boolean`);
    }

    const actions = Object.keys(step).filter((key) => key !== "immediate");
    if (actions.length === 0) errors.push(`page animation step ${stepNumber} has no action`);
    for (const action of actions) {
      if (action === "wait") {
        const delay = finiteNumber(step[action]);
        if (delay === null || delay < 0) errors.push(`page animation step ${stepNumber} wait must be a non-negative number`);
        continue;
      }
      if (DRAWIO_ONLY_ACTIONS.has(action) || !PORTABLE_ACTIONS.has(action)) {
        warnings.push(
          `page animation step ${stepNumber} action '${action}' is not supported in standalone animated SVG`,
        );
        continue;
      }
      hasPortableVisualAction = true;
      const params = step[action];
      if (!isObject(params)) {
        errors.push(`page animation step ${stepNumber} action '${action}' must be an object`);
        continue;
      }
      selectorIds(params, stepNumber, action, cells, animatable, errors, warnings);
      validateActionParameters(action, params, stepNumber, errors);
    }
  }
  if (sequence.enabled && sequence.steps.length > 0 && !hasPortableVisualAction) {
    errors.push("enabled page animation must contain at least one portable visual action");
  }
}

export function analyzeAnimationPage(diagram: DomEl): PageAnimationAnalysis {
  const pageName = attr(diagram, "name") ?? "?";
  const errors: string[] = [];
  const warnings: string[] = [];
  const observations: string[] = [];
  const model = pageModel(diagram);
  if (!model) {
    errors.push("compressed or missing page model cannot be inspected for animation");
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

  const cells = collectCells(firstByTag(model, "root"));
  const { byId, animatable } = collectCellData(cells);
  const flowEdgeIds: string[] = [];
  validateFlowAnimations(cells, errors, flowEdgeIds);
  const sequence = parseSequence(animationAttribute(model), errors, warnings);
  if (sequence) validateSequence(sequence, byId, animatable, errors, warnings);

  if (flowEdgeIds.length > 0) {
    observations.push(
      `${flowEdgeIds.length} connector(s) use persistent flow animation; SVG preserves it, static formats do not: ${flowEdgeIds.map((id) => `'${id}'`).join(", ")}`,
    );
  }
  if (sequence) {
    observations.push(
      sequence.enabled
        ? `page animation contains ${sequence.steps.length} step(s); standalone animated SVG supports visibility, opacity, fade, and wait actions`
        : `page animation contains ${sequence.steps.length} step(s) but autoplay is disabled`,
    );
  }

  return {
    pageName,
    flowEdgeIds,
    sequence,
    cells: byId,
    animatableCellIds: animatable,
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
  const pageList = childrenByTag(root, "diagram");
  const pages = pageList.length > 0 ? pageList : [root];
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
  if (!sequence || !sequence.enabled || sequence.steps.length === 0) return null;

  const states = new Map<string, number>();
  const tracks = new Map<string, OpacityPoint[]>();
  for (const id of analysis.animatableCellIds) {
    const value = baseOpacity(analysis.cells.get(id)!);
    states.set(id, value);
    tracks.set(id, [{ time: 0, value }]);
  }

  let time = 0;
  for (let index = 0; index < sequence.steps.length; ) {
    const batch: JsonObject[] = [sequence.steps[index++]];
    while (index < sequence.steps.length && sequence.steps[index].immediate === true) batch.push(sequence.steps[index++]);

    let batchDuration = 0;
    const touched = new Set<string>();
    const updates = new Map<string, number>();
    for (const step of batch) {
      for (const [action, raw] of Object.entries(step)) {
        if (action === "immediate") continue;
        batchDuration = Math.max(batchDuration, actionDuration(action, raw));
        if (action === "wait") continue;
        const params = raw as JsonObject;
        const ids = selectedIds(params, analysis);
        for (const id of ids) {
          if (touched.has(id)) {
            throw new Error(`parallel animation actions target cell '${id}' more than once in the same batch`);
          }
          touched.add(id);
          const current = states.get(id) ?? 1;
          const points = tracks.get(id)!;
          let from = current;
          let target = current;
          if (action === "opacity") target = params.value as number;
          else if (action === "show") target = 1;
          else if (action === "hide") target = 0;
          else if (action === "toggle") target = current > 0 ? 0 : 1;
          else if (action === "fadeIn") {
            from = 0;
            target = 1;
          } else if (action === "fadeOut") {
            from = 1;
            target = 0;
          } else if (action === "fadeTo") target = params.value as number;

          const duration = actionDuration(action, raw);
          if (duration > 0) {
            if (Math.abs(current - from) > 1e-9) putInstant(points, time, current, from);
            else putPoint(points, time, from);
            putPoint(points, time + duration, target);
          } else {
            putInstant(points, time, current, target);
          }
          updates.set(id, target);
        }
      }
    }
    for (const [id, value] of updates) states.set(id, value);
    time += batchDuration;
  }

  const durationMs = Math.max(1, time);
  const animated = [...tracks.entries()].filter(([, points]) => {
    const values = new Set(points.map((point) => point.value));
    return values.size > 1;
  });
  if (animated.length === 0) throw new Error("page animation has no visible opacity change to compile");

  const reducedMotionRules: string[] = [];
  const rules: string[] = [];
  for (let index = 0; index < animated.length; index++) {
    const [id, points] = animated[index];
    putPoint(points, durationMs, states.get(id) ?? 1);
    points.sort((a, b) => a.time - b.time);
    const name = `drawme-opacity-${index + 1}`;
    const selector = `g[data-cell-id=${cssString(id)}]`;
    reducedMotionRules.push(
      `  ${selector} { animation: none !important; opacity: ${baseOpacity(analysis.cells.get(id)!)} !important; }`,
    );
    const keyframes = points
      .map((point) => `  ${((point.time / durationMs) * 100).toFixed(9)}% { opacity: ${point.value}; }`)
      .join("\n");
    rules.push(`@keyframes ${name} {\n${keyframes}\n}`);
    rules.push(
      `${selector} { animation: ${name} ${durationMs}ms ease-in-out 0ms ${sequence.loop ? "infinite" : "1"} normal forwards; }`,
    );
  }
  rules.push(
    `@media (prefers-reduced-motion: reduce) {\n${reducedMotionRules.join("\n")}\n  g[data-cell-id] * { animation: none !important; }\n}`,
  );
  return { css: rules.join("\n"), durationMs, animatedCellIds: animated.map(([id]) => id) };
}

function walkElements(root: DomEl): DomEl[] {
  const elements: DomEl[] = [root];
  for (const child of elemChildren(root)) elements.push(...walkElements(child));
  return elements;
}

function hasAnimatedPath(root: DomEl): boolean {
  return walkElements(root).some((element) => {
    if (element.tagName !== "path") return false;
    const style = attr(element, "style") ?? "";
    return /(?:^|;)\s*animation\s*:/.test(style);
  });
}

export async function enhanceAnimatedSvg(
  input: string,
  output: string,
  pageIndex = 1,
): Promise<AnimatedSvgSummary> {
  const source = await readFile(input, "utf8");
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
  if (!svgRoot || svgRoot.tagName !== "svg") throw new Error("draw.io output is not valid SVG");

  const groupElements = new Map(
    walkElements(svgRoot)
      .map((element) => [attr(element, "data-cell-id"), element] as const)
      .filter((entry): entry is readonly [string, DomEl] => entry[0] !== null),
  );
  const missingFlowGroups = analysis.flowEdgeIds.filter((id) => !groupElements.has(id));
  if (missingFlowGroups.length > 0) {
    throw new Error(`SVG is missing animated connector group(s): ${missingFlowGroups.join(", ")}`);
  }
  const staticFlowGroups = analysis.flowEdgeIds.filter((id) => !hasAnimatedPath(groupElements.get(id)!));
  if (staticFlowGroups.length > 0) {
    throw new Error(`draw.io did not preserve flow animation for connector(s): ${staticFlowGroups.join(", ")}`);
  }

  const timeline = compileOpacityTimeline(analysis);
  if (timeline) {
    const missing = timeline.animatedCellIds.filter((id) => !groupElements.has(id));
    if (missing.length > 0) {
      throw new Error(
        `SVG is missing page-animation cell group(s): ${missing.join(", ")}; do not use visible=0 for cells revealed by an animation`,
      );
    }
  }

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
    style.setAttribute("data-drawme-animation", timeline ? "opacity-timeline" : "reduced-motion");
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
