/**
 * Deterministic structural linter for `.drawio` files. It rejects broken cell
 * contracts and reports conservative geometry/readability findings that can be
 * checked without rendering. Typography and automatically routed connectors
 * still require visual review.
 */
import { DOMParser, ParseError } from "@xmldom/xmldom";
import { type DomEl, attr, childrenByTag, diagramPages, directText, firstByTag, pageModel } from "./dom";
import { analyzeAnimationPage } from "./animation";
import { analyzeStoredMotion } from "./motion";
import {
  type ById,
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
  explicitEdgeLabelRect,
  isEdgeLabel,
  isVisible,
  pyFloat,
  rect,
  styleNum,
} from "./geometry";
import { createValidationBudget, ValidationBudgetExceeded, type ValidationBudget } from "./validation-budget";
import { DEFAULT_MAX_XML_BYTES, DiagramXmlTooLargeError, readDiagramXml } from "./xml-input";

const RESERVED = new Set(["0", "1"]);
export const MIN_OUTER_MARGIN = 20;
const EXCESSIVE_CANVAS_AREA_RATIO = 4;
const EXCESSIVE_CANVAS_AXIS_RATIO = 0.6;

export interface ValidateResult {
  errors: string[];
  warnings: string[];
  /** Informational limitations/settings that do not require a source correction. */
  observations: string[];
  /** A resource limit prevented validation from finishing. */
  incomplete: boolean;
  /** Readability score (lower is better); partial when incomplete. */
  score: { total: number; through: number; crossings: number; overlaps: number; anchors: number };
}

export interface ValidationLimits {
  maxBytes: number;
  maxCellsPerPage: number;
  maxWork: number;
  maxDiagnostics: number;
}

const DEFAULT_LIMITS: ValidationLimits = {
  maxBytes: DEFAULT_MAX_XML_BYTES,
  maxCellsPerPage: 5_000,
  maxWork: 100_000,
  maxDiagnostics: 500,
};

type Severity = "errors" | "warnings" | "observations";
type ScoreKind = Exclude<keyof ValidateResult["score"], "total">;
const SCORE_WEIGHTS: Record<ScoreKind, number> = { through: 20, crossings: 10, overlaps: 5, anchors: 8 };
type ReportFinding = (severity: Severity, message: string | null, kind?: ScoreKind) => void;

/** Quote an optional attribute consistently in diagnostic messages. */
function repr(s: string | null): string {
  return s === null ? "None" : `'${s}'`;
}

function overlap(a: Rect, b: Rect): boolean {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

function hasStyleToken(style: string | null, token: string, budget: ValidationBudget, trim = false): boolean {
  if (!style) return false;
  let start = 0;
  while (start < style.length) {
    budget.work();
    const end = style.indexOf(";", start);
    const limit = end === -1 ? style.length : end;
    const part = style.slice(start, limit);
    if ((trim ? part.trim() : part) === token) return true;
    start = limit + 1;
  }
  return false;
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

function routeHitsRect(points: Point[], box: Rect, budget: ValidationBudget): boolean {
  const [x, y, w, h] = box;
  const corners: Point[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const borders: [Point, Point][] = corners.map((corner, index) => [corner, corners[(index + 1) % 4]]);
  for (let i = 0; i < points.length - 1; i++) {
    budget.work();
    const start = points[i];
    const end = points[i + 1];
    if (pointInRect(start, box) || pointInRect(end, box)) return true;
    for (const [a, b] of borders) if (segmentsCross(start, end, a, b)) return true;
  }
  return false;
}

function routesCross(a: Point[], b: Point[], budget: ValidationBudget): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      budget.work();
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

type RoutedEdge = [string | null, Point[], Set<string | null>];
type LeafBox = [string | null, Rect];
type VisibleRoutes = Map<DomEl, Point[] | null>;

/** Resolve each visible connector once for the route, anchor and label passes. */
function collectRoutes(cells: DomEl[], ids: ById, budget: ValidationBudget): { visible: VisibleRoutes; routed: RoutedEdge[] } {
  const visible: VisibleRoutes = new Map();
  const routed: RoutedEdge[] = [];
  for (const cell of cells) {
    budget.work();
    if (cell.getAttribute("edge") !== "1" || !isVisible(cell, ids, budget)) continue;
    const points = edgeRoute(cell, ids, budget);
    visible.set(cell, points);
    if (points) routed.push([attr(cell, "id"), points, new Set([attr(cell, "source"), attr(cell, "target")])]);
  }
  return { visible, routed };
}

/** Absolute boxes of leaf vertices (real nodes, not containers or edge labels). */
function collectLeafBoxes(cells: DomEl[], ids: ById, parents: Set<string | null>, budget: ValidationBudget): LeafBox[] {
  const leaves: LeafBox[] = [];
  for (const cell of cells) {
    budget.work();
    if (!parents.has(attr(cell, "id")) && isContainmentCandidate(cell, ids, budget)) {
      const box = absRect(cell, ids, budget);
      if (box) leaves.push([attr(cell, "id"), box]);
    }
  }
  return leaves;
}

function routeThroughWarnings(routed: RoutedEdge[], leaves: LeafBox[], budget: ValidationBudget, report: ReportFinding): void {
  for (const [edgeId, points, ends] of routed) {
    budget.work();
    for (const [vertexId, box] of leaves) {
      budget.work();
      if (!ends.has(vertexId) && routeHitsRect(points, box, budget)) {
        report("warnings", `edge ${repr(edgeId)} routes through vertex ${repr(vertexId)}`, "through");
      }
    }
  }
}

function routeCrossWarnings(routed: RoutedEdge[], budget: ValidationBudget, report: ReportFinding): void {
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      budget.work();
      if (routesCross(routed[i][1], routed[j][1], budget)) {
        report("warnings", `edges ${repr(routed[i][0])} and ${repr(routed[j][0])} cross`, "crossings");
      }
    }
  }
}

type Side = "top" | "bottom" | "left" | "right";

/** Side containing a pinned connection point, or null for an interior, corner, or unpinned point. */
function pinnedSide(style: string, end: "source" | "target", budget: ValidationBudget): Side | null {
  const x = styleNum(style, end === "source" ? "exitX" : "entryX", budget);
  const y = styleNum(style, end === "source" ? "exitY" : "entryY", budget);
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
  budget: ValidationBudget,
): string | null {
  const dx = direction.reference[0] - direction.center[0];
  const dy = direction.reference[1] - direction.center[1];
  const side = pinnedSide(style, direction.end, budget);
  if (!side || !sideFacesAway(side, dx, dy, tolerance)) return null;
  const suggested = facingSide(dx, dy);
  const endLabel = direction.end === "source" ? "source exit" : "target entry";
  return `edge ${repr(attr(cell, "id"))}: ${endLabel} pinned to ${side} but ${direction.subject} is ${directionDescription(dx, dy)}; re-pin to ${suggested} (${sideStyleHint(suggested, direction.end)}) to shorten the route and reduce bends`;
}

/** Warn when a pinned border anchor faces away from its adjacent waypoint, or its peer when auto-routed. */
function edgeAnchorFacingWarnings(cell: DomEl, route: Point[] | null, ids: ById, budget: ValidationBudget, report: ReportFinding): void {
  const sourceId = attr(cell, "source");
  const targetId = attr(cell, "target");
  if (!sourceId || !targetId) return;
  const source = ids.get(sourceId);
  const target = ids.get(targetId);
  if (!source || !target || geometryIsRelative(source, budget) || geometryIsRelative(target, budget)) return;
  const sourceBox = absRect(source, ids, budget);
  const targetBox = absRect(target, ids, budget);
  if (!sourceBox || !targetBox) return;

  const sourceCenter = rectCenter(sourceBox);
  const targetCenter = rectCenter(targetBox);
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
    report("warnings", anchorDirectionWarning(cell, style, tolerance, direction, budget), "anchors");
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

function isDescendantOf(cell: DomEl, ancestorId: string, ids: ById, budget: ValidationBudget): boolean {
  const seen = new Set<string>();
  let parent = attr(cell, "parent");
  while (parent && !seen.has(parent)) {
    budget.work();
    const container = ids.get(parent);
    if (!container) break;
    if (parent === ancestorId) return true;
    seen.add(parent);
    parent = attr(container, "parent");
  }
  return false;
}

interface AutoRouteContext {
  edgeId: string | null;
  sourceId: string;
  targetId: string;
  sourcePoint: Point;
  targetPoint: Point;
}

function autoRouteContext(cell: DomEl, ids: ById, budget: ValidationBudget): AutoRouteContext | null {
  if (edgeWaypoints(cell, budget).length > 0) return null;
  const sourceId = attr(cell, "source");
  const targetId = attr(cell, "target");
  if (!sourceId || !targetId) return null;
  const source = ids.get(sourceId);
  const target = ids.get(targetId);
  if (!source || !target || geometryIsRelative(source, budget) || geometryIsRelative(target, budget)) return null;
  const sourcePoint = endpoint(cell, "source", ids, budget);
  const targetPoint = endpoint(cell, "target", ids, budget);
  if (!sourcePoint || !targetPoint) return null;
  return { edgeId: attr(cell, "id"), sourceId, targetId, sourcePoint, targetPoint };
}

/**
 * Identify auto-routed edges whose direct connection line pierces an unrelated
 * leaf vertex. This is only a preview hint; the actual connector may avoid it.
 */
function predictedRouteThroughObservations(
  visible: VisibleRoutes, ids: ById, leaves: LeafBox[], budget: ValidationBudget, report: ReportFinding,
): void {
  const candidates: [DomEl, string, Rect][] = [];
  for (const [id, box] of leaves) {
    budget.work();
    const vertex = id === null ? undefined : ids.get(id);
    if (vertex && id !== null && !hasStyleToken(attr(vertex, "style"), "text", budget, true)) {
      candidates.push([vertex, id, box]);
    }
  }
  for (const [cell, route] of visible) {
    budget.work();
    if (route) continue;
    const context = autoRouteContext(cell, ids, budget);
    if (!context) continue;
    const { edgeId, sourceId, targetId, sourcePoint, targetPoint } = context;
    for (const [vertex, vertexId, box] of candidates) {
      budget.work();
      if (vertexId === sourceId || vertexId === targetId || !segmentPiercesRect(sourcePoint, targetPoint, box)) continue;
      if (isDescendantOf(vertex, sourceId, ids, budget) || isDescendantOf(vertex, targetId, ids, budget)) continue;
      report("observations", `edge ${repr(edgeId)} may pass over vertex ${repr(vertexId)} (predicted from the direct line; verify in the preview, then add waypoints or move the shape if needed)`);
    }
  }
}

/** Edges the route checks above cannot see: no explicit waypoints, so the renderer routes them blindly. */
function autoRoutedEdgeWarning(visible: VisibleRoutes, budget: ValidationBudget): string | null {
  const unrouted: string[] = [];
  for (const [cell, route] of visible) {
    budget.work();
    if (!route) unrouted.push(repr(attr(cell, "id")));
  }
  if (unrouted.length === 0) return null;
  return (
    `${unrouted.length} auto-routed edge(s) cannot be route-checked (no explicit waypoints): ${unrouted.join(", ")}; ` +
    "add waypoints and pinned anchors, or verify their routing visually"
  );
}

/** Map every cell by id (blank key for id-less cells); report duplicate ids as errors. */
function buildIds(cells: DomEl[], budget: ValidationBudget, report: ReportFinding): ById {
  const ids: ById = new Map();
  for (const cell of cells) {
    budget.work();
    const id = attr(cell, "id");
    if (id !== null && ids.has(id)) report("errors", `duplicate id ${repr(id)}`);
    ids.set(id ?? "", cell);
  }
  return ids;
}

/** Each cell has at most one parent. Mark completed paths so shared ancestors are not revisited. */
function checkParentCycles(cells: DomEl[], ids: ById, budget: ValidationBudget, report: ReportFinding): void {
  const done = new Set<DomEl>();
  for (const cell of cells) {
    budget.work();
    if (done.has(cell)) continue;
    const path: DomEl[] = [];
    const visiting = new Map<DomEl, number>();
    let current: DomEl | undefined = cell;
    while (current && !done.has(current)) {
      budget.work();
      const start = visiting.get(current);
      if (start !== undefined) {
        budget.work(path.length - start);
        const cycle = path.slice(start).map((member) => repr(attr(member, "id")));
        cycle.push(repr(attr(current, "id")));
        report("errors", `containment cycle: ${cycle.join(" -> ")}`);
        break;
      }
      visiting.set(current, path.length);
      path.push(current);
      const parent = attr(current, "parent");
      current = parent ? ids.get(parent) : undefined;
    }
    budget.work(path.length);
    for (const member of path) done.add(member);
  }
}

/** Geometry checks for a single non-edge-label, non-relative vertex. */
function checkVertexGeometry(cell: DomEl, id: string | null, budget: ValidationBudget, report: ReportFinding): void {
  const box = rect(cell, budget);
  if (box === null || hasInvalidNumber(box)) {
    report("errors", `vertex ${repr(id)} has missing/invalid geometry`);
    return;
  }
  const [x, y, width, height] = box;
  if (width <= 0 || height <= 0) report("warnings", `vertex ${repr(id)} non-positive size ${String(width)}x${String(height)}`);
  if (x < 0 || y < 0) report("warnings", `vertex ${repr(id)} negative position (${String(x)},${String(y)})`);
}

function checkEdgeGeometry(cell: DomEl, id: string | null, budget: ValidationBudget, report: ReportFinding): void {
  budget.work(cell.childNodes.length);
  const geometry = firstByTag(cell, "mxGeometry");
  if (!geometry) {
    report("errors", `edge ${repr(id)} has missing geometry`);
    return;
  }
  if (attr(geometry, "relative") !== "1" || attr(geometry, "as") !== "geometry") {
    report("errors", `edge ${repr(id)} geometry must have relative='1' and as='geometry'`);
  }
}

function checkCellReferences(cell: DomEl, id: string | null, ids: ById, report: ReportFinding): void {
  const parent = attr(cell, "parent");
  if (parent !== null && !ids.has(parent)) report("errors", `cell ${repr(id)} parent ${repr(parent)} does not exist`);
  for (const end of ["source", "target"] as const) {
    const reference = attr(cell, end);
    if (reference && !ids.has(reference)) report("errors", `edge ${repr(id)} ${end} ${repr(reference)} does not exist`);
  }
}

/** Per-cell reference and geometry checks. */
function checkCell(cell: DomEl, ids: ById, budget: ValidationBudget, report: ReportFinding): void {
  const id = attr(cell, "id");
  const isVertex = cell.getAttribute("vertex") === "1";
  const isEdge = cell.getAttribute("edge") === "1";
  checkCellReferences(cell, id, ids, report);
  if ((isVertex || isEdge) && id !== null && RESERVED.has(id)) report("errors", `cell ${repr(id)} reuses reserved id 0/1`);
  if (isVertex && !isEdgeLabel(cell) && !geometryIsRelative(cell, budget)) checkVertexGeometry(cell, id, budget, report);
  if (isEdge) checkEdgeGeometry(cell, id, budget, report);
}

/** Sibling overlap: visible leaf vertices only (containers legitimately wrap children). */
function overlapWarnings(
  cells: DomEl[], ids: ById, parents: Set<string | null>, budget: ValidationBudget, report: ReportFinding,
): void {
  const boxes: [string | null, string | null, Rect][] = [];
  for (const cell of cells) {
    budget.work();
    if (!parents.has(attr(cell, "id")) && isContainmentCandidate(cell, ids, budget)) {
      const box = rect(cell, budget);
      if (box && !hasInvalidNumber(box)) boxes.push([attr(cell, "id"), attr(cell, "parent"), box]);
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    const [aId, aParent, a] = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      budget.work();
      const [bId, bParent, b] = boxes[j];
      if (aParent === bParent && overlap(a, b)) report("warnings", `vertices ${repr(aId)} and ${repr(bId)} overlap`, "overlaps");
    }
  }
}

function isContainmentCandidate(cell: DomEl, ids: ById, budget: ValidationBudget): boolean {
  return (
    cell.getAttribute("vertex") === "1" &&
    !isEdgeLabel(cell) &&
    !geometryIsRelative(cell, budget) &&
    isVisible(cell, ids, budget)
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

function containmentWarning(cell: DomEl, ids: ById, budget: ValidationBudget): string | null {
  if (!isContainmentCandidate(cell, ids, budget)) return null;
  const parentId = attr(cell, "parent");
  const parent = parentId ? ids.get(parentId) : undefined;
  if (parent?.getAttribute("vertex") !== "1" || !isVisible(parent, ids, budget)) return null;
  const childBox = absRect(cell, ids, budget);
  const parentBox = absRect(parent, ids, budget);
  if (!childBox || !parentBox) return null;
  const sides = overflowSides(childBox, parentBox);
  if (sides.length === 0) return null;
  return `vertex ${repr(attr(cell, "id"))} extends beyond parent ${repr(parentId)} (${sides.join(", ")})`;
}

interface PageSettings {
  enabled: boolean;
  width?: number;
  height?: number;
  scale: number;
}

function pageSettings(model: DomEl, report: ReportFinding): PageSettings {
  const enabled = attr(model, "page") !== "0";
  if (!enabled) {
    report("observations", "page canvas is disabled (infinite canvas); boundary, margin, and empty-space checks skipped");
    return { enabled, scale: 1 };
  }

  const rawScale = attr(model, "pageScale");
  const parsedScale = rawScale === null ? 1 : pyFloat(rawScale);
  const scale = parsedScale && Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1;
  if (rawScale !== null && scale !== parsedScale) report("warnings", `invalid pageScale ${repr(rawScale)}; using 1`);

  const parseDimension = (name: "pageWidth" | "pageHeight"): number | undefined => {
    const raw = attr(model, name);
    if (raw === null) return undefined;
    const value = pyFloat(raw);
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      report("warnings", `invalid ${name} ${repr(raw)}; page-boundary checks skipped`);
      return undefined;
    }
    return value * scale;
  };
  const width = parseDimension("pageWidth");
  const height = parseDimension("pageHeight");
  if (width === undefined || height === undefined) {
    report("observations", "page dimensions are omitted or invalid; boundary, outer-margin, and empty-space checks require both pageWidth and pageHeight");
  }
  return { enabled, width, height, scale };
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

function canvasWarnings(bounds: ContentBounds | null, width: number, height: number, report: ReportFinding): void {
  if (!bounds) return;
  if (bounds.minX < 0) report("warnings", `content extends beyond left page boundary by ${-bounds.minX}px`);
  if (bounds.minY < 0) report("warnings", `content extends beyond top page boundary by ${-bounds.minY}px`);
  if (bounds.maxX > width) report("warnings", `content extends beyond right page boundary by ${bounds.maxX - width}px`);
  if (bounds.maxY > height) report("warnings", `content extends beyond bottom page boundary by ${bounds.maxY - height}px`);
  report("warnings", outerMarginWarning(bounds, width, height));
  report("warnings", excessiveCanvasWarning(bounds, width, height));
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
function stripLabelMarkup(value: string, budget: ValidationBudget): string {
  const text: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    budget.work();
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

function labelText(cell: DomEl, budget: ValidationBudget): string {
  return stripLabelMarkup(attr(cell, "value") ?? "", budget).replaceAll("&nbsp;", " ").trim();
}

const DEFAULT_FONT_SIZE = 11;
const CHAR_WIDTH_FACTOR = 0.6;
const LINE_HEIGHT_FACTOR = 1.4;

function labelOffset(geometry: DomEl, budget: ValidationBudget): Point | null {
  budget.work(geometry.childNodes.length);
  const offset = childrenByTag(geometry, "mxPoint").find((point) => attr(point, "as") === "offset");
  if (!offset) return null;
  const x = pyFloat(attr(offset, "x") ?? "0");
  const y = pyFloat(attr(offset, "y") ?? "0");
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

/** Where an inline edge label is anchored along its route, as a 0..1 fraction (geometry x runs -1..1). */
function labelFraction(geometry: DomEl | null): number {
  const along = geometry ? pyFloat(attr(geometry, "x") ?? "0") : 0;
  return along !== undefined && Number.isFinite(along) ? Math.min(1, Math.max(0, (along + 1) / 2)) : 0.5;
}

/** Estimated label box centered on the resolved anchor. */
function labelBox(cell: DomEl, label: string, [x, y]: Point, budget: ValidationBudget): Rect {
  const fontSize = styleNum(attr(cell, "style"), "fontSize", budget) ?? DEFAULT_FONT_SIZE;
  let longestLine = 0;
  let lineCount = 0;
  let start = 0;
  for (;;) {
    budget.work();
    const end = label.indexOf("\n", start);
    longestLine = Math.max(longestLine, (end === -1 ? label.length : end) - start);
    lineCount++;
    if (end === -1) break;
    start = end + 1;
  }
  const width = longestLine * fontSize * CHAR_WIDTH_FACTOR;
  const height = lineCount * fontSize * LINE_HEIGHT_FACTOR;
  return [x - width / 2, y - height / 2, width, height];
}

/** Edge-label text lying on top of a shape; sizes are estimated, so phrased as "likely". */
function labelOverlapWarnings(id: string | null, box: Rect, leaves: LeafBox[], budget: ValidationBudget, report: ReportFinding): void {
  for (const [vertexId, vertexBox] of leaves) {
    budget.work();
    if (overlap(box, vertexBox)) report("warnings", `edge label ${repr(id)} likely overlaps vertex ${repr(vertexId)}`);
  }
}

/** Drop waypoints on a straight run and sub-2px jogs (not real bends), keeping the route's shape. */
function straightenRoute(points: Point[], budget: ValidationBudget): Point[] {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 2;
  const within = (value: number, a: number, b: number): boolean =>
    Math.min(a, b) - 2 <= value && value <= Math.max(a, b) + 2;
  const result: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    budget.work();
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

function isOrthogonal(edge: DomEl): boolean {
  const style = attr(edge, "style") ?? "";
  return /(?:^|;)edgeStyle=(?:orthogonalEdgeStyle|elbowEdgeStyle)(?:;|$)/.test(style);
}

/**
 * Rebuild the corners draw.io adds to a diagonal first or last segment of an
 * orthogonal edge: it leaves a top/bottom exit vertically and a left/right exit
 * horizontally, and mirrors that at the entry. Returns null when a diagonal
 * remains whose rendered path cannot be inferred.
 */
function orthogonalRoute(edge: DomEl, route: Point[], budget: ValidationBudget): Point[] | null {
  if (!isOrthogonal(edge)) return route;
  const style = attr(edge, "style");
  const side = (x: string, y: string): "vertical" | "horizontal" | null => {
    const fy = styleNum(style, y, budget);
    const fx = styleNum(style, x, budget);
    if (fy === 0 || fy === 1) return "vertical";
    if (fx === 0 || fx === 1) return "horizontal";
    return null;
  };
  budget.work(route.length);
  const points = [...route];
  const last = points.length - 1;
  if (!axisAligned(points[last - 1], points[last])) {
    const entry = side("entryX", "entryY");
    const [prev, end] = [points[last - 1], points[last]];
    if (entry === "horizontal") points.splice(last, 0, [prev[0], end[1]]);
    else if (entry === "vertical") points.splice(last, 0, [end[0], prev[1]]);
  }
  if (!axisAligned(points[0], points[1])) {
    const exit = side("exitX", "exitY");
    const [start, next] = [points[0], points[1]];
    if (exit) {
      budget.work(points.length - 1);
      points.splice(1, 0, exit === "vertical" ? [start[0], next[1]] : [next[0], start[1]]);
    }
  }
  for (let i = 1; i < points.length; i++) {
    budget.work();
    if (!axisAligned(points[i - 1], points[i])) return null;
  }
  return points;
}

/** Index of the route segment that holds the point at `fraction` of the route's length. */
function anchorSegment(points: Point[], fraction: number, budget: ValidationBudget): number {
  const lengths: number[] = [];
  let total = 0;
  let last = 0;
  for (let i = 0; i < points.length - 1; i++) {
    budget.work();
    const length = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    lengths.push(length);
    total += length;
    if (length > 0) last = i;
  }
  const distance = total * fraction;
  let traversed = 0;
  for (let i = 0; i < last; i++) {
    budget.work();
    traversed += lengths[i];
    if (distance < traversed) return i;
  }
  return last;
}

/**
 * Inline labels whose estimated box lands on a bend or another segment of
 * their own connector (typically after an offset pushes them sideways), or on
 * another explicitly routed connector. A background color cannot fix these:
 * the line visibly runs into the text.
 */
function labelRouteIntersections(
  cell: DomEl, route: Point[], box: Rect, fraction: number, routes: Map<DomEl, Point[]>,
  budget: ValidationBudget, report: ReportFinding,
): void {
  const id = attr(cell, "id");
  const anchor = anchorSegment(route, fraction, budget);
  for (let i = 0; i < route.length - 1; i++) {
    budget.work();
    if (i !== anchor && routeHitsRect([route[i], route[i + 1]], box, budget)) {
      report("warnings", `edge label ${repr(id)} likely sits on a bend or another segment of its own connector; move it along the edge (geometry x) or change its offset so the text clears every segment`);
      break;
    }
  }
  for (const [other, otherRoute] of routes) {
    budget.work();
    if (other !== cell && routeHitsRect(otherRoute, box, budget)) {
      report("warnings", `edge label ${repr(id)} likely overlaps edge ${repr(attr(other, "id"))}`);
    }
  }
}

function pointOnRoute([x, y]: Point, route: Point[], budget: ValidationBudget): boolean {
  const epsilon = 1e-6;
  for (let i = 0; i < route.length - 1; i++) {
    budget.work();
    const [sx, sy] = route[i];
    const [ex, ey] = route[i + 1];
    const length = Math.hypot(ex - sx, ey - sy);
    if (length === 0) continue;
    const dx = (ex - sx) / length;
    const dy = (ey - sy) / length;
    const along = (x - sx) * dx + (y - sy) * dy;
    const normal = (x - sx) * dy - (y - sy) * dx;
    if (Math.abs(normal) < epsilon && along >= -epsilon && along <= length + epsilon) return true;
  }
  return false;
}

/** For auto-routes we cannot project an explicit displacement onto the unknown path. */
function undisplacedLabel(geometry: DomEl | null, budget: ValidationBudget): boolean {
  if (!geometry) return true;
  const normal = pyFloat(attr(geometry, "y") ?? "0");
  const [x, y] = labelOffset(geometry, budget) ?? [0, 0];
  return (!Number.isFinite(normal) || normal === 0) && x === 0 && y === 0;
}

function checkEdgeLabels(
  cells: DomEl[], ids: ById, visible: VisibleRoutes, leaves: LeafBox[], budget: ValidationBudget, report: ReportFinding,
): void {
  const inferredRoutes = new Map<DomEl, Point[]>();
  for (const [cell, explicit] of visible) {
    budget.work();
    if (!explicit) continue;
    const inferred = orthogonalRoute(cell, straightenRoute(explicit, budget), budget);
    if (inferred) inferredRoutes.set(cell, inferred);
  }

  for (const cell of cells) {
    budget.work();
    const inline = cell.getAttribute("edge") === "1";
    if (inline ? !visible.has(cell) : !isEdgeLabel(cell) || !isVisible(cell, ids, budget)) continue;
    const label = labelText(cell, budget);
    if (!label) continue;
    const id = attr(cell, "id");
    if (!inline) {
      const box = explicitEdgeLabelRect(cell, ids, budget);
      if (box && !hasInvalidNumber(box)) labelOverlapWarnings(id, box, leaves, budget, report);
      continue;
    }

    const inferred = inferredRoutes.get(cell);
    const route = inferred ?? visible.get(cell);
    const anchor = route ? edgeLabelAnchor(cell, route, budget) : null;
    budget.work(cell.childNodes.length);
    const geometry = firstByTag(cell, "mxGeometry");
    if (!(attr(cell, "style") ?? "").includes("labelBackgroundColor=")) {
      const onLine = inferred && anchor ? pointOnRoute(anchor, inferred, budget) : undisplacedLabel(geometry, budget);
      if (onLine) report("warnings", `edge ${repr(id)} label sits directly on its line; add an offset or labelBackgroundColor`);
    }
    if (anchor) {
      const box = labelBox(cell, label, anchor, budget);
      if (hasInvalidNumber(box)) continue;
      labelOverlapWarnings(id, box, leaves, budget, report);
      if (inferred) labelRouteIntersections(cell, inferred, box, labelFraction(geometry), inferredRoutes, budget, report);
    }
  }
}

function isCompactBorderPort(cell: DomEl, box: Rect | null, budget: ValidationBudget): boolean {
  return (
    cell.getAttribute("vertex") === "1" &&
    geometryIsRelative(cell, budget) &&
    !isEdgeLabel(cell) &&
    box !== null &&
    !hasInvalidNumber(box) &&
    box[2] <= 30 &&
    box[3] <= 30
  );
}

function smallFontWarning(cell: DomEl, box: Rect | null, budget: ValidationBudget): string | null {
  const fontSize = styleNum(attr(cell, "style"), "fontSize", budget);
  const isEdgeText = cell.getAttribute("edge") === "1" || isEdgeLabel(cell);
  const minimum = isEdgeText ? 10 : 11;
  if (
    isCompactBorderPort(cell, box, budget) ||
    fontSize === undefined ||
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    fontSize >= minimum
  ) {
    return null;
  }
  return `${isEdgeText ? "connector label" : "vertex"} ${repr(attr(cell, "id"))} has very small explicit fontSize ${fontSize}px`;
}

function longLabelWarning(cell: DomEl, label: string, box: Rect | null, budget: ValidationBudget): string | null {
  if (cell.getAttribute("vertex") !== "1" || isEdgeLabel(cell) || geometryIsRelative(cell, budget)) return null;
  if (box === null || hasInvalidNumber(box)) return null;
  if (
    label.length <= 32 ||
    label.includes("\n") ||
    box[2] >= 160 ||
    hasStyleToken(attr(cell, "style"), "whiteSpace=wrap", budget)
  ) {
    return null;
  }
  return `vertex ${repr(attr(cell, "id"))} has a long label in narrow geometry without whiteSpace=wrap`;
}

/** Conservative static checks only; uncertain typography remains a visual concern. */
function readabilityWarnings(cells: DomEl[], budget: ValidationBudget, report: ReportFinding): void {
  for (const cell of cells) {
    budget.work();
    const label = labelText(cell, budget);
    if (!label) continue;
    const box = rect(cell, budget);
    report("warnings", smallFontWarning(cell, box, budget));
    report("warnings", longLabelWarning(cell, label, box, budget));
  }
}

class ValidationCellLimitExceeded extends Error {
  constructor(page: string, maxCells: number) {
    super(`page '${page}' exceeds the limit of ${maxCells} cells`);
  }
}

function checkPage(diagram: DomEl, budget: ValidationBudget, maxCells: number, result: ValidateResult): void {
  const name = attr(diagram, "name") ?? "?";
  const prefix = `page '${name}': `;
  const report: ReportFinding = (severity, message, kind) => {
    if (message === null) return;
    budget.diagnostic();
    result[severity].push(prefix + message);
    if (kind) {
      result.score[kind]++;
      result.score.total += SCORE_WEIGHTS[kind];
    }
  };
  if (diagram.tagName !== "mxGraphModel") budget.work(diagram.childNodes.length);
  const model = pageModel(diagram);
  if (!model) {
    budget.work(diagram.childNodes.length);
    if (directText(diagram).trim()) report("warnings", "compressed, skipped (cannot lint)");
    else report("errors", "no <mxGraphModel>");
    return;
  }
  budget.work(model.childNodes.length);
  const root = firstByTag(model, "root");
  if (!root) {
    report("errors", "<mxGraphModel> has no <root>");
    return;
  }
  const cells = collectCells(root, budget);
  if (cells.length > maxCells) throw new ValidationCellLimitExceeded(name, maxCells);

  const ids = buildIds(cells, budget, report);
  checkParentCycles(cells, ids, budget, report);
  const findings: Record<Severity, string[]> = { errors: [], warnings: [], observations: [] };
  // Keep each analyzer's error list separate: earlier errors must not affect the other analysis.
  const motionErrors: string[] = [];
  let animation, motion;
  try {
    animation = analyzeAnimationPage(diagram, budget, findings);
    motion = analyzeStoredMotion(model, budget, motionErrors);
  } finally {
    // Findings were charged at emission. Keep them even if the next charge interrupted a helper.
    for (const severity of ["errors", "warnings", "observations"] as const) {
      for (const message of findings[severity]) result[severity].push(prefix + message);
    }
    for (const message of motionErrors) result.errors.push(prefix + message);
  }
  if (motion) {
    if (motion.compiled) {
      report("observations", `stored motion has ${motion.spec!.steps.length} step(s) lasting ${Math.round(motion.compiled.sequenceMs)}ms; export it with drawio_animate`);
    }
    if (animation.sequence?.enabled) {
      report("errors", "page has both stored motion and an enabled native page animation; keep only one timeline");
    }
  }

  const parents = new Set<string | null>();
  for (const cell of cells) {
    budget.work();
    parents.add(attr(cell, "parent"));
    checkCell(cell, ids, budget, report);
  }
  overlapWarnings(cells, ids, parents, budget, report);
  const { visible, routed } = collectRoutes(cells, ids, budget);
  const leaves = collectLeafBoxes(cells, ids, parents, budget);
  routeThroughWarnings(routed, leaves, budget, report);
  routeCrossWarnings(routed, budget, report);
  for (const [cell, route] of visible) {
    budget.work();
    edgeAnchorFacingWarnings(cell, route, ids, budget, report);
  }
  checkEdgeLabels(cells, ids, visible, leaves, budget, report);
  for (const cell of cells) {
    budget.work();
    report("warnings", containmentWarning(cell, ids, budget));
  }
  readabilityWarnings(cells, budget, report);
  if (visible.size > routed.length) {
    predictedRouteThroughObservations(visible, ids, leaves, budget, report);
    report("warnings", autoRoutedEdgeWarning(visible, budget));
  }
  const { enabled, width, height } = pageSettings(model, report);
  if (enabled && width !== undefined && height !== undefined) {
    canvasWarnings(contentBounds(cells, ids, budget), width, height, report);
  }
}

function emptyResult(): ValidateResult {
  return {
    errors: [],
    warnings: [],
    observations: [],
    incomplete: false,
    score: { total: 0, through: 0, crossings: 0, overlaps: 0, anchors: 0 },
  };
}

function stopValidation(result: ValidateResult, reason: string): ValidateResult {
  result.incomplete = true;
  result.errors.push(`Validation incomplete: ${reason}`);
  return result;
}

function parseDiagram(xml: string, report: ReportFinding): DomEl | null {
  let reportFailure: unknown;
  let fatalReported = false;
  try {
    const doc = new DOMParser({
      onError(level, message) {
        try {
          report("errors", `XML parse error: ${message}`);
        } catch (error) {
          // xmldom wraps callback exceptions in ParseError without retaining their cause.
          reportFailure = error;
          throw error;
        }
        if (level === "fatalError") fatalReported = true;
      },
    }).parseFromString(xml, "text/xml");
    return doc.documentElement as unknown as DomEl;
  } catch (error) {
    if (reportFailure !== undefined) throw reportFailure;
    if (!(error instanceof ParseError)) throw error;
    if (!fatalReported) report("errors", `XML parse error: ${error.message}`);
    return null;
  }
}

/** Lint a `.drawio` XML string with a single diagnostic and work allowance across all pages. */
export function validateXml(xml: string, limits: Partial<ValidationLimits> = {}): ValidateResult {
  const maxBytes = limits.maxBytes ?? DEFAULT_LIMITS.maxBytes;
  const maxCells = limits.maxCellsPerPage ?? DEFAULT_LIMITS.maxCellsPerPage;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("XML byte limit must be a nonnegative safe integer");
  if (!Number.isSafeInteger(maxCells) || maxCells < 0) throw new RangeError("validation cell limit must be a nonnegative safe integer");
  const budget = createValidationBudget(limits.maxWork ?? DEFAULT_LIMITS.maxWork, limits.maxDiagnostics ?? DEFAULT_LIMITS.maxDiagnostics);
  const result = emptyResult();
  const report: ReportFinding = (severity, message) => {
    if (message === null) return;
    budget.diagnostic();
    result[severity].push(message);
  };
  try {
    if (Buffer.byteLength(xml, "utf8") > maxBytes) throw new DiagramXmlTooLargeError(maxBytes);
    const root = parseDiagram(xml, report);
    if (!root) return result;
    if (root.tagName === "mxfile") budget.work(root.childNodes.length);
    let pages: DomEl[];
    try {
      pages = diagramPages(root);
    } catch (error) {
      report("errors", (error as Error).message);
      return result;
    }
    if (pages.length === 0) report("errors", "diagram has no pages (expected a <diagram> inside <mxfile>)");
    for (const page of pages) {
      budget.work();
      checkPage(page, budget, maxCells, result);
    }
  } catch (error) {
    if (error instanceof ValidationBudgetExceeded || error instanceof ValidationCellLimitExceeded || error instanceof DiagramXmlTooLargeError) {
      return stopValidation(result, error.message);
    }
    throw error;
  }
  return result;
}

/** Read and lint a regular `.drawio` file within the same intake limits as the string validator. */
export async function validateFile(path: string, limits?: Partial<ValidationLimits>): Promise<ValidateResult> {
  let xml: string;
  try {
    xml = await readDiagramXml(path, limits?.maxBytes ?? DEFAULT_LIMITS.maxBytes);
  } catch (error) {
    const result = emptyResult();
    if (error instanceof DiagramXmlTooLargeError) return stopValidation(result, error.message);
    result.errors.push(`cannot read ${path}: ${(error as Error).message}`);
    return result;
  }
  try {
    return validateXml(xml, limits);
  } catch (error) {
    const result = emptyResult();
    result.errors.push(`cannot parse ${path}: ${(error as Error).message}`);
    return result;
  }
}
