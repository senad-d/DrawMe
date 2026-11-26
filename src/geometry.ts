/**
 * Shared `.drawio` geometry: cell collection, absolute rectangles, explicit
 * edge routes, and visible content bounds. Used by the structural validator
 * and the canvas-fit tool so both agree on what "content" means.
 */
import { type DomEl, attr, childrenByTag, elemChildren, firstByTag } from "./dom";

/** [x, y, width, height]. width/height may be NaN when the source omits them. */
export type Rect = [number, number, number, number];
export type Point = [number, number];
export type ById = Map<string, DomEl>;
export type ChargeWork = (n?: number) => void;

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

function geometryOf(cell: DomEl, chargeWork?: ChargeWork): DomEl | null {
  // firstByTag enumerates the direct children before looking for a match.
  chargeWork?.(cell.childNodes.length);
  return firstByTag(cell, "mxGeometry");
}

export function rect(cell: DomEl, chargeWork?: ChargeWork): Rect | null {
  const gy = geometryOf(cell, chargeWork);
  return gy ? geometryRect(gy) : null;
}

function geometryRect(gy: DomEl): Rect | null {
  const x = pyFloat(attr(gy, "x") ?? "0");
  const y = pyFloat(attr(gy, "y") ?? "0");
  const w = pyFloat(attr(gy, "width") ?? "nan");
  const h = pyFloat(attr(gy, "height") ?? "nan");
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return [x, y, w, h];
}

export function geometryIsRelative(cell: DomEl, chargeWork?: ChargeWork): boolean {
  return geometryOf(cell, chargeWork)?.getAttribute("relative") === "1";
}

/** True for separate edge-label vertices. */
export function isEdgeLabel(cell: DomEl): boolean {
  return (attr(cell, "style") ?? "").includes("edgeLabel");
}

export function isVisible(cell: DomEl, byId: ById, chargeWork?: ChargeWork): boolean {
  let current: DomEl | undefined = cell;
  const seen = new Set<string>();
  while (current) {
    chargeWork?.();
    if (attr(current, "visible") === "0") return false;
    const parent = attr(current, "parent");
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    current = byId.get(parent);
  }
  return true;
}

export function styleNum(style: string | null, key: string, chargeWork?: ChargeWork): number | undefined {
  const prefix = key + "=";
  // Charge the split before it allocates, in addition to inspecting each entry.
  chargeWork?.(Math.ceil((style?.length ?? 0) / 64));
  for (const part of (style ?? "").split(";")) {
    chargeWork?.();
    if (part.startsWith(prefix)) return pyFloat(part.slice(prefix.length));
  }
  return undefined;
}

/** Accumulated origin of a cell's ancestor containers — the offset from parent-relative to absolute coordinates. */
export function parentOrigin(cell: DomEl, byId: ById, chargeWork?: ChargeWork): Point {
  let dx = 0;
  let dy = 0;
  let parent = attr(cell, "parent");
  const seen = new Set<string>();
  while (parent && byId.has(parent) && !seen.has(parent)) {
    chargeWork?.();
    seen.add(parent);
    const p = byId.get(parent)!;
    if (p.getAttribute("vertex") === "1") {
      const geometry = geometryOf(p, chargeWork);
      if (geometry && attr(geometry, "relative") !== "1") {
        const pr = geometryRect(geometry);
        if (pr && !hasInvalidNumber(pr)) {
          dx += pr[0];
          dy += pr[1];
        }
      }
    }
    parent = attr(p, "parent");
  }
  return [dx, dy];
}

/** Absolute (x, y, w, h) of a non-relative vertex, summing parent-container offsets. */
export function absRect(cell: DomEl, byId: ById, chargeWork?: ChargeWork): Rect | null {
  const r = rect(cell, chargeWork);
  if (r === null || hasInvalidNumber(r)) return null;
  return translateRect(r, parentOrigin(cell, byId, chargeWork));
}

function translateRect([x, y, w, h]: Rect, [ox, oy]: Point): Rect {
  return [x + ox, y + oy, w, h];
}

/** Absolute point where `edge` meets its source/target vertex (honours exit/entry). */
export function endpoint(edge: DomEl, end: "source" | "target", byId: ById, chargeWork?: ChargeWork): Point | null {
  const vid = attr(edge, end);
  if (!vid || !byId.has(vid)) return null;
  const box = absRect(byId.get(vid)!, byId, chargeWork);
  if (box === null) return null;
  const [x, y, w, h] = box;
  const style = attr(edge, "style");
  const fx = styleNum(style, end === "source" ? "exitX" : "entryX", chargeWork);
  const fy = styleNum(style, end === "source" ? "exitY" : "entryY", chargeWork);
  return [x + (fx ?? 0.5) * w, y + (fy ?? 0.5) * h];
}

function pointCoordinates(point: DomEl, missing = "0"): Point | null {
  const x = pyFloat(attr(point, "x") ?? missing);
  const y = pyFloat(attr(point, "y") ?? missing);
  return x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

export function edgeWaypoints(edge: DomEl, chargeWork?: ChargeWork): Point[] {
  const gy = geometryOf(edge, chargeWork);
  if (!gy) return [];
  chargeWork?.(gy.childNodes.length);
  const arr = firstByTag(gy, "Array");
  if (!arr) return [];
  chargeWork?.(arr.childNodes.length);
  const points: Point[] = [];
  for (const point of childrenByTag(arr, "mxPoint")) {
    chargeWork?.();
    const coords = pointCoordinates(point, "");
    if (coords) points.push(coords);
  }
  return points;
}

/** Parent-local terminal points, ignoring saved coordinates for attached ends. */
function floatingTerminals(edge: DomEl, chargeWork?: ChargeWork): Point[] {
  const freeSource = !attr(edge, "source");
  const freeTarget = !attr(edge, "target");
  if (!freeSource && !freeTarget) return [];
  const geometry = geometryOf(edge, chargeWork);
  if (!geometry) return [];
  chargeWork?.(geometry.childNodes.length);
  let source: Point | null = null;
  let target: Point | null = null;
  for (const point of childrenByTag(geometry, "mxPoint")) {
    chargeWork?.();
    const role = attr(point, "as");
    if (freeSource && role === "sourcePoint") source = pointCoordinates(point);
    if (freeTarget && role === "targetPoint") target = pointCoordinates(point);
  }
  return [source, target].filter((point) => point !== null);
}

/** Absolute polyline for a waypointed edge, or null when auto-routed / unresolved. Waypoints are stored relative to the edge's parent. */
export function edgeRoute(edge: DomEl, byId: ById, chargeWork?: ChargeWork): Point[] | null {
  const waypoints = edgeWaypoints(edge, chargeWork);
  if (waypoints.length === 0) return null;
  const source = endpoint(edge, "source", byId, chargeWork);
  const target = endpoint(edge, "target", byId, chargeWork);
  if (source === null || target === null) return null;
  const [ox, oy] = parentOrigin(edge, byId, chargeWork);
  chargeWork?.(waypoints.length);
  return [source, ...waypoints.map(([x, y]): Point => [x + ox, y + oy]), target];
}

/** Find a point along the polyline and move it along the segment's oriented normal. */
function displacedRoutePoint(points: Point[], fraction: number, normal: number, chargeWork?: ChargeWork): Point | null {
  if (points.length === 0 || !Number.isFinite(fraction)) return null;
  const lengths: number[] = [];
  let total = 0;
  let last = -1;
  for (let i = 0; i < points.length - 1; i++) {
    chargeWork?.();
    const length = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    lengths.push(length);
    total += length;
    if (length > 0) last = i;
  }
  if (!Number.isFinite(total) || hasInvalidNumber(points[0])) return null;
  let remaining = total * fraction;
  for (let i = 0; i <= last; i++) {
    chargeWork?.();
    const length = lengths[i];
    if (length === 0) continue;
    // At a bend, take the outgoing segment. Skip coincident points so the normal remains defined.
    if (remaining < length || i === last) {
      const [x, y] = points[i];
      const dx = points[i + 1][0] - x;
      const dy = points[i + 1][1] - y;
      const along = Math.min(1, remaining / length);
      return [x + dx * along + (dy / length) * normal, y + dy * along - (dx / length) * normal];
    }
    remaining -= length;
  }
  return points[0];
}

/** Point at `fraction` (0..1) of the route's arc length. */
export function routePointAt(points: Point[], fraction: number, chargeWork?: ChargeWork): Point {
  return displacedRoutePoint(points, fraction, 0, chargeWork) ?? points.at(-1) ?? [0, 0];
}

export function routeMidpoint(points: Point[], chargeWork?: ChargeWork): Point {
  return routePointAt(points, 0.5, chargeWork);
}

/** Absolute anchor for an inline or child edge label on a resolved route. */
export function edgeLabelAnchor(cell: DomEl, route: Point[], chargeWork?: ChargeWork): Point | null {
  const geometry = geometryOf(cell, chargeWork);
  const relative = geometry && attr(geometry, "relative") === "1";
  const local = relative ? pointCoordinates(geometry) : [0, 0];
  if (!local) return null;
  const [along, normal] = local;
  const fraction = Math.min(1, Math.max(0, (along + 1) / 2));
  const anchor = displacedRoutePoint(route, fraction, normal, chargeWork);
  if (!anchor) return null;
  let offset: Point = [0, 0];
  if (geometry) {
    chargeWork?.(geometry.childNodes.length);
    const point = childrenByTag(geometry, "mxPoint").find((candidate) => attr(candidate, "as") === "offset");
    if (point) {
      const coords = pointCoordinates(point);
      if (!coords) return null;
      offset = coords;
    }
  }
  const result: Point = [anchor[0] + offset[0], anchor[1] + offset[1]];
  return hasInvalidNumber(result) ? null : result;
}

/** Conservative box for a separately sized label on an explicitly routed edge. */
export function explicitEdgeLabelRect(cell: DomEl, byId: ById, chargeWork?: ChargeWork): Rect | null {
  if (!isEdgeLabel(cell)) return null;
  const local = rect(cell, chargeWork);
  const parent = attr(cell, "parent");
  const edge = parent ? byId.get(parent) : undefined;
  if (!local || hasInvalidNumber(local) || edge?.getAttribute("edge") !== "1") return null;
  const route = edgeRoute(edge, byId, chargeWork);
  const anchor = route && edgeLabelAnchor(cell, route, chargeWork);
  return anchor ? [anchor[0] - local[2] / 2, anchor[1] - local[3] / 2, local[2], local[3]] : null;
}

function* graphCells(root: DomEl | null, chargeWork?: ChargeWork): Generator<[cell: DomEl, wrapper: DomEl | null]> {
  if (!root) return;
  chargeWork?.(root.childNodes.length);
  for (const child of elemChildren(root)) {
    chargeWork?.();
    if (child.tagName === "mxCell") yield [child, null];
    else if (child.tagName === "UserObject" || child.tagName === "object") {
      chargeWork?.(child.childNodes.length);
      const inner = firstByTag(child, "mxCell");
      if (inner) yield [inner, child];
    }
  }
}

/** Analysis only: materialize wrapper ids and labels on their inner mxCells. */
export function collectCells(root: DomEl | null, chargeWork?: ChargeWork): DomEl[] {
  const cells: DomEl[] = [];
  for (const [cell, wrapper] of graphCells(root, chargeWork)) {
    if (wrapper) {
      cell.setAttribute("id", attr(wrapper, "id") ?? "");
      const label = attr(wrapper, "label") ?? attr(wrapper, "value");
      if (label !== null) cell.setAttribute("value", label);
    }
    cells.push(cell);
  }
  return cells;
}

/** Non-mutating collection for callers that will serialize the DOM. */
export function collectCellsWithIds(root: DomEl | null, chargeWork?: ChargeWork): { cells: DomEl[]; ids: ById } {
  const cells: DomEl[] = [];
  const ids: ById = new Map();
  for (const [cell, wrapper] of graphCells(root, chargeWork)) {
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

export function contentRect(cell: DomEl, ids: ById, chargeWork?: ChargeWork): Rect | null {
  if (cell.getAttribute("vertex") !== "1") return null;
  if (isEdgeLabel(cell)) return explicitEdgeLabelRect(cell, ids, chargeWork);
  const geometry = geometryOf(cell, chargeWork);
  if (!geometry || attr(geometry, "relative") === "1") return null;
  const local = geometryRect(geometry);
  if (!local || hasInvalidNumber(local)) return null;
  return translateRect(local, parentOrigin(cell, ids, chargeWork));
}

export function contentWaypoints(cell: DomEl, chargeWork?: ChargeWork): Point[] {
  return cell.getAttribute("edge") === "1" ? edgeWaypoints(cell, chargeWork) : [];
}

/** Visible vertices/containers, practical edge-label boxes, waypoints, and free edge terminals. */
export function contentBounds(cells: DomEl[], ids: ById, chargeWork?: ChargeWork): ContentBounds | null {
  let bounds: ContentBounds | null = null;
  for (const cell of cells) {
    chargeWork?.();
    if (!isVisible(cell, ids, chargeWork)) continue;
    const box = contentRect(cell, ids, chargeWork);
    if (box && !hasInvalidNumber(box)) bounds = addRectToBounds(bounds, box);
    if (cell.getAttribute("edge") !== "1") continue;
    const waypoints = edgeWaypoints(cell, chargeWork);
    const terminals = floatingTerminals(cell, chargeWork);
    if (waypoints.length === 0 && terminals.length === 0) continue;
    const [ox, oy] = parentOrigin(cell, ids, chargeWork);
    for (const points of [waypoints, terminals]) {
      for (const [x, y] of points) {
        chargeWork?.();
        const point: Point = [x + ox, y + oy];
        if (!hasInvalidNumber(point)) bounds = addPointToBounds(bounds, point);
      }
    }
  }
  return bounds;
}
