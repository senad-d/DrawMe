/**
 * Deterministic structural linter for `.drawio` files. It rejects broken cell
 * contracts and reports conservative geometry/readability findings that can be
 * checked without rendering. Typography and automatically routed connectors
 * still require visual review.
 */
import { DOMParser, ParseError } from "@xmldom/xmldom";
import { type DomEl, attr, childrenByTag, directText, firstByTag } from "./dom";
import { analyzeAnimationPage, animationGraphRoot } from "./animation";
import {
  type ValidationBudget,
  type ValidationLimits,
  DEFAULT_VALIDATION_LIMITS,
  ValidationStop,
  createValidationBudget,
  diagramPages,
  pageModel,
  readDiagramXml,
} from "./diagram-files";
import { analyzeStoredMotion } from "./motion";
import {
  type ById,
  type ChargeWork,
  type ContentBounds,
  type Point,
  type Rect,
  absRect,
  collectCells,
  contentBounds,
  edgeLabelAnchor,
  edgeRoute,
  edgeWaypoints,
  endpoint,
  geometryIsRelative,
  hasInvalidNumber,
  isEdgeLabel,
  isVisible,
  pyFloat,
  rect,
  styleNum,
} from "./geometry";

const RESERVED = new Set(["0", "1"]);
export const MIN_OUTER_MARGIN = 20;
const EXCESSIVE_CANVAS_AREA_RATIO = 4;
const EXCESSIVE_CANVAS_AXIS_RATIO = 0.6;

export interface ValidateResult {
  errors: string[];
  warnings: string[];
  /** Informational limitations/settings that do not require a source correction. */
  observations: string[];
  /** A resource limit stopped validation; the admitted findings are not exhaustive. */
  incomplete?: boolean;
  /** Readability score (lower is better); comparable only across variants of the same graph. */
  score: { total: number; through: number; crossings: number; overlaps: number; anchors: number };
}

const SCORE_WEIGHTS = { through: 20, crossings: 10, overlaps: 5, anchors: 8 } as const;
const MAX_RENDERED_FINDING_LENGTH = 512;

function excerpt(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/** Quote and bound an optional attribute before incorporating it into a diagnostic. */
function repr(s: string | null): string {
  return s === null ? "None" : `'${excerpt(s, 96)}'`;
}

function overlap(a: Rect, b: Rect): boolean {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

function styleHas(style: string | null, key: string, expected: string, work: ChargeWork): boolean {
  work(Math.ceil((style?.length ?? 0) / 64));
  return (style ?? "").split(";").includes(`${key}=${expected}`);
}

function orient(a: Point, b: Point, c: Point): number {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : -1;
}

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  return o1 !== o2 && o3 !== o4 && ![o1, o2, o3, o4].includes(0);
}

function pointInRect(point: Point, box: Rect, epsilon = 1e-6): boolean {
  const [x, y, w, h] = box;
  return x + epsilon < point[0] && point[0] < x + w - epsilon && y + epsilon < point[1] && point[1] < y + h - epsilon;
}

function routeHitsRect(points: Point[], box: Rect, work: ChargeWork, skipSegment = -1): boolean {
  const [x, y, w, h] = box;
  const corners: Point[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const borders: [Point, Point][] = corners.map((corner, index) => [corner, corners[(index + 1) % 4]]);
  for (let i = 0; i < points.length - 1; i++) {
    work();
    if (i === skipSegment) continue;
    const start = points[i];
    const end = points[i + 1];
    if (pointInRect(start, box) || pointInRect(end, box)) return true;
    for (const [a, b] of borders) if (segmentsCross(start, end, a, b)) return true;
  }
  return false;
}

function routesCross(a: Point[], b: Point[], work: ChargeWork): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      work();
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

type RoutedEdge = [string | null, Point[], Set<string | null>];
type LeafBox = [string | null, Rect];

/** Edges with a resolvable waypointed route, tagged with their id and endpoint ids. */
function collectRoutedEdges(cells: DomEl[], ids: ById, work: ChargeWork): RoutedEdge[] {
  const routed: RoutedEdge[] = [];
  for (const cell of cells) {
    work();
    if (cell.getAttribute("edge") === "1" && isVisible(cell, ids, work)) {
      const points = edgeRoute(cell, ids, work);
      if (points) routed.push([attr(cell, "id"), points, new Set([attr(cell, "source"), attr(cell, "target")])]);
    }
  }
  return routed;
}

/** Absolute boxes of leaf vertices (real nodes, not containers or edge labels). */
function collectLeafBoxes(cells: DomEl[], ids: ById, parents: Set<string | null>, work: ChargeWork): LeafBox[] {
  const leaves: LeafBox[] = [];
  for (const cell of cells) {
    work();
    if (!parents.has(attr(cell, "id")) && isContainmentCandidate(cell, ids, work)) {
      const box = absRect(cell, ids, work);
      if (box) leaves.push([attr(cell, "id"), box]);
    }
  }
  return leaves;
}

function checkRouteThrough(routed: RoutedEdge[], leaves: LeafBox[], { work, finding }: ValidationBudget): void {
  for (const [edgeId, points, ends] of routed) {
    for (const [vertexId, box] of leaves) {
      work();
      if (!ends.has(vertexId) && routeHitsRect(points, box, work)) {
        finding("warning", `edge ${repr(edgeId)} routes through vertex ${repr(vertexId)}`, "through");
      }
    }
  }
}

function checkRouteCrossings(routed: RoutedEdge[], { work, finding }: ValidationBudget): void {
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      work();
      if (routesCross(routed[i][1], routed[j][1], work)) {
        finding("warning", `edges ${repr(routed[i][0])} and ${repr(routed[j][0])} cross`, "crossings");
      }
    }
  }
}

type Side = "top" | "bottom" | "left" | "right";

/** Side containing a pinned connection point, or null for an interior, corner, or unpinned point. */
function pinnedSide(style: string, end: "source" | "target", work: ChargeWork): Side | null {
  const x = styleNum(style, end === "source" ? "exitX" : "entryX", work);
  const y = styleNum(style, end === "source" ? "exitY" : "entryY", work);
  if (x === undefined && y === undefined) return null;
  const xBorder = x === 0 || x === 1;
  const yBorder = y === 0 || y === 1;
  if (xBorder && !yBorder) return x === 0 ? "left" : "right";
  if (yBorder && !xBorder) return y === 0 ? "top" : "bottom";
  return null;
}

function directionDescription(dx: number, dy: number): string {
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "to the right" : "to the left";
  return dy > 0 ? "below" : "above";
}

function facingSide(dx: number, dy: number): Side {
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "bottom" : "top";
}

function sideStyleHint(side: Side, end: "source" | "target"): string {
  const prefix = end === "source" ? "exit" : "entry";
  switch (side) {
    case "top":
      return `${prefix}X=0.5;${prefix}Y=0`;
    case "bottom":
      return `${prefix}X=0.5;${prefix}Y=1`;
    case "left":
      return `${prefix}X=0;${prefix}Y=0.5`;
    case "right":
      return `${prefix}X=1;${prefix}Y=0.5`;
  }
}

function sideFacesAway(side: Side, dx: number, dy: number, tolerance: number): boolean {
  return (
    (side === "top" && dy > tolerance) ||
    (side === "bottom" && dy < -tolerance) ||
    (side === "left" && dx > tolerance) ||
    (side === "right" && dx < -tolerance)
  );
}

interface AnchorDirection {
  end: "source" | "target";
  reference: Point;
  center: Point;
  subject: string;
}

function rectCenter(box: Rect): Point {
  return [box[0] + box[2] / 2, box[1] + box[3] / 2];
}

function anchorDirectionWarning(
  cell: DomEl,
  style: string,
  tolerance: number,
  direction: AnchorDirection,
  work: ChargeWork,
): string | null {
  const dx = direction.reference[0] - direction.center[0];
  const dy = direction.reference[1] - direction.center[1];
  const side = pinnedSide(style, direction.end, work);
  if (!side || !sideFacesAway(side, dx, dy, tolerance)) return null;
  const suggested = facingSide(dx, dy);
  const endLabel = direction.end === "source" ? "source exit" : "target entry";
  return `edge ${repr(attr(cell, "id"))}: ${endLabel} pinned to ${side} but ${direction.subject} is ${directionDescription(dx, dy)}; re-pin to ${suggested} (${sideStyleHint(suggested, direction.end)}) to shorten the route and reduce bends`;
}

/** Warn when a pinned border anchor faces away from its adjacent waypoint, or its peer when auto-routed. */
function checkAnchorFacing(cell: DomEl, ids: ById, { work, finding }: ValidationBudget): void {
  if (cell.getAttribute("edge") !== "1" || !isVisible(cell, ids, work)) return;
  const sourceId = attr(cell, "source");
  const targetId = attr(cell, "target");
  if (!sourceId || !targetId) return;
  const source = ids.get(sourceId);
  const target = ids.get(targetId);
  if (!source || !target || geometryIsRelative(source, work) || geometryIsRelative(target, work)) return;
  const sourceBox = absRect(source, ids, work);
  const targetBox = absRect(target, ids, work);
  if (!sourceBox || !targetBox) return;

  const sourceCenter = rectCenter(sourceBox);
  const targetCenter = rectCenter(targetBox);
  const route = edgeRoute(cell, ids, work);
  const directions: AnchorDirection[] = [
    {
      end: "source",
      reference: route?.[1] ?? targetCenter,
      center: sourceCenter,
      subject: route ? "first waypoint" : "target",
    },
    {
      end: "target",
      reference: route?.at(-2) ?? sourceCenter,
      center: targetCenter,
      subject: route ? "last waypoint" : "source",
    },
  ];
  const tolerance = Math.max(sourceBox[2], sourceBox[3], targetBox[2], targetBox[3]) * 0.15;
  const style = attr(cell, "style") ?? "";
  for (const direction of directions) {
    const warning = anchorDirectionWarning(cell, style, tolerance, direction, work);
    if (warning) finding("warning", warning, "anchors");
  }
}

/** A segment that enters and exits a rectangle rather than merely touching its boundary. */
function segmentPiercesRect(start: Point, end: Point, box: Rect): boolean {
  const [x, y, width, height] = box;
  const corners: Point[] = [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
  const borders: [Point, Point][] = corners.map((corner, index) => [corner, corners[(index + 1) % 4]]);
  let crossings = 0;
  for (const [a, b] of borders) if (segmentsCross(start, end, a, b)) crossings++;
  if (crossings >= 2) return true;
  return crossings === 1 && (pointInRect(start, box) || pointInRect(end, box));
}

function isDescendantOf(cell: DomEl, ancestorId: string, ids: ById, work: ChargeWork): boolean {
  const seen = new Set<string>();
  let parent = attr(cell, "parent");
  while (parent && ids.has(parent) && !seen.has(parent)) {
    work();
    if (parent === ancestorId) return true;
    seen.add(parent);
    parent = attr(ids.get(parent)!, "parent");
  }
  return false;
}

function isTextAnnotation(cell: DomEl, work: ChargeWork): boolean {
  const style = attr(cell, "style") ?? "";
  work(Math.ceil(style.length / 64));
  return style.split(";").some((token) => token.trim() === "text");
}

interface AutoRouteContext {
  edgeId: string | null;
  sourceId: string;
  targetId: string;
  sourcePoint: Point;
  targetPoint: Point;
}

function autoRouteContext(cell: DomEl, ids: ById, work: ChargeWork): AutoRouteContext | null {
  if (cell.getAttribute("edge") !== "1" || !isVisible(cell, ids, work) || edgeWaypoints(cell, work).length > 0) return null;
  const sourceId = attr(cell, "source");
  const targetId = attr(cell, "target");
  if (!sourceId || !targetId) return null;
  const source = ids.get(sourceId);
  const target = ids.get(targetId);
  if (!source || !target || geometryIsRelative(source, work) || geometryIsRelative(target, work)) return null;
  const sourcePoint = endpoint(cell, "source", ids, work);
  const targetPoint = endpoint(cell, "target", ids, work);
  if (!sourcePoint || !targetPoint) return null;
  return { edgeId: attr(cell, "id"), sourceId, targetId, sourcePoint, targetPoint };
}

function routeThroughObservation(context: AutoRouteContext, leaf: LeafBox, ids: ById, work: ChargeWork): string | null {
  const [vertexId, box] = leaf;
  if (vertexId === null || vertexId === context.sourceId || vertexId === context.targetId) return null;
  const vertex = ids.get(vertexId);
  if (!vertex || isTextAnnotation(vertex, work)) return null;
  if (isDescendantOf(vertex, context.sourceId, ids, work) || isDescendantOf(vertex, context.targetId, ids, work)) return null;
  if (!segmentPiercesRect(context.sourcePoint, context.targetPoint, box)) return null;
  return `edge ${repr(context.edgeId)} may pass over vertex ${repr(vertexId)} (predicted from the direct line; verify in the preview, then add waypoints or move the shape if needed)`;
}

/** The renderer may avoid these shapes, so predicted direct-line hits only need visual review. */
function checkPredictedRoutes(cells: DomEl[], ids: ById, leaves: LeafBox[], { work, finding }: ValidationBudget): void {
  for (const cell of cells) {
    work();
    const context = autoRouteContext(cell, ids, work);
    if (!context) continue;
    for (const leaf of leaves) {
      work();
      const observation = routeThroughObservation(context, leaf, ids, work);
      if (observation) finding("observation", observation);
    }
  }
}

/** Edges the route checks above cannot see. Keep the total count, but only a short list of IDs. */
function checkUnroutedEdges(cells: DomEl[], ids: ById, { work, finding }: ValidationBudget): void {
  const shown: string[] = [];
  let count = 0;
  for (const cell of cells) {
    work();
    if (cell.getAttribute("edge") === "1" && isVisible(cell, ids, work) && edgeRoute(cell, ids, work) === null) {
      count++;
      if (shown.length < 6) shown.push(excerpt(repr(attr(cell, "id")), 48));
    }
  }
  if (count === 0) return;
  const examples = shown.join(", ") + (count > shown.length ? ", …" : "");
  finding("warning",
    `${count} auto-routed edge(s) cannot be route-checked (no explicit waypoints): ${examples}; ` +
    "add waypoints and pinned anchors, or verify their routing visually",
  );
}

/** Map every cell by id (blank key for id-less cells); report duplicate ids as errors. */
function buildIds(cells: DomEl[], { work, finding }: ValidationBudget): ById {
  const ids: ById = new Map();
  for (const cell of cells) {
    work();
    const id = attr(cell, "id");
    if (id !== null && ids.has(id)) finding("error", `duplicate id ${repr(id)}`);
    ids.set(id ?? "", cell);
  }
  return ids;
}

/** Follow each parent chain once. Only a revisit within the current chain is a cycle. */
function checkParentCycles(ids: ById, { work, finding }: ValidationBudget): void {
  const done = new Set<string>();
  for (const id of ids.keys()) {
    work();
    if (done.has(id)) continue;
    const chain = new Map<string, number>();
    const path: string[] = [];
    let next: string | null = id;
    while (next !== null && ids.has(next) && !done.has(next)) {
      work();
      const seen = chain.get(next);
      if (seen !== undefined) {
        if (seen === path.length - 1) finding("error", `cell ${repr(next)} is its own parent`);
        else {
          const cycle = path.slice(seen, seen + 4).map(repr).join(" → ");
          const rest = path.length - seen > 4 ? " → …" : "";
          finding("error", `cell parent cycle: ${cycle}${rest} → ${repr(next)}`);
        }
        break;
      }
      chain.set(next, path.length);
      path.push(next);
      next = attr(ids.get(next)!, "parent");
    }
    for (const visited of path) {
      work();
      done.add(visited);
    }
  }
}

/** Geometry checks for a single non-edge-label, non-relative vertex. */
function checkVertexGeometry(cell: DomEl, id: string | null, { work, finding }: ValidationBudget): void {
  const box = rect(cell, work);
  if (box === null || hasInvalidNumber(box)) {
    finding("error", `vertex ${repr(id)} has missing/invalid geometry`);
    return;
  }
  const [x, y, width, height] = box;
  if (width <= 0 || height <= 0) finding("warning", `vertex ${repr(id)} non-positive size ${String(width)}x${String(height)}`);
  if (x < 0 || y < 0) finding("warning", `vertex ${repr(id)} negative position (${String(x)},${String(y)})`);
}

function checkEdgeGeometry(cell: DomEl, id: string | null, { work, finding }: ValidationBudget): void {
  work(cell.childNodes.length);
  const geometry = firstByTag(cell, "mxGeometry");
  if (!geometry) {
    finding("error", `edge ${repr(id)} has missing geometry`);
    return;
  }
  if (attr(geometry, "relative") !== "1" || attr(geometry, "as") !== "geometry") {
    finding("error", `edge ${repr(id)} geometry must have relative='1' and as='geometry'`);
  }
}

function checkCellReferences(cell: DomEl, id: string | null, ids: ById, { finding }: ValidationBudget): void {
  const parent = attr(cell, "parent");
  if (parent !== null && !ids.has(parent)) finding("error", `cell ${repr(id)} parent ${repr(parent)} does not exist`);
  for (const end of ["source", "target"] as const) {
    const reference = attr(cell, end);
    if (reference && !ids.has(reference)) finding("error", `edge ${repr(id)} ${end} ${repr(reference)} does not exist`);
  }
}

/** Per-cell reference and geometry checks. */
function checkCell(cell: DomEl, ids: ById, budget: ValidationBudget): void {
  const { work, finding } = budget;
  const id = attr(cell, "id");
  const isVertex = cell.getAttribute("vertex") === "1";
  const isEdge = cell.getAttribute("edge") === "1";
  checkCellReferences(cell, id, ids, budget);
  if ((isVertex || isEdge) && id !== null && RESERVED.has(id)) finding("error", `cell ${repr(id)} reuses reserved id 0/1`);
  if (isVertex && !isEdgeLabel(cell) && !geometryIsRelative(cell, work)) checkVertexGeometry(cell, id, budget);
  if (isEdge) checkEdgeGeometry(cell, id, budget);
}

/** Sibling overlap: visible leaf vertices only (containers legitimately wrap children). */
function checkOverlaps(cells: DomEl[], ids: ById, parents: Set<string | null>, { work, finding }: ValidationBudget): void {
  const boxes: [string | null, string | null, Rect][] = [];
  for (const cell of cells) {
    work();
    if (!parents.has(attr(cell, "id")) && isContainmentCandidate(cell, ids, work)) {
      const box = rect(cell, work);
      if (box && !hasInvalidNumber(box)) boxes.push([attr(cell, "id"), attr(cell, "parent"), box]);
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      work();
      const [aId, aParent, a] = boxes[i];
      const [bId, bParent, b] = boxes[j];
      if (aParent === bParent && overlap(a, b)) finding("warning", `vertices ${repr(aId)} and ${repr(bId)} overlap`, "overlaps");
    }
  }
}

function isContainmentCandidate(cell: DomEl, ids: ById, work: ChargeWork): boolean {
  return (
    cell.getAttribute("vertex") === "1" &&
    !geometryIsRelative(cell, work) &&
    !isEdgeLabel(cell) &&
    isVisible(cell, ids, work)
  );
}

function overflowSides(childBox: Rect, parentBox: Rect): string[] {
  const [x, y, width, height] = childBox;
  const [px, py, parentWidth, parentHeight] = parentBox;
  const sides: string[] = [];
  if (x < px) sides.push("left");
  if (y < py) sides.push("top");
  if (x + width > px + parentWidth) sides.push("right");
  if (y + height > py + parentHeight) sides.push("bottom");
  return sides;
}

function checkContainment(cell: DomEl, ids: ById, { work, finding }: ValidationBudget): void {
  if (!isContainmentCandidate(cell, ids, work)) return;
  const parentId = attr(cell, "parent");
  const parent = parentId ? ids.get(parentId) : undefined;
  if (parent?.getAttribute("vertex") !== "1" || !isVisible(parent, ids, work)) return;
  const childBox = absRect(cell, ids, work);
  const parentBox = absRect(parent, ids, work);
  if (!childBox || !parentBox) return;
  const sides = overflowSides(childBox, parentBox);
  if (sides.length > 0) {
    finding("warning", `vertex ${repr(attr(cell, "id"))} extends beyond parent ${repr(parentId)} (${sides.join(", ")})`);
  }
}

interface PageSettings {
  enabled: boolean;
  width?: number;
  height?: number;
  scale: number;
}

function pageSettings(model: DomEl, { finding }: ValidationBudget): PageSettings {
  const enabled = attr(model, "page") !== "0";
  if (!enabled) {
    finding("observation", "page canvas is disabled (infinite canvas); boundary, margin, and empty-space checks skipped");
    return { enabled, scale: 1 };
  }

  const rawScale = attr(model, "pageScale");
  const parsedScale = rawScale === null ? 1 : pyFloat(rawScale);
  const scale = parsedScale && Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1;
  if (rawScale !== null && scale !== parsedScale) finding("warning", `invalid pageScale ${repr(rawScale)}; using 1`);

  const parseDimension = (name: "pageWidth" | "pageHeight"): number | undefined => {
    const raw = attr(model, name);
    if (raw === null) return undefined;
    const value = pyFloat(raw);
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      finding("warning", `invalid ${name} ${repr(raw)}; page-boundary checks skipped`);
      return undefined;
    }
    return value * scale;
  };
  const width = parseDimension("pageWidth");
  const height = parseDimension("pageHeight");
  if (width === undefined || height === undefined) {
    finding("observation",
      "page dimensions are omitted or invalid; boundary, outer-margin, and empty-space checks require both pageWidth and pageHeight",
    );
  }
  return { enabled, width, height, scale };
}

function checkBoundaries(bounds: ContentBounds, width: number, height: number, { finding }: ValidationBudget): void {
  if (bounds.minX < 0) finding("warning", `content extends beyond left page boundary by ${-bounds.minX}px`);
  if (bounds.minY < 0) finding("warning", `content extends beyond top page boundary by ${-bounds.minY}px`);
  if (bounds.maxX > width) finding("warning", `content extends beyond right page boundary by ${bounds.maxX - width}px`);
  if (bounds.maxY > height) finding("warning", `content extends beyond bottom page boundary by ${bounds.maxY - height}px`);
}

function outerMarginWarning(bounds: ContentBounds, width: number, height: number): string | null {
  const marginSides: string[] = [];
  if (bounds.minX >= 0 && bounds.minX < MIN_OUTER_MARGIN) marginSides.push(`left ${bounds.minX}px`);
  if (bounds.minY >= 0 && bounds.minY < MIN_OUTER_MARGIN) marginSides.push(`top ${bounds.minY}px`);
  const right = width - bounds.maxX;
  const bottom = height - bounds.maxY;
  if (right >= 0 && right < MIN_OUTER_MARGIN) marginSides.push(`right ${right}px`);
  if (bottom >= 0 && bottom < MIN_OUTER_MARGIN) marginSides.push(`bottom ${bottom}px`);
  return marginSides.length > 0
    ? `content outer margin is below ${MIN_OUTER_MARGIN}px (${marginSides.join(", ")})`
    : null;
}

function excessiveCanvasWarning(bounds: ContentBounds, width: number, height: number): string | null {
  const contentWidth = bounds.maxX - bounds.minX;
  const contentHeight = bounds.maxY - bounds.minY;
  if (contentWidth <= 0 || contentHeight <= 0) return null;
  const areaRatio = (width * height) / (contentWidth * contentHeight);
  if (
    areaRatio < EXCESSIVE_CANVAS_AREA_RATIO ||
    contentWidth / width > EXCESSIVE_CANVAS_AXIS_RATIO ||
    contentHeight / height > EXCESSIVE_CANVAS_AXIS_RATIO
  ) {
    return null;
  }
  return `canvas has excessive empty space (content ${contentWidth}x${contentHeight}px within ${width}x${height}px page)`;
}

function checkCanvas(cells: DomEl[], ids: ById, settings: PageSettings, budget: ValidationBudget): void {
  const { width, height } = settings;
  if (!settings.enabled || width === undefined || height === undefined) return;
  const bounds = contentBounds(cells, ids, budget.work);
  if (!bounds) return;
  checkBoundaries(bounds, width, height, budget);
  const margin = outerMarginWarning(bounds, width, height);
  if (margin) budget.finding("warning", margin);
  const emptySpace = excessiveCanvasWarning(bounds, width, height);
  if (emptySpace) budget.finding("warning", emptySpace);
}

function isWhitespace(character: string): boolean {
  return character.trim() === "";
}

function isLineBreakTag(content: string): boolean {
  if (content.slice(0, 2).toLowerCase() !== "br") return false;
  let index = 2;
  while (index < content.length && isWhitespace(content[index])) index++;
  if (content[index] === "/") index++;
  while (index < content.length && isWhitespace(content[index])) index++;
  return index === content.length;
}

/** Remove draw.io's HTML-like label markup in one pass without regex backtracking. */
function stripLabelMarkup(value: string, work: ChargeWork): string {
  const text: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    work();
    const open = value.indexOf("<", cursor);
    if (open === -1) {
      text.push(value.slice(cursor));
      break;
    }
    text.push(value.slice(cursor, open));
    const close = value.indexOf(">", open + 1);
    if (close === -1) {
      text.push(value.slice(open));
      break;
    }
    if (close === open + 1) {
      text.push("<");
      cursor = open + 1;
      continue;
    }
    if (isLineBreakTag(value.slice(open + 1, close))) text.push("\n");
    cursor = close + 1;
  }
  return text.join("");
}

function labelText(cell: DomEl, work: ChargeWork): string {
  const value = attr(cell, "value") ?? "";
  work(Math.ceil(value.length / 64));
  return stripLabelMarkup(value, work).replaceAll("&nbsp;", " ").trim();
}

const DEFAULT_FONT_SIZE = 11;
const CHAR_WIDTH_FACTOR = 0.6;
const LINE_HEIGHT_FACTOR = 1.4;

/** Without a known route only the default, undisplaced anchor can be diagnosed. */
function hasAuthoredLabelDisplacement(cell: DomEl, work: ChargeWork): boolean {
  work(cell.childNodes.length);
  const geometry = firstByTag(cell, "mxGeometry");
  if (!geometry) return false;
  if (attr(geometry, "relative") === "1" && pyFloat(attr(geometry, "y") ?? "0")) return true;
  work(geometry.childNodes.length);
  const offset = childrenByTag(geometry, "mxPoint").find((point) => attr(point, "as") === "offset");
  return Boolean(offset && (pyFloat(attr(offset, "x") ?? "0") || pyFloat(attr(offset, "y") ?? "0")));
}

/** Where an edge label starts along its route before applying the normal and offset. */
function labelFraction(cell: DomEl, work: ChargeWork): number {
  work(cell.childNodes.length);
  const geometry = firstByTag(cell, "mxGeometry");
  const along = geometry && attr(geometry, "relative") === "1" ? pyFloat(attr(geometry, "x") ?? "0") : 0;
  return along !== undefined && Number.isFinite(along) ? Math.min(1, Math.max(0, (along + 1) / 2)) : 0.5;
}

function inlineLabelSize(cell: DomEl, label: string, work: ChargeWork): Point {
  const fontSize = styleNum(attr(cell, "style"), "fontSize", work) ?? DEFAULT_FONT_SIZE;
  let maxLength = 0;
  let lines = 1;
  let start = 0;
  for (let end = label.indexOf("\n"); end !== -1; end = label.indexOf("\n", start)) {
    work();
    maxLength = Math.max(maxLength, end - start);
    lines++;
    start = end + 1;
  }
  maxLength = Math.max(maxLength, label.length - start);
  return [maxLength * fontSize * CHAR_WIDTH_FACTOR, lines * fontSize * LINE_HEIGHT_FACTOR];
}

function labelBox(cell: DomEl, label: string, [x, y]: Point, work: ChargeWork): Rect | null {
  const size = cell.getAttribute("edge") === "1" ? inlineLabelSize(cell, label, work) : rect(cell, work)?.slice(2);
  if (!size || hasInvalidNumber(size)) return null;
  const [width, height] = size;
  return [x - width / 2, y - height / 2, width, height];
}

/** Drop waypoints on a straight run and sub-2px jogs (not real bends), keeping the route's shape. */
function straightenRoute(points: Point[], work: ChargeWork): Point[] {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 2;
  const within = (value: number, a: number, b: number): boolean =>
    Math.min(a, b) - 2 <= value && value <= Math.max(a, b) + 2;
  const result: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    work();
    const previous = result.at(-1)!;
    const [point, next] = [points[i], points[i + 1]];
    const jog = near(point[0], previous[0]) && near(point[1], previous[1]);
    const between = within(point[0], previous[0], next[0]) && within(point[1], previous[1], next[1]);
    const run =
      between &&
      ((near(previous[1], point[1]) && near(point[1], next[1])) ||
        (near(previous[0], point[0]) && near(point[0], next[0])) ||
        orient(previous, point, next) === 0);
    if (!jog && !run) result.push(point);
  }
  result.push(points.at(-1)!);
  return result;
}

/** True for a horizontal or vertical segment, the only kind whose rendered path is known for orthogonal routing. */
function axisAligned(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) < 2 || Math.abs(a[1] - b[1]) < 2;
}

/**
 * Rebuild the corners draw.io adds to a diagonal first or last segment of an
 * orthogonal edge: it leaves a top/bottom exit vertically and a left/right exit
 * horizontally, and mirrors that at the entry. Returns null when a diagonal
 * remains whose rendered path cannot be inferred.
 */
function orthogonalRoute(edge: DomEl, points: Point[], work: ChargeWork): Point[] | null {
  const style = attr(edge, "style") ?? "";
  work(Math.ceil(style.length / 64));
  if (!/(?:^|;)edgeStyle=(?:orthogonalEdgeStyle|elbowEdgeStyle)(?:;|$)/.test(style)) return points;
  const side = (x: string, y: string): "vertical" | "horizontal" | null => {
    const fy = styleNum(style, y, work);
    const fx = styleNum(style, x, work);
    if (fy === 0 || fy === 1) return "vertical";
    if (fx === 0 || fx === 1) return "horizontal";
    return null;
  };
  const last = points.length - 1;
  if (!axisAligned(points[last - 1], points[last])) {
    const entry = side("entryX", "entryY");
    const [prev, end] = [points[last - 1], points[last]];
    if (entry) {
      work();
      points.splice(last, 0, entry === "horizontal" ? [prev[0], end[1]] : [end[0], prev[1]]);
    }
  }
  if (!axisAligned(points[0], points[1])) {
    const exit = side("exitX", "exitY");
    const [start, next] = [points[0], points[1]];
    if (exit) {
      work(points.length);
      points.splice(1, 0, exit === "vertical" ? [start[0], next[1]] : [next[0], start[1]]);
    }
  }
  for (let i = 1; i < points.length; i++) {
    work();
    if (!axisAligned(points[i - 1], points[i])) return null;
  }
  return points;
}

/** Index of the undisplaced anchor's segment, taking the outgoing segment at a bend. */
function anchorSegment(points: Point[], fraction: number, work: ChargeWork): number {
  const lengths: number[] = [];
  let total = 0;
  let last = -1;
  for (let i = 1; i < points.length; i++) {
    work();
    const length = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    lengths.push(length);
    total += length;
    if (length > 0) last = i - 1;
  }
  let remaining = total * fraction;
  for (let i = 0; i < last; i++) {
    work();
    if (remaining < lengths[i]) return i;
    remaining -= lengths[i];
  }
  return last;
}

function pointOnRoute([x, y]: Point, route: Point[], work: ChargeWork): boolean {
  const tolerance = 0.5;
  for (let i = 1; i < route.length; i++) {
    work();
    const [ax, ay] = route[i - 1];
    const dx = route[i][0] - ax;
    const dy = route[i][1] - ay;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const along = (x - ax) * (dx / length) + (y - ay) * (dy / length);
    const normal = (x - ax) * (dy / length) - (y - ay) * (dx / length);
    if (along >= -tolerance && along <= length + tolerance && Math.abs(normal) <= tolerance) return true;
  }
  return false;
}

type LabelRoutes = Map<DomEl, { points: Point[]; known: boolean }>;

/** Detect edge-label boxes landing on a bend, another segment, or another connector. */
function checkLabelRouteIntersections(
  cell: DomEl, edge: DomEl, route: Point[], box: Rect, routes: LabelRoutes, { work, finding }: ValidationBudget,
): void {
  const id = attr(cell, "id");
  const anchor = anchorSegment(route, labelFraction(cell, work), work);
  if (routeHitsRect(route, box, work, anchor)) {
    finding("warning",
      `edge label ${repr(id)} likely sits on a bend or another segment of its own connector; move it along the edge (geometry x) or change its offset so the text clears every segment`,
    );
  }
  for (const [other, otherRoute] of routes) {
    work();
    if (other !== edge && otherRoute.known && routeHitsRect(otherRoute.points, box, work)) {
      finding("warning", `edge label ${repr(id)} likely overlaps edge ${repr(attr(other, "id"))}`);
    }
  }
}

function checkLabelOnLine(cell: DomEl, onLine: boolean, { work, finding }: ValidationBudget): void {
  if (!onLine) return;
  const style = attr(cell, "style") ?? "";
  work(Math.ceil(style.length / 64));
  if (!style.includes("labelBackgroundColor=")) {
    const id = repr(attr(cell, "id"));
    const subject = cell.getAttribute("edge") === "1" ? `edge ${id} label` : `edge label ${id}`;
    finding("warning", `${subject} sits directly on its line; add an offset or labelBackgroundColor`);
  }
}

function checkEdgeLabels(cells: DomEl[], ids: ById, leaves: LeafBox[], budget: ValidationBudget): void {
  const { work, finding } = budget;
  const routes: LabelRoutes = new Map();
  for (const edge of cells) {
    work();
    if (edge.getAttribute("edge") !== "1" || !isVisible(edge, ids, work)) continue;
    const explicit = edgeRoute(edge, ids, work);
    if (!explicit) continue;
    const inferred = orthogonalRoute(edge, straightenRoute(explicit, work), work);
    routes.set(edge, { points: inferred ?? explicit, known: inferred !== null });
  }
  for (const cell of cells) {
    work();
    const inline = cell.getAttribute("edge") === "1";
    const edge = inline ? cell : isEdgeLabel(cell) ? ids.get(attr(cell, "parent") ?? "") : undefined;
    if (edge?.getAttribute("edge") !== "1" || !isVisible(cell, ids, work)) continue;
    const label = labelText(cell, work);
    if (!label) continue;
    const route = routes.get(edge);
    const anchor = route && edgeLabelAnchor(cell, route.points, work);
    if (route?.known) {
      checkLabelOnLine(cell, anchor != null && pointOnRoute(anchor, route.points, work), budget);
    } else if (inline) {
      checkLabelOnLine(cell, !hasAuthoredLabelDisplacement(cell, work), budget);
    }
    if (!anchor || !route) continue;
    const box = labelBox(cell, label, anchor, work);
    if (!box || hasInvalidNumber(box)) continue;
    for (const [vertexId, vertexBox] of leaves) {
      work();
      if (overlap(box, vertexBox)) {
        finding("warning", `edge label ${repr(attr(cell, "id"))} likely overlaps vertex ${repr(vertexId)}`);
      }
    }
    if (route.known) checkLabelRouteIntersections(cell, edge, route.points, box, routes, budget);
  }
}

function isCompactBorderPort(cell: DomEl, box: Rect | null, work: ChargeWork): boolean {
  return (
    cell.getAttribute("vertex") === "1" &&
    geometryIsRelative(cell, work) &&
    !isEdgeLabel(cell) &&
    box !== null &&
    !hasInvalidNumber(box) &&
    box[2] <= 30 &&
    box[3] <= 30
  );
}

function smallFontWarning(cell: DomEl, box: Rect | null, work: ChargeWork): string | null {
  const fontSize = styleNum(attr(cell, "style"), "fontSize", work);
  const isEdgeText = cell.getAttribute("edge") === "1" || isEdgeLabel(cell);
  const minimum = isEdgeText ? 10 : 11;
  if (
    isCompactBorderPort(cell, box, work) ||
    fontSize === undefined ||
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    fontSize >= minimum
  ) {
    return null;
  }
  return `${isEdgeText ? "connector label" : "vertex"} ${repr(attr(cell, "id"))} has very small explicit fontSize ${fontSize}px`;
}

function longLabelWarning(cell: DomEl, label: string, box: Rect | null, work: ChargeWork): string | null {
  if (cell.getAttribute("vertex") !== "1" || isEdgeLabel(cell) || geometryIsRelative(cell, work)) return null;
  if (box === null || hasInvalidNumber(box)) return null;
  if (label.length <= 32 || label.includes("\n") || box[2] >= 160 || styleHas(attr(cell, "style"), "whiteSpace", "wrap", work)) {
    return null;
  }
  return `vertex ${repr(attr(cell, "id"))} has a long label in narrow geometry without whiteSpace=wrap`;
}

/** Conservative static checks only; uncertain typography remains a visual concern. */
function checkReadability(cell: DomEl, ids: ById, { work, finding }: ValidationBudget): void {
  const label = labelText(cell, work);
  if (!label || !isVisible(cell, ids, work)) return;
  const box = rect(cell, work);
  const font = smallFontWarning(cell, box, work);
  if (font) finding("warning", font);
  const wrap = longLabelWarning(cell, label, box, work);
  if (wrap) finding("warning", wrap);
}

function checkPage(diagram: DomEl, maxCells: number, budget: ValidationBudget): void {
  const { work, finding } = budget;
  if (diagram.tagName !== "mxGraphModel") work(diagram.childNodes.length);
  const model = pageModel(diagram);
  if (!model) {
    if (diagram.tagName === "diagram" && directText(diagram).trim()) finding("warning", "compressed, skipped (cannot lint)");
    else finding("error", "no <mxGraphModel>");
    return;
  }
  const root = animationGraphRoot(model, budget);
  if (!root) {
    finding("error", "no <root> in <mxGraphModel>");
    return;
  }
  const cells = collectCells(root, work);
  if (cells.length > maxCells) throw new ValidationStop(`validation cell limit (${maxCells}) exceeded`);
  const ids = buildIds(cells, budget);
  checkParentCycles(ids, budget);
  const parents = new Set<string | null>();
  for (const cell of cells) {
    work();
    parents.add(attr(cell, "parent"));
    checkCell(cell, ids, budget);
  }
  // The delegates report at discovery to the same sink; do not add their arrays again.
  const motion = analyzeStoredMotion(model, budget);
  const animation = analyzeAnimationPage(diagram, budget);
  if (motion?.compiled) {
    finding("observation",
      `stored motion has ${motion.spec!.steps.length} step(s) lasting ${Math.round(motion.compiled.sequenceMs)}ms; export it with drawio_animate`,
    );
  }
  if (motion && animation.sequence?.enabled) {
    finding("error", "page has both stored motion and an enabled native page animation; keep only one timeline");
  }

  checkOverlaps(cells, ids, parents, budget);
  const routed = collectRoutedEdges(cells, ids, work);
  const leaves = collectLeafBoxes(cells, ids, parents, work);
  checkRouteThrough(routed, leaves, budget);
  checkRouteCrossings(routed, budget);
  checkEdgeLabels(cells, ids, leaves, budget);
  for (const cell of cells) {
    work();
    checkAnchorFacing(cell, ids, budget);
    checkContainment(cell, ids, budget);
    checkReadability(cell, ids, budget);
  }
  checkPredictedRoutes(cells, ids, leaves, budget);
  checkUnroutedEdges(cells, ids, budget);
  checkCanvas(cells, ids, pageSettings(model, budget), budget);
}

function malformedXml(message: string): string {
  return excerpt(`malformed XML: ${message}`, MAX_RENDERED_FINDING_LENGTH).trimEnd();
}

function parseDiagramRoot(xml: string, budget: ValidationBudget): DomEl | null {
  let parserStop: ValidationStop | undefined;
  try {
    const doc = new DOMParser({
      onError: (_level, message) => {
        try {
          budget.work();
          budget.finding("error", malformedXml(message));
        } catch (error) {
          if (error instanceof ValidationStop) parserStop = error;
          throw error;
        }
      },
    }).parseFromString(xml, "text/xml");
    return doc.documentElement as unknown as DomEl | null;
  } catch (error) {
    // xmldom wraps exceptions from onError in a new ParseError. Do not misclassify it as malformed XML.
    throw parserStop ?? error;
  }
}

function emptyResult(): ValidateResult {
  return { errors: [], warnings: [], observations: [], score: { total: 0, through: 0, crossings: 0, overlaps: 0, anchors: 0 } };
}

/** Return structural findings and the readability score of admitted warnings. */
export function validateXml(xml: string, overrides?: Partial<ValidationLimits>): ValidateResult {
  const limits = { ...DEFAULT_VALIDATION_LIMITS, ...overrides };
  const result = emptyResult();
  let pagePrefix = "";
  const budget = createValidationBudget(limits, (level, message, kind) => {
    const diagnostic = excerpt(pagePrefix + message, MAX_RENDERED_FINDING_LENGTH);
    if (level === "error") result.errors.push(diagnostic);
    else if (level === "observation") result.observations.push(diagnostic);
    else {
      result.warnings.push(diagnostic);
      if (kind) {
        result.score[kind]++;
        result.score.total += SCORE_WEIGHTS[kind];
      }
    }
  });
  try {
    const bytes = Buffer.byteLength(xml);
    if (bytes > limits.maxBytes) throw new ValidationStop(`diagram input exceeds the ${limits.maxBytes} byte limit`);
    budget.work(Math.ceil(bytes / 64));
    const root = parseDiagramRoot(xml, budget);
    if (!root) {
      budget.finding("error", "malformed XML: no root element");
      return result;
    }
    budget.work(root.childNodes.length);
    const pages = diagramPages(root);
    if (pages.length === 0) budget.finding("error", "no <diagram> or <mxGraphModel> page");
    for (const [index, page] of pages.entries()) {
      if (index >= limits.maxPages) throw new ValidationStop(`validation page limit (${limits.maxPages}) exceeded`);
      pagePrefix = `page ${repr(attr(page, "name") ?? "?")}: `;
      budget.work();
      checkPage(page, limits.maxCellsPerPage, budget);
      pagePrefix = "";
    }
  } catch (error) {
    if (error instanceof ValidationStop) {
      result.incomplete = true;
      result.errors.push(`${pagePrefix}validation incomplete: ${error.message}`);
    } else if (error instanceof ParseError) {
      // Fatal parser diagnostics normally already went to the sink via onError.
      if (result.errors.length === 0) result.errors.push(malformedXml(error.message));
    } else {
      throw error;
    }
  }
  return result;
}

/** Read and lint a regular `.drawio` file within the same byte ceiling as inline XML. */
export async function validateFile(path: string, limits?: Partial<ValidationLimits>): Promise<ValidateResult> {
  let xml: string;
  try {
    xml = await readDiagramXml(path, limits?.maxBytes);
  } catch (error) {
    const result = emptyResult();
    result.errors.push(excerpt(`cannot read ${path}: ${(error as Error).message}`, MAX_RENDERED_FINDING_LENGTH));
    return result;
  }
  try {
    return validateXml(xml, limits);
  } catch (error) {
    const result = emptyResult();
    result.errors.push(excerpt(`cannot parse ${path}: ${(error as Error).message}`, MAX_RENDERED_FINDING_LENGTH));
    return result;
  }
}
