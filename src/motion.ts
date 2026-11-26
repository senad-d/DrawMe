/**
 * DrawMe motion: a typed animation spec stored on a page's root cell and
 * compiled into standalone SVG CSS keyframes plus SMIL connector dots. It covers
 * effects draw.io's native page sequence cannot export portably: connector
 * draw-in, pop and slide entrances, glow highlights, staggered cascades, and
 * dots travelling along connectors. The same timeline yields storyboard frames
 * so the motion can be reviewed as static images.
 */
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { animationGraphRoot, baseOpacity, createAnimationBudget, reportAnimationFinding, verifyFlowGroups } from "./animation";
import { diagramPages, pageModel, type ValidationBudget } from "./diagram-files";
import { type DomEl, attr, elemChildren } from "./dom";
import { collectCellsWithIds } from "./geometry";
import { assertStandaloneImages, cssString, walkElements } from "./svg-helpers";

/** Attribute on the page root cell (`id="0"`) that stores the motion spec as JSON. */
export const MOTION_ATTRIBUTE = "drawmeMotion";

export const MOTION_EFFECTS = [
  "fadeIn",
  "fadeOut",
  "dim",
  "popIn",
  "slideIn",
  "drawIn",
  "highlight",
  "travel",
  "wait",
] as const;
export type MotionEffect = (typeof MOTION_EFFECTS)[number];

export const SLIDE_DIRECTIONS = ["up", "down", "left", "right"] as const;
export type SlideDirection = (typeof SLIDE_DIRECTIONS)[number];

export interface MotionStep {
  effect: MotionEffect;
  /** Vertex or edge ids. Not used by `wait`. */
  cells?: string[];
  /** Effect duration in ms; required for `wait`. */
  duration?: number;
  /** Extra start offset in ms between consecutive cells of this step (cascade). */
  stagger?: number;
  /** Start together with the previous step instead of after it. */
  parallel?: boolean;
  /** `slideIn` travel direction (default `up`). */
  direction?: SlideDirection;
  /** Hex color for `highlight` glow and `travel` dots. */
  color?: string;
  /** Target opacity for `dim` (default 0.25). */
  value?: number;
}

export interface MotionSpec {
  /** Repeat the sequence (default true). */
  loop?: boolean;
  /** Pause in ms on the final state before a loop restarts (default 1600). */
  hold?: number;
  steps: MotionStep[];
}

const DEFAULT_DURATION: Record<Exclude<MotionEffect, "wait">, number> = {
  fadeIn: 600,
  fadeOut: 500,
  dim: 500,
  popIn: 550,
  slideIn: 650,
  drawIn: 900,
  highlight: 1000,
  travel: 1400,
};
const ENTRANCES = new Set<MotionEffect>(["fadeIn", "popIn", "slideIn", "drawIn"]);
const EDGE_ONLY = new Set<MotionEffect>(["drawIn", "travel"]);
export const DEFAULT_HOLD_MS = 1600;
export const DEFAULT_ACCENT = "#2563eb";
/** Accent for highlight and travel on a dark page (the Dark preset's accent). */
export const DEFAULT_DARK_ACCENT = "#60a5fa";
const DEFAULT_DIM = 0.25;
const SLIDE_DISTANCE = 32;
const MAX_STEPS = 200;
const MAX_DURATION_MS = 60_000;
const MAX_TOTAL_MS = 300_000;
const EPSILON_MS = 0.05;
const COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const EASE = {
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  in: "cubic-bezier(0.55, 0, 1, 0.45)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  back: "cubic-bezier(0.34, 1.56, 0.64, 1)",
};
const IDENTITY = transformValue(0, 0, 1);
const NO_GLOW = "drop-shadow(0px 0px 0px rgba(0, 0, 0, 0))";
const SVG_NS = "http://www.w3.org/2000/svg";

type XmlDocument = ReturnType<DOMParser["parseFromString"]>;

type JsonObject = Record<string, unknown>;
type Value = number | string;

interface KeyPoint {
  t: number;
  v: Value;
  ease?: string;
}

/** Facts about the page's cells that motion validation needs. */
export interface MotionCell {
  kind: "vertex" | "edge";
  style: string;
  parent: string | null;
  /** Authored visibility, including any intermediary layer that cannot be animated. */
  hidden?: boolean;
  /** Nearest ancestor with a motion track, skipping static layers. */
  animationParent?: string;
}

export interface MotionDot {
  cellId: string;
  start: number;
  duration: number;
  color: string;
}

/** End state of one sequential batch, for storyboard rendering. */
export interface MotionFrame {
  time: number;
  label: string;
  /** Opacity of every cell the timeline touches (untouched cells are fully visible). */
  opacity: Map<string, number>;
  /** Cells emphasized during this batch (highlight or travel) and their accent color. */
  accent: Map<string, string>;
}

export interface CompiledMotion {
  loop: boolean;
  /** Length of the step sequence, without the loop hold. */
  sequenceMs: number;
  /** Length of one animation iteration (sequence plus hold when looping). */
  durationMs: number;
  css: string;
  dots: MotionDot[];
  /** Cells whose SVG group must exist. */
  targetCellIds: string[];
  /** Edges whose line path is drawn in. */
  drawInEdgeIds: string[];
  frames: MotionFrame[];
}

export interface MotionAnalysis {
  spec: MotionSpec | null;
  compiled: CompiledMotion | null;
  errors: string[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function styleValue(style: string, key: string, budget?: ValidationBudget): string | undefined {
  budget?.work(Math.ceil(style.length / 64));
  for (const item of style.split(";")) {
    const separator = item.indexOf("=");
    if (separator > 0 && item.slice(0, separator).trim() === key) return item.slice(separator + 1).trim();
  }
  return undefined;
}

function transformValue(dx: number, dy: number, scale: number): string {
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

function groupSelector(id: string): string {
  return `g[data-cell-id=${cssString(id)}]`;
}

type Layer = { hidden: boolean; parent: string | null };

function staticLayers(
  start: string | null, all: Map<string, DomEl>, animatable: Map<string, MotionCell>, cache: Map<string, Layer>,
  budget?: ValidationBudget,
): Layer {
  const path = new Map<string, boolean>();
  let id = start;
  let layer: Layer = { hidden: false, parent: null };
  while (id !== null) {
    budget?.work();
    if (animatable.has(id)) { layer = { hidden: false, parent: id }; break; }
    const known = cache.get(id);
    if (known) { layer = known; break; }
    const node = all.get(id);
    if (!node || path.has(id)) break; // Structural cycles are reported by drawio_validate.
    path.set(id, attr(node, "visible") === "0" || baseOpacity(attr(node, "style"), budget) === 0);
    id = attr(node, "parent");
  }
  for (const [id, hidden] of [...path].reverse()) {
    if (hidden && !layer.hidden) layer = { ...layer, hidden };
    cache.set(id, layer);
  }
  return layer;
}

/** Cells of one page model, keyed by id (wrapper ids resolved, DOM untouched). */
export function motionCells(model: DomEl, budget = createAnimationBudget()): Map<string, MotionCell> {
  const root = animationGraphRoot(model, budget);
  const { ids } = collectCellsWithIds(root, budget.work);
  const result = new Map<string, MotionCell>();
  for (const [id, cell] of ids) {
    budget.work();
    const kind = attr(cell, "vertex") === "1" ? "vertex" : attr(cell, "edge") === "1" ? "edge" : null;
    if (kind) result.set(id, { kind, style: attr(cell, "style") ?? "", parent: attr(cell, "parent") });
  }
  const cache = new Map<string, Layer>();
  for (const [id, cell] of result) {
    budget.work();
    const layer = staticLayers(cell.parent, ids, result, cache, budget);
    if (layer.hidden || attr(ids.get(id)!, "visible") === "0") cell.hidden = true;
    if (layer.parent !== null && layer.parent !== cell.parent) cell.animationParent = layer.parent;
  }
  return result;
}

type MotionError = (message: string) => void;

function reportErrors(errors: string[], budget: ValidationBudget): MotionError {
  return (message) => reportAnimationFinding(budget, "error", errors, message);
}

/** Shape-check raw JSON (from a tool call or the stored attribute) into a spec. */
export function parseMotionSpec(raw: unknown, errors: string[], budget = createAnimationBudget()): MotionSpec | null {
  const error = reportErrors(errors, budget);
  const value = isObject(raw) && isObject(raw.motion) ? raw.motion : raw;
  if (!isObject(value)) {
    error("motion spec must be an object with a steps array");
    return null;
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    error("motion spec must contain a non-empty steps array");
    return null;
  }
  if (value.steps.length > MAX_STEPS) {
    error(`motion spec has ${value.steps.length} steps (maximum ${MAX_STEPS})`);
    return null;
  }
  if (value.loop !== undefined && typeof value.loop !== "boolean") error("motion loop must be a boolean");
  const hold = value.hold === undefined ? null : finite(value.hold);
  if (value.hold !== undefined && (hold === null || hold < 0 || hold > MAX_DURATION_MS)) {
    error(`motion hold must be between 0 and ${MAX_DURATION_MS} ms`);
  }

  const steps: MotionStep[] = [];
  value.steps.forEach((raw: unknown, index: number) => {
    budget.work();
    const n = index + 1;
    if (!isObject(raw)) {
      error(`motion step ${n} must be an object`);
      return;
    }
    const effect = raw.effect;
    if (typeof effect !== "string" || !(MOTION_EFFECTS as readonly string[]).includes(effect)) {
      const name = effect === null || typeof effect !== "object" ? String(effect) : typeof effect;
      error(`motion step ${n} has unknown effect '${name}' (expected ${MOTION_EFFECTS.join(", ")})`);
      return;
    }
    const step: MotionStep = { effect: effect as MotionEffect };
    parseStepTiming(raw, step, n, error, budget);
    if (raw.direction !== undefined) {
      if (typeof raw.direction !== "string" || !(SLIDE_DIRECTIONS as readonly string[]).includes(raw.direction)) {
        error(`motion step ${n} direction must be one of ${SLIDE_DIRECTIONS.join(", ")}`);
      } else {
        step.direction = raw.direction as SlideDirection;
      }
    }
    if (raw.color !== undefined) {
      if (typeof raw.color !== "string" || !COLOR.test(raw.color)) {
        error(`motion step ${n} color must be a hex color such as #2563eb`);
      } else {
        step.color = raw.color;
      }
    }
    steps.push(step);
  });
  return {
    ...(value.loop === undefined ? {} : { loop: value.loop === true }),
    ...(hold === null ? {} : { hold }),
    steps,
  };
}

function parseStepTiming(
  raw: Record<string, unknown>, step: MotionStep, n: number, error: MotionError, budget?: ValidationBudget,
): void {
  if (raw.cells !== undefined) {
    if (Array.isArray(raw.cells)) budget?.work(raw.cells.length);
    if (!Array.isArray(raw.cells) || raw.cells.some((id) => typeof id !== "string")) {
      error(`motion step ${n} cells must be an array of cell ids`);
    } else {
      step.cells = raw.cells as string[];
    }
  }
  for (const key of ["duration", "stagger", "value"] as const) {
    if (raw[key] === undefined) continue;
    const number = finite(raw[key]);
    if (number === null) error(`motion step ${n} ${key} must be a number`);
    else step[key] = number;
  }
  if (raw.parallel !== undefined) {
    if (typeof raw.parallel !== "boolean") error(`motion step ${n} parallel must be a boolean`);
    else step.parallel = raw.parallel;
  }
}

class Track {
  readonly points: KeyPoint[];
  current: Value;

  constructor(initial: Value, private readonly budget?: ValidationBudget) {
    this.points = [{ t: 0, v: initial }];
    this.current = initial;
  }

  private put(t: number, v: Value, ease?: string): void {
    this.budget?.work(this.points.length);
    const existing = this.points.find((point) => Math.abs(point.t - t) < 1e-9);
    if (existing) {
      existing.v = v;
      if (ease) existing.ease = ease;
    } else {
      this.points.push({ t, v, ...(ease ? { ease } : {}) });
    }
  }

  jump(t: number, v: Value): void {
    if (v === this.current) return;
    if (t > 0) this.put(Math.max(0, t - EPSILON_MS), this.current);
    this.put(t, v);
    this.current = v;
  }

  tween(t0: number, t1: number, from: Value, to: Value, ease: string): void {
    this.jump(t0, from);
    this.put(t0, from, ease);
    this.put(t1, to);
    this.current = to;
  }

  finish(t: number): void {
    this.put(t, this.current);
    this.budget?.work(this.points.length * Math.ceil(Math.log2(this.points.length + 1)));
    this.points.sort((a, b) => a.t - b.t);
  }

  get animated(): boolean {
    this.budget?.work(this.points.length);
    return this.points.some((point) => point.v !== this.points[0].v);
  }
}

interface CellTracks {
  opacity: Track;
  transform?: Track;
  filter?: Track;
  line?: Track;
  decor?: Track;
}

interface ResolvedStep {
  number: number;
  effect: MotionEffect;
  cells: string[];
  duration: number;
  stagger: number;
  parallel: boolean;
  direction: SlideDirection;
  color: string;
  value: number;
}

function resolveSteps(
  spec: MotionSpec,
  cells: Map<string, MotionCell>,
  error: MotionError,
  accent: string,
  budget?: ValidationBudget,
): ResolvedStep[] {
  const resolved: ResolvedStep[] = [];
  spec.steps.forEach((step, index) => {
    budget?.work();
    const number = index + 1;
    const where = `motion step ${number} (${step.effect})`;
    const duration = step.duration ?? (step.effect === "wait" ? null : DEFAULT_DURATION[step.effect]);
    if (duration === null) error(`${where} needs a duration in ms`);
    else if (!Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION_MS || (step.effect !== "wait" && duration === 0)) {
      error(`${where} duration must be between ${step.effect === "wait" ? 0 : 1} and ${MAX_DURATION_MS} ms`);
    }
    const stagger = step.stagger ?? 0;
    if (!Number.isFinite(stagger) || stagger < 0 || stagger > MAX_DURATION_MS) error(`${where} stagger must be between 0 and ${MAX_DURATION_MS} ms`);
    if (step.parallel && index === 0) error(`${where} cannot be parallel: there is no previous step`);
    const ids = step.cells ?? [];
    validateStepOptions(step, ids, where, error, budget);
    validateStepCells(step, ids, cells, where, error, budget);
    resolved.push({
      number,
      effect: step.effect,
      cells: ids,
      duration: duration ?? 0,
      stagger,
      parallel: step.parallel === true,
      direction: step.direction ?? "up",
      color: step.color ?? accent,
      value: step.value ?? DEFAULT_DIM,
    });
  });
  return resolved;
}

function validateStepOptions(step: MotionStep, ids: string[], where: string, error: MotionError, budget?: ValidationBudget): void {
  if (step.value !== undefined && (step.effect !== "dim" || !Number.isFinite(step.value) || step.value < 0 || step.value > 1)) {
    error(`${where} value is only valid for dim and must be between 0 and 1`);
  }
  if (step.direction !== undefined && step.effect !== "slideIn") error(`${where} direction is only valid for slideIn`);
  if (step.color !== undefined && step.effect !== "highlight" && step.effect !== "travel") {
    error(`${where} color is only valid for highlight and travel`);
  }
  if (step.effect === "wait") {
    if (ids.length > 0) error(`${where} must not list cells`);
  } else if (ids.length === 0) {
    error(`${where} must list at least one cell id`);
  }
  budget?.work(ids.length);
  if (new Set(ids).size !== ids.length) error(`${where} lists a cell more than once`);
}

function validateStepCells(
  step: MotionStep, ids: string[], cells: Map<string, MotionCell>, where: string, error: MotionError, budget?: ValidationBudget,
): void {
  for (const id of ids) {
    budget?.work();
    const cell = cells.get(id);
    if (!cell) {
      error(`${where} references missing cell '${id}'`);
      continue;
    }
    if (EDGE_ONLY.has(step.effect) && cell.kind !== "edge") error(`${where} needs a connector, but '${id}' is a shape`);
    if (step.effect !== "drawIn" || cell.kind !== "edge") continue;
    if (styleValue(cell.style, "dashed", budget) === "1") {
      error(`${where} cannot draw dashed connector '${id}'; use fadeIn or make it solid`);
    }
    if (styleValue(cell.style, "flowAnimation", budget) === "1") {
      error(`${where} cannot draw connector '${id}' because it uses flowAnimation=1; use fadeIn`);
    }
  }
}

function batches(steps: ResolvedStep[], budget?: ValidationBudget): ResolvedStep[][] {
  const result: ResolvedStep[][] = [];
  for (const step of steps) {
    budget?.work();
    if (step.parallel && result.length > 0) result.at(-1)!.push(step);
    else result.push([step]);
  }
  return result;
}

function slideOffset(direction: SlideDirection): [number, number] {
  if (direction === "up") return [0, SLIDE_DISTANCE];
  if (direction === "down") return [0, -SLIDE_DISTANCE];
  if (direction === "left") return [SLIDE_DISTANCE, 0];
  return [-SLIDE_DISTANCE, 0];
}

function frameLabel(batch: ResolvedStep[]): string {
  return batch
    .filter((step) => step.effect !== "wait")
    .map((step) => {
      const shown = step.cells.slice(0, 3).join(", ");
      const more = step.cells.length > 3 ? ` +${step.cells.length - 3}` : "";
      return `${step.effect} ${shown}${more}`;
    })
    .join(" · ");
}

function pct(t: number, total: number): string {
  return `${((t / total) * 100).toFixed(6)}%`;
}

function keyframes(name: string, property: string, track: Track, total: number): string {
  const lines = track.points.map((point) => {
    const ease = point.ease ? ` animation-timing-function: ${point.ease};` : "";
    return `  ${pct(point.t, total)} { ${property}: ${point.v};${ease} }`;
  });
  return `@keyframes ${name} {\n${lines.join("\n")}\n}`;
}

type Target = { step: ResolvedStep & { effect: Exclude<MotionEffect, "wait"> }; start: number; end: number; before: number; after: number };

function planBatch(
  batch: ResolvedStep[], time: number, tracks: Map<string, CellTracks>, error: MotionError, budget?: ValidationBudget,
): Map<string, Target> {
  const touched = new Set<string>();
  const targets = new Map<string, Target>();
  for (const step of batch) {
    const effect = step.effect;
    if (effect === "wait") continue;
    const visualStep = { ...step, effect };
    const where = `motion step ${step.number} (${effect})`;
    step.cells.forEach((id, order) => {
      budget?.work();
      if (touched.has(id)) {
        error(`${where} targets '${id}' again in the same parallel group`);
        return;
      }
      touched.add(id);
      const before = tracks.get(id)!.opacity.current as number;
      const entrance = ENTRANCES.has(effect);
      if (entrance && (effect === "fadeIn" ? before >= 1 : before > 0)) {
        error(`${where} targets '${id}', which is already visible; fade it out first or use highlight`);
        return;
      }
      const start = time + step.stagger * order;
      const end = start + step.duration * (effect === "drawIn" ? 0 : effect === "popIn" ? 0.6 : 1);
      const after = entrance ? 1 : effect === "fadeOut" ? 0 : effect === "dim" ? step.value : before;
      targets.set(id, { step: visualStep, start, end, before, after });
    });
  }
  return targets;
}

/** Walk self and moving ancestors; static intermediary layers were folded into the visibility facts. */
function everyAncestor(
  start: string, cells: Map<string, MotionCell>, check: (id: string, cell: MotionCell) => boolean, budget?: ValidationBudget,
): boolean {
  const seen = new Set<string>();
  let id: string | null = start;
  while (id !== null && !seen.has(id)) {
    budget?.work();
    const cell = cells.get(id);
    if (!cell) break;
    if (!check(id, cell)) return false;
    seen.add(id);
    id = cell.animationParent ?? cell.parent;
  }
  return true;
}

function shownAt(target: Target, time: number): boolean {
  if (time >= target.end) return target.after > 0;
  if (time <= target.start) return target.before > 0;
  return target.before > 0 || target.after > 0;
}

/** Intersect the times when every ancestor is visible with the time of the actual change. */
function hasVisibleChange(
  id: string, target: Target, cells: Map<string, MotionCell>, targets: Map<string, Target>, opacity: (id: string) => number,
  budget?: ValidationBudget,
): boolean {
  if (target.before === target.after) return false;
  let start = target.start;
  let end = target.step.effect === "drawIn" ? start + target.step.duration : target.end;
  return everyAncestor(id, cells, (parent, cell) => {
    if (cell.hidden) return false;
    const change = targets.get(parent);
    if (!change) return opacity(parent) > 0;
    if (change.before <= 0) {
      if (change.after <= 0) return false;
      start = Math.max(start, change.start);
    } else if (change.after <= 0) end = Math.min(end, change.end);
    return start < end;
  }, budget);
}

function applyTarget(
  id: string, target: Target, cell: CellTracks, kind: MotionCell["kind"],
  dots: MotionDot[], drawInEdges: Set<string>, accent: Map<string, string>, budget?: ValidationBudget,
): void {
  const { step, start: s, end, before, after } = target;
  const d = step.duration;
  switch (step.effect) {
    case "fadeIn":
      cell.opacity.tween(s, end, before, after, EASE.out);
      break;
    case "fadeOut":
      cell.opacity.tween(s, end, before, after, EASE.in);
      break;
    case "dim":
      cell.opacity.tween(s, end, before, after, EASE.inOut);
      break;
    case "popIn":
      cell.transform ??= new Track(IDENTITY, budget);
      cell.opacity.tween(s, end, before, after, EASE.out);
      cell.transform.tween(s, s + d, transformValue(0, 0, 0.6), IDENTITY, EASE.back);
      break;
    case "slideIn": {
      const [dx, dy] = slideOffset(step.direction);
      cell.transform ??= new Track(IDENTITY, budget);
      cell.opacity.tween(s, end, before, after, EASE.out);
      cell.transform.tween(s, s + d, transformValue(dx, dy, 1), IDENTITY, EASE.out);
      break;
    }
    case "drawIn":
      cell.line ??= new Track(1, budget);
      cell.decor ??= new Track(0, budget);
      drawInEdges.add(id);
      cell.opacity.jump(s, after);
      cell.line.tween(s, s + d * 0.8, 1, 0, EASE.inOut);
      cell.decor.tween(s + d * 0.7, s + d, 0, 1, EASE.out);
      break;
    case "highlight": {
      const glow = `drop-shadow(0px 0px 12px ${step.color})`;
      cell.filter ??= new Track(NO_GLOW, budget);
      cell.filter.tween(s, s + d * 0.4, NO_GLOW, glow, EASE.out);
      cell.filter.tween(s + d * 0.4, s + d, glow, NO_GLOW, EASE.inOut);
      if (kind === "vertex") {
        cell.transform ??= new Track(IDENTITY, budget);
        cell.transform.tween(s, s + d * 0.4, IDENTITY, transformValue(0, 0, 1.04), EASE.out);
        cell.transform.tween(s + d * 0.4, s + d, transformValue(0, 0, 1.04), IDENTITY, EASE.inOut);
      }
      accent.set(id, step.color);
      break;
    }
    case "travel":
      dots.push({ cellId: id, start: s, duration: d, color: step.color });
      accent.set(id, step.color);
      break;
  }
}

/** Validate a spec against the page and compile it to CSS, SMIL dots, and storyboard frames. */
export function compileMotion(
  spec: MotionSpec,
  cells: Map<string, MotionCell>,
  accent: string = DEFAULT_ACCENT,
  budget = createAnimationBudget(),
): MotionAnalysis {
  const errors: string[] = [];
  const error = reportErrors(errors, budget);
  if (spec.steps.length > MAX_STEPS) {
    error(`motion spec has ${spec.steps.length} steps (maximum ${MAX_STEPS})`);
    return { spec, compiled: null, errors };
  }
  if (spec.hold !== undefined && (!Number.isFinite(spec.hold) || spec.hold < 0 || spec.hold > MAX_DURATION_MS)) {
    error(`motion hold must be between 0 and ${MAX_DURATION_MS} ms`);
  }
  const steps = resolveSteps(spec, cells, error, accent, budget);
  if (errors.length > 0) return { spec, compiled: null, errors };

  const authored = new Map<string, number>();
  const initialOpacity = (id: string) => {
    let value = authored.get(id);
    if (value === undefined) {
      value = baseOpacity(cells.get(id)?.style ?? null, budget);
      authored.set(id, value);
    }
    return value;
  };
  const tracks = new Map<string, CellTracks>();
  for (const step of steps) {
    for (const id of step.cells) {
      budget.work();
      if (!tracks.has(id)) {
        // A cell whose first effect is an entrance starts hidden; otherwise keep its authored opacity.
        tracks.set(id, { opacity: new Track(ENTRANCES.has(step.effect) ? 0 : initialOpacity(id), budget) });
      }
    }
  }
  const opacity = (id: string) => (tracks.get(id)?.opacity.current as number | undefined) ?? initialOpacity(id);
  const dots: MotionDot[] = [];
  const frames: MotionFrame[] = [];
  const drawInEdges = new Set<string>();
  let time = 0;
  let hasMotion = false;
  for (const batch of batches(steps, budget)) {
    budget.work(batch.length);
    const span = batch.reduce((span, step) => Math.max(span,
      step.duration + step.stagger * Math.max(0, step.cells.length - 1)), 0);
    if (time + span > MAX_TOTAL_MS) {
      error(`motion sequence lasts ${Math.round(time + span)} ms (maximum ${MAX_TOTAL_MS} ms)`);
      break;
    }
    // Plan all concurrent opacity changes before testing visibility or applying any track.
    const targets = planBatch(batch, time, tracks, error, budget);
    const accent = new Map<string, string>();
    for (const [id, target] of targets) {
      const { step, start } = target;
      const where = `motion step ${step.number} (${step.effect})`;
      const emphasis = step.effect === "highlight" || step.effect === "travel";
      const reachable = everyAncestor(id, cells, (parent, cell) => {
        if (cell.hidden) return false;
        if (!emphasis) return true;
        const change = targets.get(parent);
        return change ? shownAt(change, start) : opacity(parent) > 0;
      }, budget);
      if (!reachable) {
        error(emphasis
          ? `${where} targets '${id}', which is hidden at that point; reveal it first`
          : `${where} targets '${id}', which is authored hidden; remove visible=0 or unhide its layer before animating`);
        continue;
      }
      const kind = cells.get(id)!.kind;
      const visibleEmphasis = step.effect === "travel" || (step.effect === "highlight" &&
        (kind === "vertex" || !/^#(?:[\da-f]{3}0|[\da-f]{6}00)$/i.test(step.color)));
      hasMotion ||= visibleEmphasis || hasVisibleChange(id, target, cells, targets, opacity, budget);
      applyTarget(id, target, tracks.get(id)!, kind, dots, drawInEdges, accent, budget);
    }
    time += span;
    if (targets.size > 0) {
      budget.work(tracks.size);
      const opacity = new Map<string, number>();
      for (const [id, cell] of tracks) opacity.set(id, cell.opacity.current as number);
      frames.push({ time, label: frameLabel(batch), opacity, accent });
    }
  }
  if (errors.length === 0 && !hasMotion) error("motion sequence has no effective visual motion; add a visible transition or emphasis");
  if (errors.length > 0) return { spec, compiled: null, errors };

  const loop = spec.loop ?? true;
  const sequenceMs = Math.max(1, time);
  const durationMs = loop ? sequenceMs + (spec.hold ?? DEFAULT_HOLD_MS) : sequenceMs;
  const css = compileTrackCss(tracks, durationMs, loop, initialOpacity, budget);
  return {
    spec,
    errors,
    compiled: {
      loop,
      sequenceMs,
      durationMs,
      css,
      dots,
      targetCellIds: [...tracks.keys()],
      drawInEdgeIds: [...drawInEdges],
      frames,
    },
  };
}

function compileTrackCss(
  tracks: Map<string, CellTracks>, durationMs: number, loop: boolean, authored: (id: string) => number, budget?: ValidationBudget,
): string {
  const iteration = loop ? "infinite" : "1";
  const rules: string[] = [];
  const reduced: string[] = [];
  let counter = 0;
  const animate = (selector: string, entries: [string, Track][], extra = ""): void => {
    const live = entries.filter(([, track]) => track.animated);
    if (live.length === 0) return;
    const names: string[] = [];
    const finals: string[] = [];
    for (const [property, track] of live) {
      track.finish(durationMs);
      const name = `drawme-motion-${++counter}`;
      rules.push(keyframes(name, property, track, durationMs));
      names.push(`${name} ${durationMs}ms linear 0ms ${iteration} normal both`);
      finals.push(`${property}: ${track.current} !important;`);
    }
    rules.push(`${selector} { animation: ${names.join(", ")};${extra} }`);
    reduced.push(`  ${selector} { animation: none !important; ${finals.join(" ")} }`);
  };
  for (const [id, cell] of tracks) {
    budget?.work(1 + Math.ceil(id.length / 64));
    const group = groupSelector(id);
    const groupTracks: [string, Track][] = [["opacity", cell.opacity]];
    if (!cell.opacity.animated && cell.opacity.current !== authored(id)) {
      rules.push(`${group} { opacity: ${cell.opacity.current} !important; }`);
    }
    if (cell.transform) groupTracks.push(["transform", cell.transform]);
    if (cell.filter) groupTracks.push(["filter", cell.filter]);
    animate(group, groupTracks, cell.transform ? " transform-box: fill-box; transform-origin: center;" : "");
    if (cell.line) animate(`${group} [data-drawme-line]`, [["stroke-dashoffset", cell.line]], " stroke-dasharray: 1 1;");
    if (cell.decor) animate(`${group} [data-drawme-decor]`, [["opacity", cell.decor]]);
  }
  reduced.push("  [data-drawme-dot] { display: none !important; }");
  rules.push(`@media (prefers-reduced-motion: reduce) {\n${reduced.join("\n")}\n}`);

  return rules.join("\n");
}

// --- Storage on the page root cell ---

function rootCellElement(model: DomEl, budget?: ValidationBudget): DomEl | null {
  const root = animationGraphRoot(model, budget);
  if (!root) return null;
  budget?.work(root.childNodes.length);
  return elemChildren(root).find((child) => attr(child, "id") === "0") ?? null;
}

/** The stored motion JSON of a page, or null. */
export function readStoredMotion(model: DomEl, budget?: ValidationBudget): string | null {
  const cell = rootCellElement(model, budget);
  return cell ? attr(cell, MOTION_ATTRIBUTE) : null;
}

/**
 * Store motion JSON on the page root cell, wrapping a plain `<mxCell id="0"/>`
 * in a `UserObject` (draw.io's form for a root cell with custom properties).
 */
export function storeMotion(model: DomEl, json: string): void {
  const cell = rootCellElement(model);
  if (!cell) throw new Error("page has no root cell id=\"0\"");
  if (cell.tagName === "UserObject" || cell.tagName === "object") {
    cell.setAttribute(MOTION_ATTRIBUTE, json);
    return;
  }
  const node = cell as unknown as {
    ownerDocument: { createElement(tag: string): DomEl };
    parentNode: { replaceChild(next: unknown, old: unknown): void };
    attributes: { length: number; [i: number]: { name: string; value: string } };
  };
  const doc = node.ownerDocument;
  const wrapper = doc.createElement("UserObject");
  wrapper.setAttribute("label", "");
  wrapper.setAttribute(MOTION_ATTRIBUTE, json);
  wrapper.setAttribute("id", "0");
  const inner = doc.createElement("mxCell");
  for (const { name, value } of Array.from(node.attributes)) {
    if (name !== "id") inner.setAttribute(name, value);
  }
  (wrapper as unknown as { appendChild(child: unknown): void }).appendChild(inner);
  node.parentNode.replaceChild(wrapper, cell);
}

/** True when a page background color is dark (a Dark theme page). */
export function isDarkBackground(color: string | null): boolean {
  const match = /^#([0-9a-fA-F]{6})$/.exec(color ?? "");
  if (!match) return false;
  const value = Number.parseInt(match[1], 16);
  const channel = (shift: number): number => ((value >> shift) & 0xff) / 255;
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0) < 0.4;
}

/** Pick a 1-based page from a parsed `.drawio` document. */
export function selectPage(root: DomEl, pageIndex = 1): { diagram: DomEl; model: DomEl; name: string } {
  if (!Number.isInteger(pageIndex) || pageIndex < 1) throw new Error("pageIndex must be a positive 1-based integer");
  const pages = diagramPages(root);
  const diagram = pages[pageIndex - 1];
  if (!diagram) throw new Error(`pageIndex ${pageIndex} is out of range (diagram has ${pages.length} page(s))`);
  const model = pageModel(diagram);
  if (!model) throw new Error("compressed or missing page model cannot be animated; save the diagram uncompressed");
  return { diagram, model, name: attr(diagram, "name") ?? "?" };
}

/** Parse and compile the motion stored on a page; null when none is stored. */
export function analyzeStoredMotion(model: DomEl, budget = createAnimationBudget()): MotionAnalysis | null {
  const raw = readStoredMotion(model, budget);
  budget.work(Math.ceil((raw?.length ?? 0) / 64));
  if (raw === null || raw.trim() === "") return null;
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    reportErrors(errors, budget)(`stored motion contains malformed JSON: ${(error as Error).message}`);
    return { spec: null, compiled: null, errors };
  }
  const spec = parseMotionSpec(parsed, errors, budget);
  if (!spec || errors.length > 0) return { spec, compiled: null, errors };
  return compileMotion(spec, motionCells(model, budget), themeAccent(model), budget);
}

/** Default motion accent for a page: the Dark preset accent on a dark background, else the Light one. */
export function themeAccent(model: DomEl): string {
  return isDarkBackground(attr(model, "background")) ? DEFAULT_DARK_ACCENT : DEFAULT_ACCENT;
}

// --- SVG injection ---

function linePath(group: DomEl): DomEl | null {
  return walkElements(group).find((element) => element.tagName === "path" && attr(element, "fill") === "none") ?? null;
}

type Parented = DomEl & { parentNode: Parented | null };

/** Mark everything in an edge group except the line path (arrowheads, label) as decoration. */
function markDecor(group: DomEl, line: DomEl): void {
  let current = line as Parented;
  while (current !== (group as Parented) && current.parentNode) {
    const parent = current.parentNode;
    for (const sibling of elemChildren(parent)) {
      if (sibling !== current) sibling.setAttribute("data-drawme-decor", "1"); // NOSONAR: xmldom XML elements have no browser dataset API.
    }
    current = parent;
  }
}

function keyTimes(times: number[], total: number): string {
  return times.map((t) => Math.min(1, Math.max(0, t / total)).toFixed(9)).join(";");
}

function appendDot(doc: XmlDocument, group: DomEl, path: string, dot: MotionDot, motion: CompiledMotion): void {
  const total = motion.durationMs;
  const { start, duration } = dot;
  const end = start + duration;
  const fade = Math.min(150, duration * 0.15);
  const repeat = motion.loop ? "indefinite" : "1";
  const circle = doc.createElementNS(SVG_NS, "circle");
  circle.setAttribute("r", "5");
  circle.setAttribute("fill", dot.color);
  circle.setAttribute("stroke", "#ffffff");
  circle.setAttribute("stroke-width", "1.5");
  circle.setAttribute("opacity", "0");
  circle.setAttribute("data-drawme-dot", "1"); // NOSONAR: xmldom XML elements have no browser dataset API.
  const travel = doc.createElementNS(SVG_NS, "animateMotion");
  travel.setAttribute("path", path);
  travel.setAttribute("dur", `${total}ms`);
  travel.setAttribute("repeatCount", repeat);
  travel.setAttribute("fill", "freeze");
  travel.setAttribute("calcMode", "linear");
  travel.setAttribute("keyPoints", "0;0;1;1");
  travel.setAttribute("keyTimes", keyTimes([0, start, end, total], total));
  const opacity = doc.createElementNS(SVG_NS, "animate");
  opacity.setAttribute("attributeName", "opacity");
  opacity.setAttribute("dur", `${total}ms`);
  opacity.setAttribute("repeatCount", repeat);
  opacity.setAttribute("fill", "freeze");
  opacity.setAttribute("calcMode", "linear");
  opacity.setAttribute("values", "0;0;1;1;0;0");
  opacity.setAttribute("keyTimes", keyTimes([0, start, start + fade, end - fade, end, total], total));
  circle.appendChild(travel);
  circle.appendChild(opacity);
  (group as unknown as { appendChild(node: unknown): void }).appendChild(circle);
}

function motionSvgGroups(root: DomEl): Map<string, DomEl> {
  const groups = new Map<string, DomEl>();
  for (const element of walkElements(root)) {
    const id = attr(element, "data-cell-id");
    if (id !== null && !groups.has(id)) groups.set(id, element);
  }
  return groups;
}

/**
 * Inject compiled motion into a draw.io SVG string. Throws when targeted
 * cells or connector lines are missing, or the renderer did not preserve
 * a declared connector flow.
 */
export function injectMotion(svg: string, motion: CompiledMotion, flowEdgeIds: string[] = []): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgRoot = doc.documentElement as unknown as DomEl | null;
  if (svgRoot?.tagName !== "svg") throw new Error("draw.io output is not valid SVG");
  const groups = motionSvgGroups(svgRoot);
  const missing = motion.targetCellIds.filter((id) => !groups.has(id));
  if (missing.length > 0) {
    throw new Error(`SVG is missing animated cell group(s): ${missing.join(", ")}; do not use visible=0 on animated cells`);
  }
  verifyFlowGroups(flowEdgeIds, groups);

  for (const id of motion.drawInEdgeIds) {
    const group = groups.get(id)!;
    const line = linePath(group);
    if (!line) throw new Error(`connector '${id}' has no line path in the SVG to draw in`);
    line.setAttribute("pathLength", "1");
    line.setAttribute("data-drawme-line", "1"); // NOSONAR: xmldom XML elements have no browser dataset API.
    markDecor(group, line);
  }
  for (const dot of motion.dots) {
    const group = groups.get(dot.cellId)!;
    const line = linePath(group);
    const d = line ? attr(line, "d") : null;
    if (!d) throw new Error(`connector '${dot.cellId}' has no line path in the SVG for a travelling dot`);
    appendDot(doc, group, d, dot, motion);
  }

  const flowReduced = flowEdgeIds.length > 0
    ? `\n@media (prefers-reduced-motion: reduce) {\n${flowEdgeIds
        .map((id) => `  ${groupSelector(id)} * { animation: none !important; }`)
        .join("\n")}\n}`
    : "";
  let defs = walkElements(svgRoot).find((element) => element.tagName === "defs");
  if (!defs) {
    defs = doc.createElementNS(SVG_NS, "defs") as unknown as DomEl;
    const rootNode = svgRoot as unknown as { firstChild: unknown; insertBefore(node: unknown, before: unknown): void };
    rootNode.insertBefore(defs, rootNode.firstChild);
  }
  const style = doc.createElementNS(SVG_NS, "style");
  style.setAttribute("type", "text/css");
  style.setAttribute("data-drawme-animation", "motion"); // NOSONAR: xmldom XML elements have no browser dataset API.
  style.appendChild(doc.createTextNode(motion.css + flowReduced));
  (defs as unknown as { appendChild(node: unknown): void }).appendChild(style);
  const finished = new XMLSerializer().serializeToString(doc);
  assertStandaloneImages(finished);
  return finished;
}
