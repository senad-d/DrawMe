/**
 * Shared `.drawio` geometry: cell collection, absolute rectangles, explicit
 * edge routes, and visible content bounds. Used by the structural validator
 * and the canvas-fit tool so both agree on what "content" means.
 */
import { type DomEl, attr, ELEMENT_NODE } from "./dom";
import type { ValidationBudget } from "./validation-budget";

/** [x, y, width, height]. width/height may be NaN when the source omits them. */
export type Rect = [number, number, number, number];
export type Point = [number, number];
export type ById = Map<string, DomEl>;

export interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Python `float()` semantics: accepts nan/inf, strict-numeric otherwise; else undefined (≈ ValueError). */
export function pyFloat(s: string): number | undefined {
  const t = s.trim().toLowerCase();
  if (t === "nan" || t === "+nan" || t === "-nan") return Number.NaN;
  if (t === "inf" || t === "+inf" || t === "infinity" || t === "+infinity") return Infinity;
  if (t === "-inf" || t === "-infinity") return -Infinity;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isNaN(n) ? undefined : n;
}

export function hasInvalidNumber(values: number[]): boolean {
  return values.some((value) => !Number.isFinite(value));
}

// Visit children lazily: an eager DOM helper could scan a large sibling list before the budget is checked.
function* geometryChildren(el: DomEl, budget?: ValidationBudget): Iterable<DomEl> {
  for (let i = 0; i < el.childNodes.length; i++) {
    budget?.work();
    const child = el.childNodes[i];
    if (child?.nodeType === ELEMENT_NODE) yield child;
  }
}

function geometryChild(el: DomEl, tag: string, budget?: ValidationBudget, role?: string): DomEl | null {
  for (const child of geometryChildren(el, budget)) {
    if (child.tagName === tag && (role === undefined || attr(child, "as") === role)) return child;
  }
  return null;
}

function geometryRect(gy: DomEl): Rect | null {
  const x = pyFloat(attr(gy, "x") ?? "0");
  const y = pyFloat(attr(gy, "y") ?? "0");
  const w = pyFloat(attr(gy, "width") ?? "nan");
  const h = pyFloat(attr(gy, "height") ?? "nan");
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return [x, y, w, h];
}

export function rect(cell: DomEl, budget?: ValidationBudget): Rect | null {
  const gy = geometryChild(cell, "mxGeometry", budget);
  return gy ? geometryRect(gy) : null;
}

export function geometryIsRelative(cell: DomEl, budget?: ValidationBudget): boolean {
  return geometryChild(cell, "mxGeometry", budget)?.getAttribute("relative") === "1";
}

/** True for separate edge-label vertices. */
export function isEdgeLabel(cell: DomEl): boolean {
  return (attr(cell, "style") ?? "").includes("edgeLabel");
}

export function isVisible(cell: DomEl, byId: ById, budget?: ValidationBudget): boolean {
  let current: DomEl | undefined = cell;
  const seen = new Set<string>();
  while (current) {
    budget?.work();
    if (attr(current, "visible") === "0") return false;
    const parent = attr(current, "parent");
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    current = byId.get(parent);
  }
  return true;
}

export function styleNum(style: string | null, key: string, budget?: ValidationBudget): number | undefined {
  if (!style) return undefined;
  const prefix = key + "=";
  let start = 0;
  while (start < style.length) {
    budget?.work();
    const end = style.indexOf(";", start);
    const limit = end === -1 ? style.length : end;
    if (start + prefix.length <= limit && style.startsWith(prefix, start)) {
      return pyFloat(style.slice(start + prefix.length, limit));
    }
    start = limit + 1;
  }
  return undefined;
}

/** Accumulated origin of a cell's ancestor containers — the offset from parent-relative to absolute coordinates. */
export function parentOrigin(cell: DomEl, byId: ById, budget?: ValidationBudget): Point {
  let dx = 0;
  let dy = 0;
  let parent = attr(cell, "parent");
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    budget?.work();
    const p = byId.get(parent);
    if (!p) break;
    seen.add(parent);
    if (p.getAttribute("vertex") === "1") {
      const gy = geometryChild(p, "mxGeometry", budget);
      const pr = gy && attr(gy, "relative") !== "1" ? geometryRect(gy) : null;
      if (pr && !hasInvalidNumber(pr)) {
        dx += pr[0];
        dy += pr[1];
      }
    }
    parent = attr(p, "parent");
  }
  return [dx, dy];
}

/** Absolute (x, y, w, h) of a non-relative vertex, summing parent-container offsets. */
export function absRect(cell: DomEl, byId: ById, budget?: ValidationBudget): Rect | null {
  const r = rect(cell, budget);
  if (r === null || hasInvalidNumber(r)) return null;
  const [ox, oy] = parentOrigin(cell, byId, budget);
  return [r[0] + ox, r[1] + oy, r[2], r[3]];
}

function readPoint(point: DomEl, defaultCoordinate: string): Point | null {
  const x = pyFloat(attr(point, "x") ?? defaultCoordinate);
  const y = pyFloat(attr(point, "y") ?? defaultCoordinate);
  return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

function geometryPoint(geometry: DomEl, role: string, budget?: ValidationBudget): Point | null {
  const point = geometryChild(geometry, "mxPoint", budget, role);
  return point ? readPoint(point, "0") : null;
}

type EdgeEnd = "source" | "target";

/** Absolute free terminal point, or attachment position on the connected vertex (honours exit/entry). */
export function endpoint(edge: DomEl, end: EdgeEnd, byId: ById, budget?: ValidationBudget): Point | null {
  const vid = attr(edge, end);
  if (!vid) {
    const geometry = geometryChild(edge, "mxGeometry", budget);
    const local = geometry && geometryPoint(geometry, `${end}Point`, budget);
    if (!local) return null;
    const [ox, oy] = parentOrigin(edge, byId, budget);
    return [local[0] + ox, local[1] + oy];
  }
  const vertex = byId.get(vid);
  const box = vertex && absRect(vertex, byId, budget);
  if (!box) return null;
  const [x, y, w, h] = box;
  const style = attr(edge, "style");
  const fx = styleNum(style, end === "source" ? "exitX" : "entryX", budget);
  const fy = styleNum(style, end === "source" ? "exitY" : "entryY", budget);
  return [x + (fx ?? 0.5) * w, y + (fy ?? 0.5) * h];
}

function geometryWaypoints(gy: DomEl, budget?: ValidationBudget): Point[] {
  const arr = geometryChild(gy, "Array", budget);
  if (!arr) return [];
  const points: Point[] = [];
  for (const point of geometryChildren(arr, budget)) {
    if (point.tagName !== "mxPoint") continue;
    const xy = readPoint(point, "");
    if (xy) points.push(xy);
  }
  return points;
}

export function edgeWaypoints(edge: DomEl, budget?: ValidationBudget): Point[] {
  const gy = geometryChild(edge, "mxGeometry", budget);
  return gy ? geometryWaypoints(gy, budget) : [];
}

/** Absolute polyline for a waypointed edge, or null when auto-routed / unresolved. Waypoints are stored relative to the edge's parent. */
export function edgeRoute(edge: DomEl, byId: ById, budget?: ValidationBudget): Point[] | null {
  const waypoints = edgeWaypoints(edge, budget);
  if (waypoints.length === 0) return null;
  const source = endpoint(edge, "source", byId, budget);
  const target = endpoint(edge, "target", byId, budget);
  if (source === null || target === null) return null;
  const [ox, oy] = parentOrigin(edge, byId, budget);
  const route: Point[] = [source];
  for (const waypoint of waypoints) {
    budget?.work();
    const [x, y] = waypoint;
    route.push([x + ox, y + oy]);
  }
  route.push(target);
  return route;
}

function routePosition(points: Point[], fraction: number, budget?: ValidationBudget): { point: Point; normal: Point } {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    budget?.work();
    const length = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    lengths.push(length);
    total += length;
  }
  const distance = Math.min(1, Math.max(0, fraction)) * total;
  let traversed = 0;
  for (let i = 0; i < lengths.length; i++) {
    budget?.work();
    const length = lengths[i];
    if (length === 0) continue;
    const end = traversed + length;
    // At a bend use the outgoing segment; at the end use the last nonzero one.
    if (distance < end || end === total) {
      const t = (distance - traversed) / length;
      const dx = points[i + 1][0] - points[i][0];
      const dy = points[i + 1][1] - points[i][1];
      return {
        point: [points[i][0] + t * dx, points[i][1] + t * dy],
        normal: [dy / length, -dx / length],
      };
    }
    traversed = end;
  }
  return { point: points.at(-1) ?? [0, 0], normal: [0, 0] };
}

/** Point at `fraction` (0..1) of the route's arc length. */
export function routePointAt(points: Point[], fraction: number, budget?: ValidationBudget): Point {
  return routePosition(points, fraction, budget).point;
}

export function routeMidpoint(points: Point[], budget?: ValidationBudget): Point {
  return routePointAt(points, 0.5, budget);
}

/** Compose relative x (-1..1 along the route), signed normal y, and explicit x/y offset. */
export function edgeLabelAnchor(cell: DomEl, route: Point[], budget?: ValidationBudget): Point {
  const geometry = geometryChild(cell, "mxGeometry", budget);
  const x = geometry ? pyFloat(attr(geometry, "x") ?? "0") : undefined;
  const y = geometry ? pyFloat(attr(geometry, "y") ?? "0") : undefined;
  const fraction = x !== undefined && Number.isFinite(x) ? (x + 1) / 2 : 0.5;
  const normalDistance = y !== undefined && Number.isFinite(y) ? y : 0;
  const { point, normal } = routePosition(route, fraction, budget);
  const [offsetX, offsetY] = (geometry && geometryPoint(geometry, "offset", budget)) ?? [0, 0];
  return [point[0] + normal[0] * normalDistance + offsetX, point[1] + normal[1] * normalDistance + offsetY];
}

/** Conservative box for a separately sized label on an explicitly routed edge. */
export function explicitEdgeLabelRect(cell: DomEl, byId: ById, budget?: ValidationBudget): Rect | null {
  if (!isEdgeLabel(cell)) return null;
  const local = rect(cell, budget);
  const parent = attr(cell, "parent");
  const edge = parent ? byId.get(parent) : undefined;
  if (!local || hasInvalidNumber(local) || edge?.getAttribute("edge") !== "1") return null;
  const route = edgeRoute(edge, byId, budget);
  if (!route) return null;
  const [x, y] = edgeLabelAnchor(cell, route, budget);
  return [x - local[2] / 2, y - local[3] / 2, local[2], local[3]];
}

function* graphCells(root: DomEl | null, budget?: ValidationBudget): Iterable<{ cell: DomEl; wrapper?: DomEl }> {
  if (!root) return;
  for (const child of geometryChildren(root, budget)) {
    if (child.tagName === "mxCell") yield { cell: child };
    else if (child.tagName === "UserObject" || child.tagName === "object") {
      const inner = geometryChild(child, "mxCell", budget);
      if (inner) yield { cell: inner, wrapper: child };
    }
  }
}

/** Analysis only: materialize wrapper IDs and values on their inner cells. Do not serialize this DOM. */
export function collectCells(root: DomEl | null, budget?: ValidationBudget): DomEl[] {
  const cells: DomEl[] = [];
  for (const { cell, wrapper } of graphCells(root, budget)) {
    if (wrapper) {
      cell.setAttribute("id", attr(wrapper, "id") ?? "");
      const label = attr(wrapper, "label") ?? attr(wrapper, "value");
      if (label !== null) cell.setAttribute("value", label);
    }
    cells.push(cell);
  }
  return cells;
}

/** Non-mutating collection for callers that serialize; wrapper IDs resolve through the map. */
export function collectCellsWithIds(root: DomEl | null, budget?: ValidationBudget): { cells: DomEl[]; ids: ById } {
  const cells: DomEl[] = [];
  const ids: ById = new Map();
  for (const { cell, wrapper } of graphCells(root, budget)) {
    cells.push(cell);
    ids.set(attr(wrapper ?? cell, "id") ?? "", cell);
  }
  return { cells, ids };
}

export function addRectToBounds(bounds: ContentBounds | null, box: Rect): ContentBounds {
  const [x, y, width, height] = box;
  const next = bounds ?? { minX: x, minY: y, maxX: x + width, maxY: y + height };
  next.minX = Math.min(next.minX, x);
  next.minY = Math.min(next.minY, y);
  next.maxX = Math.max(next.maxX, x + width);
  next.maxY = Math.max(next.maxY, y + height);
  return next;
}

export function addPointToBounds(bounds: ContentBounds | null, point: Point): ContentBounds {
  return addRectToBounds(bounds, [point[0], point[1], 0, 0]);
}

export function contentRect(cell: DomEl, ids: ById, budget?: ValidationBudget): Rect | null {
  if (cell.getAttribute("vertex") !== "1") return null;
  if (isEdgeLabel(cell)) return explicitEdgeLabelRect(cell, ids, budget);
  if (geometryIsRelative(cell, budget)) return null;
  return absRect(cell, ids, budget);
}

export function contentWaypoints(cell: DomEl, budget?: ValidationBudget): Point[] {
  return cell.getAttribute("edge") === "1" ? edgeWaypoints(cell, budget) : [];
}

function localEdgeContent(edge: DomEl, budget?: ValidationBudget): Point[] {
  const geometry = geometryChild(edge, "mxGeometry", budget);
  if (!geometry) return [];
  const points = geometryWaypoints(geometry, budget);
  for (const end of ["source", "target"] as const) {
    // A geometry terminal point is ignored when that end names a connected cell.
    const point = !attr(edge, end) && geometryPoint(geometry, `${end}Point`, budget);
    if (point) points.push(point);
  }
  return points;
}

/** Visible vertices/containers and edge-label boxes, plus explicit waypoints and free terminals. */
export function contentBounds(cells: DomEl[], ids: ById, budget?: ValidationBudget): ContentBounds | null {
  let bounds: ContentBounds | null = null;
  for (const cell of cells) {
    budget?.work();
    if (!isVisible(cell, ids, budget)) continue;
    const box = contentRect(cell, ids, budget);
    if (box && !hasInvalidNumber(box)) bounds = addRectToBounds(bounds, box);
    if (cell.getAttribute("edge") !== "1") continue;
    const points = localEdgeContent(cell, budget);
    if (points.length > 0) {
      const [ox, oy] = parentOrigin(cell, ids, budget);
      for (const point of points) {
        budget?.work();
        const [x, y] = point;
        bounds = addPointToBounds(bounds, [x + ox, y + oy]);
      }
    }
  }
  return bounds;
}
