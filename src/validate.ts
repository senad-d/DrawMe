/**
 * Deterministic structural linter for `.drawio` files. It rejects broken cell
 * contracts and reports conservative geometry/readability findings that can be
 * checked without rendering. Typography and automatically routed connectors
 * still require visual review.
 */
import { readFile } from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";
import { type DomEl, attr, childrenByTag, directText, firstByTag } from "./dom";
import {
  type ById,
  type ContentBounds,
  type Point,
  type Rect,
  absRect,
  collectCells,
  contentBounds,
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
  routePointAt,
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
  /** Readability score (lower is better); comparable only across variants of the same graph. */
  score: { total: number; through: number; crossings: number; overlaps: number; anchors: number };
}

/** Quote an optional attribute consistently in diagnostic messages. */
function repr(s: string | null): string {
  return s === null ? "None" : `'${s}'`;
}

function overlap(a: Rect, b: Rect): boolean {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

function styleHas(style: string | null, key: string, expected: string): boolean {
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

function routeHitsRect(points: Point[], box: Rect): boolean {
  const [x, y, w, h] = box;
  const corners: Point[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const borders: [Point, Point][] = corners.map((corner, index) => [corner, corners[(index + 1) % 4]]);
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (pointInRect(start, box) || pointInRect(end, box)) return true;
    for (const [a, b] of borders) if (segmentsCross(start, end, a, b)) return true;
  }
  return false;
}

function routesCross(a: Point[], b: Point[]): boolean {
  for (let i = 0; i < a.length - 1; i++)
    for (let j = 0; j < b.length - 1; j++)
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
  return false;
}

type RoutedEdge = [string | null, Point[], Set<string | null>];
type LeafBox = [string | null, Rect];

/** Edges with a resolvable waypointed route, tagged with their id and endpoint ids. */
function collectRoutedEdges(cells: DomEl[], ids: ById): RoutedEdge[] {
  const routed: RoutedEdge[] = [];
  for (const cell of cells) {
    if (cell.getAttribute("edge") === "1" && isVisible(cell, ids)) {
      const points = edgeRoute(cell, ids);
      if (points) routed.push([attr(cell, "id"), points, new Set([attr(cell, "source"), attr(cell, "target")])]);
    }
  }
  return routed;
}

/** Absolute boxes of leaf vertices (real nodes, not containers or edge labels). */
function collectLeafBoxes(cells: DomEl[], ids: ById, parents: Set<string | null>): LeafBox[] {
  const leaves: LeafBox[] = [];
  for (const cell of cells) {
    if (
      cell.getAttribute("vertex") === "1" &&
      !parents.has(attr(cell, "id")) &&
      !isEdgeLabel(cell) &&
      !geometryIsRelative(cell) &&
      isVisible(cell, ids)
    ) {
      const box = absRect(cell, ids);
      if (box) leaves.push([attr(cell, "id"), box]);
    }
  }
  return leaves;
}

function routeThroughWarnings(routed: RoutedEdge[], leaves: LeafBox[]): string[] {
  const warnings: string[] = [];
  for (const [edgeId, points, ends] of routed) {
    for (const [vertexId, box] of leaves) {
      if (!ends.has(vertexId) && routeHitsRect(points, box)) {
        warnings.push(`edge ${repr(edgeId)} routes through vertex ${repr(vertexId)}`);
      }
    }
  }
  return warnings;
}

function routeCrossWarnings(routed: RoutedEdge[]): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      if (routesCross(routed[i][1], routed[j][1])) {
        warnings.push(`edges ${repr(routed[i][0])} and ${repr(routed[j][0])} cross`);
      }
    }
  }
  return warnings;
}

type Side = "top" | "bottom" | "left" | "right";

/** Side containing a pinned connection point, or null for an interior, corner, or unpinned point. */
function pinnedSide(style: string, end: "source" | "target"): Side | null {
  const x = styleNum(style, end === "source" ? "exitX" : "entryX");
  const y = styleNum(style, end === "source" ? "exitY" : "entryY");
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
): string | null {
  const dx = direction.reference[0] - direction.center[0];
  const dy = direction.reference[1] - direction.center[1];
  const side = pinnedSide(style, direction.end);
  if (!side || !sideFacesAway(side, dx, dy, tolerance)) return null;
  const suggested = facingSide(dx, dy);
  const endLabel = direction.end === "source" ? "source exit" : "target entry";
  return `edge ${repr(attr(cell, "id"))}: ${endLabel} pinned to ${side} but ${direction.subject} is ${directionDescription(dx, dy)}; re-pin to ${suggested} (${sideStyleHint(suggested, direction.end)}) to shorten the route and reduce bends`;
}

/** Warn when a pinned border anchor faces away from its adjacent waypoint, or its peer when auto-routed. */
function edgeAnchorFacingWarnings(cell: DomEl, ids: ById): string[] {
  if (cell.getAttribute("edge") !== "1" || !isVisible(cell, ids)) return [];
  const sourceId = attr(cell, "source");
  const targetId = attr(cell, "target");
  if (!sourceId || !targetId) return [];
  const source = ids.get(sourceId);
  const target = ids.get(targetId);
  if (!source || !target || geometryIsRelative(source) || geometryIsRelative(target)) return [];
  const sourceBox = absRect(source, ids);
  const targetBox = absRect(target, ids);
  if (!sourceBox || !targetBox) return [];

  const sourceCenter = rectCenter(sourceBox);
  const targetCenter = rectCenter(targetBox);
  const route = edgeRoute(cell, ids);
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
  return directions
    .map((direction) => anchorDirectionWarning(cell, style, tolerance, direction))
    .filter((warning): warning is string => warning !== null);
}

function anchorFacingWarnings(cells: DomEl[], ids: ById): string[] {
  return cells.flatMap((cell) => edgeAnchorFacingWarnings(cell, ids));
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

function isDescendantOf(cell: DomEl, ancestorId: string | null, ids: ById): boolean {
  const seen = new Set<string>();
  let parent = attr(cell, "parent");
  while (parent && ids.has(parent) && !seen.has(parent)) {
    if (parent === ancestorId) return true;
    seen.add(parent);
    parent = attr(ids.get(parent)!, "parent");
  }
  return false;
}

function isTextAnnotation(cell: DomEl): boolean {
  return (attr(cell, "style") ?? "").split(";").some((token) => token.trim() === "text");
}

interface AutoRouteContext {
  edgeId: string | null;
  sourceId: string;
  targetId: string;
  sourcePoint: Point;
  targetPoint: Point;
}

function autoRouteContext(cell: DomEl, ids: ById): AutoRouteContext | null {
  if (cell.getAttribute("edge") !== "1" || !isVisible(cell, ids) || edgeWaypoints(cell).length > 0) return null;
  const sourceId = attr(cell, "source");
  const targetId = attr(cell, "target");
  if (!sourceId || !targetId) return null;
  const source = ids.get(sourceId);
  const target = ids.get(targetId);
  if (!source || !target || geometryIsRelative(source) || geometryIsRelative(target)) return null;
  const sourcePoint = endpoint(cell, "source", ids);
  const targetPoint = endpoint(cell, "target", ids);
  if (!sourcePoint || !targetPoint) return null;
  return { edgeId: attr(cell, "id"), sourceId, targetId, sourcePoint, targetPoint };
}

function routeThroughObservation(context: AutoRouteContext, leaf: LeafBox, ids: ById): string | null {
  const [vertexId, box] = leaf;
  if (vertexId === null || vertexId === context.sourceId || vertexId === context.targetId) return null;
  const vertex = ids.get(vertexId);
  if (!vertex || isTextAnnotation(vertex)) return null;
  if (isDescendantOf(vertex, context.sourceId, ids) || isDescendantOf(vertex, context.targetId, ids)) return null;
  if (!segmentPiercesRect(context.sourcePoint, context.targetPoint, box)) return null;
  return `edge ${repr(context.edgeId)} may pass over vertex ${repr(vertexId)} (predicted from the direct line; verify in the preview, then add waypoints or move the shape if needed)`;
}

function edgeRouteThroughObservations(cell: DomEl, ids: ById, leaves: LeafBox[]): string[] {
  const context = autoRouteContext(cell, ids);
  if (!context) return [];
  return leaves
    .map((leaf) => routeThroughObservation(context, leaf, ids))
    .filter((observation): observation is string => observation !== null);
}

/**
 * Identify auto-routed edges whose direct connection line pierces an unrelated
 * leaf vertex. This is only a preview-review hint because draw.io may route the
 * actual orthogonal connector around the shape.
 */
function predictedRouteThroughObservations(cells: DomEl[], ids: ById, leaves: LeafBox[]): string[] {
  return cells.flatMap((cell) => edgeRouteThroughObservations(cell, ids, leaves));
}

function geometryWarnings(cells: DomEl[], ids: ById, parents: Set<string | null>): string[] {
  const routed = collectRoutedEdges(cells, ids);
  const leaves = collectLeafBoxes(cells, ids, parents);
  return [...routeThroughWarnings(routed, leaves), ...routeCrossWarnings(routed), ...anchorFacingWarnings(cells, ids)];
}

/** Edges the route checks above cannot see: no explicit waypoints, so the renderer routes them blindly. */
function autoRoutedEdgeWarning(cells: DomEl[], ids: ById): string | null {
  const unrouted: string[] = [];
  for (const cell of cells) {
    if (cell.getAttribute("edge") === "1" && isVisible(cell, ids) && edgeRoute(cell, ids) === null) {
      unrouted.push(repr(attr(cell, "id")));
    }
  }
  if (unrouted.length === 0) return null;
  return (
    `${unrouted.length} auto-routed edge(s) cannot be route-checked (no explicit waypoints): ${unrouted.join(", ")}; ` +
    "add waypoints and pinned anchors, or verify their routing visually"
  );
}

/** Map every cell by id (blank key for id-less cells); report duplicate ids as errors. */
function buildIds(cells: DomEl[], errors: string[]): ById {
  const ids: ById = new Map();
  for (const cell of cells) {
    const id = attr(cell, "id");
    if (id !== null && ids.has(id)) errors.push(`duplicate id ${repr(id)}`);
    ids.set(id ?? "", cell);
  }
  return ids;
}

/** Geometry checks for a single non-edge-label, non-relative vertex. */
function checkVertexGeometry(cell: DomEl, id: string | null, errors: string[], warnings: string[]): void {
  const box = rect(cell);
  if (box === null || hasInvalidNumber(box)) {
    errors.push(`vertex ${repr(id)} has missing/invalid geometry`);
    return;
  }
  const [x, y, width, height] = box;
  if (width <= 0 || height <= 0) warnings.push(`vertex ${repr(id)} non-positive size ${String(width)}x${String(height)}`);
  if (x < 0 || y < 0) warnings.push(`vertex ${repr(id)} negative position (${String(x)},${String(y)})`);
}

function checkEdgeGeometry(cell: DomEl, id: string | null, errors: string[]): void {
  const geometry = firstByTag(cell, "mxGeometry");
  if (!geometry) {
    errors.push(`edge ${repr(id)} has missing geometry`);
    return;
  }
  if (attr(geometry, "relative") !== "1" || attr(geometry, "as") !== "geometry") {
    errors.push(`edge ${repr(id)} geometry must have relative='1' and as='geometry'`);
  }
}

function checkCellReferences(cell: DomEl, id: string | null, ids: ById, errors: string[]): void {
  const parent = attr(cell, "parent");
  if (parent !== null && !ids.has(parent)) errors.push(`cell ${repr(id)} parent ${repr(parent)} does not exist`);
  for (const end of ["source", "target"] as const) {
    const reference = attr(cell, end);
    if (reference && !ids.has(reference)) errors.push(`edge ${repr(id)} ${end} ${repr(reference)} does not exist`);
  }
}

/** Per-cell reference and geometry checks. */
function checkCell(cell: DomEl, ids: ById, errors: string[], warnings: string[]): void {
  const id = attr(cell, "id");
  const isVertex = cell.getAttribute("vertex") === "1";
  const isEdge = cell.getAttribute("edge") === "1";
  checkCellReferences(cell, id, ids, errors);
  if ((isVertex || isEdge) && id !== null && RESERVED.has(id)) errors.push(`cell ${repr(id)} reuses reserved id 0/1`);
  if (isVertex && !isEdgeLabel(cell) && !geometryIsRelative(cell)) checkVertexGeometry(cell, id, errors, warnings);
  if (isEdge) checkEdgeGeometry(cell, id, errors);
}

/** Sibling overlap: visible leaf vertices only (containers legitimately wrap children). */
function overlapWarnings(cells: DomEl[], ids: ById, parents: Set<string | null>): string[] {
  const boxes: [string | null, string | null, Rect][] = [];
  for (const cell of cells) {
    if (
      cell.getAttribute("vertex") === "1" &&
      !parents.has(attr(cell, "id")) &&
      !isEdgeLabel(cell) &&
      !geometryIsRelative(cell) &&
      isVisible(cell, ids)
    ) {
      const box = rect(cell);
      if (box && !hasInvalidNumber(box)) boxes.push([attr(cell, "id"), attr(cell, "parent"), box]);
    }
  }
  const warnings: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [aId, aParent, a] = boxes[i];
      const [bId, bParent, b] = boxes[j];
      if (aParent === bParent && overlap(a, b)) warnings.push(`vertices ${repr(aId)} and ${repr(bId)} overlap`);
    }
  }
  return warnings;
}

function isContainmentCandidate(cell: DomEl, ids: ById): boolean {
  return (
    cell.getAttribute("vertex") === "1" &&
    !geometryIsRelative(cell) &&
    !isEdgeLabel(cell) &&
    isVisible(cell, ids)
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

function containmentWarning(cell: DomEl, ids: ById): string | null {
  if (!isContainmentCandidate(cell, ids)) return null;
  const parentId = attr(cell, "parent");
  const parent = parentId ? ids.get(parentId) : undefined;
  if (parent?.getAttribute("vertex") !== "1" || !isVisible(parent, ids)) return null;
  const childBox = absRect(cell, ids);
  const parentBox = absRect(parent, ids);
  if (!childBox || !parentBox) return null;
  const sides = overflowSides(childBox, parentBox);
  if (sides.length === 0) return null;
  return `vertex ${repr(attr(cell, "id"))} extends beyond parent ${repr(parentId)} (${sides.join(", ")})`;
}

function containmentWarnings(cells: DomEl[], ids: ById): string[] {
  return cells
    .map((cell) => containmentWarning(cell, ids))
    .filter((warning): warning is string => warning !== null);
}

interface PageSettings {
  enabled: boolean;
  width?: number;
  height?: number;
  scale: number;
}

function pageSettings(model: DomEl, warnings: string[], observations: string[]): PageSettings {
  const enabled = attr(model, "page") !== "0";
  if (!enabled) {
    observations.push("page canvas is disabled (infinite canvas); boundary, margin, and empty-space checks skipped");
    return { enabled, scale: 1 };
  }

  const rawScale = attr(model, "pageScale");
  const parsedScale = rawScale === null ? 1 : pyFloat(rawScale);
  const scale = parsedScale && Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1;
  if (rawScale !== null && scale !== parsedScale) warnings.push(`invalid pageScale ${repr(rawScale)}; using 1`);

  const parseDimension = (name: "pageWidth" | "pageHeight"): number | undefined => {
    const raw = attr(model, name);
    if (raw === null) return undefined;
    const value = pyFloat(raw);
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      warnings.push(`invalid ${name} ${repr(raw)}; page-boundary checks skipped`);
      return undefined;
    }
    return value * scale;
  };
  const width = parseDimension("pageWidth");
  const height = parseDimension("pageHeight");
  if (width === undefined || height === undefined) {
    observations.push(
      "page dimensions are omitted or invalid; boundary, outer-margin, and empty-space checks require both pageWidth and pageHeight",
    );
  }
  return { enabled, width, height, scale };
}

function boundaryWarnings(bounds: ContentBounds, width: number, height: number): string[] {
  const warnings: string[] = [];
  if (bounds.minX < 0) warnings.push(`content extends beyond left page boundary by ${-bounds.minX}px`);
  if (bounds.minY < 0) warnings.push(`content extends beyond top page boundary by ${-bounds.minY}px`);
  if (bounds.maxX > width) warnings.push(`content extends beyond right page boundary by ${bounds.maxX - width}px`);
  if (bounds.maxY > height) warnings.push(`content extends beyond bottom page boundary by ${bounds.maxY - height}px`);
  return warnings;
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

function canvasWarnings(bounds: ContentBounds | null, settings: PageSettings): string[] {
  if (!bounds || !settings.enabled || settings.width === undefined || settings.height === undefined) return [];
  const { width, height } = settings;
  return [
    ...boundaryWarnings(bounds, width, height),
    outerMarginWarning(bounds, width, height),
    excessiveCanvasWarning(bounds, width, height),
  ].filter((warning): warning is string => warning !== null);
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
function stripLabelMarkup(value: string): string {
  const text: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
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

function labelText(cell: DomEl): string {
  return stripLabelMarkup(attr(cell, "value") ?? "").replaceAll("&nbsp;", " ").trim();
}

const DEFAULT_FONT_SIZE = 11;
const CHAR_WIDTH_FACTOR = 0.6;
const LINE_HEIGHT_FACTOR = 1.4;

function labelOffset(cell: DomEl): Point | null {
  const geometry = firstByTag(cell, "mxGeometry");
  const offset = geometry
    ? childrenByTag(geometry, "mxPoint").find((point) => attr(point, "as") === "offset")
    : undefined;
  if (!offset) return null;
  const x = pyFloat(attr(offset, "x") ?? "0");
  const y = pyFloat(attr(offset, "y") ?? "0");
  if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

/** Estimated box of an edge's inline label, centered on its explicit route like draw.io renders it. */
function inlineEdgeLabelRect(edge: DomEl, ids: ById): Rect | null {
  const label = labelText(edge);
  if (!label) return null;
  const route = edgeRoute(edge, ids);
  if (!route) return null;
  const geometry = firstByTag(edge, "mxGeometry");
  const along = geometry ? pyFloat(attr(geometry, "x") ?? "0") : 0;
  const fraction = along !== undefined && Number.isFinite(along) ? Math.min(1, Math.max(0, (along + 1) / 2)) : 0.5;
  const [centerX, centerY] = routePointAt(route, fraction);
  const [offsetX, offsetY] = labelOffset(edge) ?? [0, 0];
  const fontSize = styleNum(attr(edge, "style"), "fontSize") ?? DEFAULT_FONT_SIZE;
  const lines = label.split("\n");
  const width = Math.max(...lines.map((line) => line.length)) * fontSize * CHAR_WIDTH_FACTOR;
  const height = lines.length * fontSize * LINE_HEIGHT_FACTOR;
  return [centerX + offsetX - width / 2, centerY + offsetY - height / 2, width, height];
}

function edgeLabelBox(cell: DomEl, ids: ById): [string | null, Rect] | null {
  if (cell.getAttribute("edge") === "1") {
    const box = inlineEdgeLabelRect(cell, ids);
    return box ? [attr(cell, "id"), box] : null;
  }
  if (isEdgeLabel(cell) && labelText(cell)) {
    const box = explicitEdgeLabelRect(cell, ids);
    return box ? [attr(cell, "id"), box] : null;
  }
  return null;
}

/** Edge-label text lying on top of a shape; sizes are estimated, so phrased as "likely". */
function labelOverlapWarnings(cells: DomEl[], ids: ById, parents: Set<string | null>): string[] {
  const leaves = collectLeafBoxes(cells, ids, parents);
  const warnings: string[] = [];
  for (const cell of cells) {
    if (!isVisible(cell, ids)) continue;
    const labeled = edgeLabelBox(cell, ids);
    if (!labeled || hasInvalidNumber(labeled[1])) continue;
    const [id, box] = labeled;
    for (const [vertexId, vertexBox] of leaves) {
      if (overlap(box, vertexBox)) warnings.push(`edge label ${repr(id)} likely overlaps vertex ${repr(vertexId)}`);
    }
  }
  return warnings;
}

function labelOnLineWarning(cell: DomEl): string | null {
  if (cell.getAttribute("edge") !== "1" || !labelText(cell)) return null;
  if ((attr(cell, "style") ?? "").includes("labelBackgroundColor=")) return null;
  if (labelOffset(cell)) return null;
  return `edge ${repr(attr(cell, "id"))} label sits directly on its line; add an offset or labelBackgroundColor`;
}

function isCompactBorderPort(cell: DomEl, box: Rect | null): boolean {
  return (
    cell.getAttribute("vertex") === "1" &&
    geometryIsRelative(cell) &&
    !isEdgeLabel(cell) &&
    box !== null &&
    !hasInvalidNumber(box) &&
    box[2] <= 30 &&
    box[3] <= 30
  );
}

function smallFontWarning(cell: DomEl, box: Rect | null): string | null {
  const fontSize = styleNum(attr(cell, "style"), "fontSize");
  const isEdgeText = cell.getAttribute("edge") === "1" || isEdgeLabel(cell);
  const minimum = isEdgeText ? 10 : 11;
  if (
    isCompactBorderPort(cell, box) ||
    fontSize === undefined ||
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    fontSize >= minimum
  ) {
    return null;
  }
  return `${isEdgeText ? "connector label" : "vertex"} ${repr(attr(cell, "id"))} has very small explicit fontSize ${fontSize}px`;
}

function longLabelWarning(cell: DomEl, label: string, box: Rect | null): string | null {
  if (cell.getAttribute("vertex") !== "1" || isEdgeLabel(cell) || geometryIsRelative(cell)) return null;
  if (box === null || hasInvalidNumber(box)) return null;
  const oneLineLength = label.replaceAll("\n", "").length;
  if (
    oneLineLength <= 32 ||
    label.includes("\n") ||
    box[2] >= 160 ||
    styleHas(attr(cell, "style"), "whiteSpace", "wrap")
  ) {
    return null;
  }
  return `vertex ${repr(attr(cell, "id"))} has a long label in narrow geometry without whiteSpace=wrap`;
}

function cellReadabilityWarnings(cell: DomEl): string[] {
  const label = labelText(cell);
  if (!label) return [];
  const box = rect(cell);
  return [smallFontWarning(cell, box), longLabelWarning(cell, label, box), labelOnLineWarning(cell)].filter(
    (warning): warning is string => warning !== null,
  );
}

/** Conservative static checks only; uncertain typography remains a visual concern. */
function readabilityWarnings(cells: DomEl[]): string[] {
  return cells.flatMap(cellReadabilityWarnings);
}

function withPage(name: string, diagnostics: string[]): string[] {
  return diagnostics.map((diagnostic) => `page '${name}': ${diagnostic}`);
}

function checkPage(diagram: DomEl): [string[], string[], string[]] {
  const name = attr(diagram, "name") ?? "?";
  const model = firstByTag(diagram, "mxGraphModel");
  if (!model) {
    if (directText(diagram).trim()) return [[], [`page '${name}': compressed, skipped (cannot lint)`], []];
    return [[`page '${name}': no <mxGraphModel>`], [], []];
  }
  const cells = collectCells(firstByTag(model, "root"));

  const errors: string[] = [];
  const warnings: string[] = [];
  const observations: string[] = [];
  const ids = buildIds(cells, errors);
  const parents = new Set<string | null>();
  for (const cell of cells) parents.add(attr(cell, "parent"));

  for (const cell of cells) checkCell(cell, ids, errors, warnings);
  warnings.push(
    ...overlapWarnings(cells, ids, parents),
    ...geometryWarnings(cells, ids, parents),
    ...labelOverlapWarnings(cells, ids, parents),
    ...containmentWarnings(cells, ids),
    ...readabilityWarnings(cells),
  );
  observations.push(...predictedRouteThroughObservations(cells, ids, collectLeafBoxes(cells, ids, parents)));
  const autoRouted = autoRoutedEdgeWarning(cells, ids);
  if (autoRouted) warnings.push(autoRouted);
  const settings = pageSettings(model, warnings, observations);
  warnings.push(...canvasWarnings(contentBounds(cells, ids), settings));
  return [withPage(name, errors), withPage(name, warnings), withPage(name, observations)];
}

/** Lint a `.drawio` XML string. Throws only on unrecoverable parse failure. */
export function validateXml(xml: string): ValidateResult {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement as unknown as DomEl | null;
  if (!root) throw new Error("no root element (malformed XML)");
  const pageList = childrenByTag(root, "diagram");
  const pages = pageList.length > 0 ? pageList : [root];

  const errors: string[] = [];
  const warnings: string[] = [];
  const observations: string[] = [];
  for (const page of pages) {
    const [pageErrors, pageWarnings, pageObservations] = checkPage(page);
    errors.push(...pageErrors);
    warnings.push(...pageWarnings);
    observations.push(...pageObservations);
  }
  const through = warnings.filter((warning) => warning.includes("routes through")).length;
  const crossings = warnings.filter((warning) => warning.endsWith(" cross")).length;
  const overlaps = warnings.filter((warning) => warning.endsWith(" overlap")).length;
  const anchors = warnings.filter((warning) => warning.endsWith("reduce bends")).length;
  return {
    errors,
    warnings,
    observations,
    score: { total: 20 * through + 10 * crossings + 5 * overlaps + 8 * anchors, through, crossings, overlaps, anchors },
  };
}

function emptyScore(): ValidateResult["score"] {
  return { total: 0, through: 0, crossings: 0, overlaps: 0, anchors: 0 };
}

/** Read and lint a `.drawio` file. Read/parse failures are returned as errors, never thrown. */
export async function validateFile(path: string): Promise<ValidateResult> {
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch (error) {
    return {
      errors: [`cannot read ${path}: ${(error as Error).message}`],
      warnings: [],
      observations: [],
      score: emptyScore(),
    };
  }
  try {
    return validateXml(xml);
  } catch (error) {
    return {
      errors: [`cannot parse ${path}: ${(error as Error).message}`],
      warnings: [],
      observations: [],
      score: emptyScore(),
    };
  }
}
