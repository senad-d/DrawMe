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

export function rect(cell: DomEl): Rect | null {
  const gy = firstByTag(cell, "mxGeometry");
  if (!gy) return null;
  const x = pyFloat(attr(gy, "x") ?? "0");
  const y = pyFloat(attr(gy, "y") ?? "0");
  const w = pyFloat(attr(gy, "width") ?? "nan");
  const h = pyFloat(attr(gy, "height") ?? "nan");
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return [x, y, w, h];
}

export function geometryIsRelative(cell: DomEl): boolean {
  return firstByTag(cell, "mxGeometry")?.getAttribute("relative") === "1";
}

/** True for separate edge-label vertices. */
export function isEdgeLabel(cell: DomEl): boolean {
  return (attr(cell, "style") ?? "").includes("edgeLabel");
}

export function isVisible(cell: DomEl, byId: ById): boolean {
  let current: DomEl | undefined = cell;
  const seen = new Set<string>();
  while (current) {
    if (attr(current, "visible") === "0") return false;
    const parent = attr(current, "parent");
    if (!parent || seen.has(parent)) break;
    seen.add(parent);
    current = byId.get(parent);
  }
  return true;
}

export function styleNum(style: string | null, key: string): number | undefined {
  for (const part of (style ?? "").split(";")) {
    if (part.startsWith(key + "=")) return pyFloat(part.split("=").slice(1).join("="));
  }
  return undefined;
}

/** Absolute (x, y, w, h) of a non-relative vertex, summing parent-container offsets. */
export function absRect(cell: DomEl, byId: ById): Rect | null {
  const r = rect(cell);
  if (r === null || hasInvalidNumber(r)) return null;
  let [x, y] = r;
  const [, , w, h] = r;
  let parent = attr(cell, "parent");
  const seen = new Set<string>();
  while (parent && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    const p = byId.get(parent)!;
    if (p.getAttribute("vertex") === "1" && !geometryIsRelative(p)) {
      const pr = rect(p);
      if (pr && !hasInvalidNumber(pr)) {
        x += pr[0];
        y += pr[1];
      }
    }
    parent = attr(p, "parent");
  }
  return [x, y, w, h];
}

/** Absolute point where `edge` meets its source/target vertex (honours exit/entry). */
export function endpoint(edge: DomEl, end: "source" | "target", byId: ById): Point | null {
  const vid = attr(edge, end);
  if (!vid || !byId.has(vid)) return null;
  const box = absRect(byId.get(vid)!, byId);
  if (box === null) return null;
  const [x, y, w, h] = box;
  const style = attr(edge, "style") ?? "";
  const fx = styleNum(style, end === "source" ? "exitX" : "entryX");
  const fy = styleNum(style, end === "source" ? "exitY" : "entryY");
  return [x + (fx ?? 0.5) * w, y + (fy ?? 0.5) * h];
}

export function edgeWaypoints(edge: DomEl): Point[] {
  const gy = firstByTag(edge, "mxGeometry");
  if (!gy) return [];
  const arr = firstByTag(gy, "Array");
  if (!arr) return [];
  const points: Point[] = [];
  for (const point of childrenByTag(arr, "mxPoint")) {
    const x = pyFloat(attr(point, "x") ?? "");
    const y = pyFloat(attr(point, "y") ?? "");
    if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}

/** Absolute polyline for a waypointed edge, or null when auto-routed / unresolved. */
export function edgeRoute(edge: DomEl, byId: ById): Point[] | null {
  const waypoints = edgeWaypoints(edge);
  if (waypoints.length === 0) return null;
  const source = endpoint(edge, "source", byId);
  const target = endpoint(edge, "target", byId);
  if (source === null || target === null) return null;
  return [source, ...waypoints, target];
}

export function routeMidpoint(points: Point[]): Point {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const length = Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
    lengths.push(length);
    total += length;
  }
  let remaining = total / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i]) {
      const fraction = lengths[i] === 0 ? 0 : remaining / lengths[i];
      return [
        points[i][0] + fraction * (points[i + 1][0] - points[i][0]),
        points[i][1] + fraction * (points[i + 1][1] - points[i][1]),
      ];
    }
    remaining -= lengths[i];
  }
  return points.at(-1) ?? [0, 0];
}

/** Conservative box for a separately sized label on an explicitly routed edge. */
export function explicitEdgeLabelRect(cell: DomEl, byId: ById): Rect | null {
  if (!isEdgeLabel(cell)) return null;
  const local = rect(cell);
  const parent = attr(cell, "parent");
  const edge = parent ? byId.get(parent) : undefined;
  if (!local || hasInvalidNumber(local) || edge?.getAttribute("edge") !== "1") return null;
  const route = edgeRoute(edge, byId);
  if (!route) return null;
  const [midX, midY] = routeMidpoint(route);
  const geometry = firstByTag(cell, "mxGeometry");
  const offset = geometry
    ? childrenByTag(geometry, "mxPoint").find((point) => attr(point, "as") === "offset")
    : undefined;
  const offsetX = offset ? pyFloat(attr(offset, "x") ?? "0") : 0;
  const offsetY = offset ? pyFloat(attr(offset, "y") ?? "0") : 0;
  if (offsetX === undefined || offsetY === undefined || !Number.isFinite(offsetX) || !Number.isFinite(offsetY)) {
    return null;
  }
  return [midX + offsetX - local[2] / 2, midY + offsetY - local[3] / 2, local[2], local[3]];
}

/** Fold UserObject/object wrappers into their inner mxCell so wrapper ids resolve. */
export function collectCells(root: DomEl | null): DomEl[] {
  const cells: DomEl[] = [];
  for (const child of root ? elemChildren(root) : []) {
    if (child.tagName === "mxCell") cells.push(child);
    else if (child.tagName === "UserObject" || child.tagName === "object") {
      const inner = firstByTag(child, "mxCell");
      if (inner) {
        inner.setAttribute("id", attr(child, "id") ?? "");
        cells.push(inner);
      }
    }
  }
  return cells;
}

/**
 * Non-mutating variant of collectCells for callers that serialize the DOM
 * afterwards: wrapper ids resolve through the returned map instead of being
 * written onto the inner mxCell.
 */
export function collectCellsWithIds(root: DomEl | null): { cells: DomEl[]; ids: ById } {
  const cells: DomEl[] = [];
  const ids: ById = new Map();
  for (const child of root ? elemChildren(root) : []) {
    let cell: DomEl | null = null;
    let id: string | null = null;
    if (child.tagName === "mxCell") {
      cell = child;
      id = attr(child, "id");
    } else if (child.tagName === "UserObject" || child.tagName === "object") {
      const inner = firstByTag(child, "mxCell");
      if (inner) {
        cell = inner;
        id = attr(child, "id");
      }
    }
    if (cell) {
      cells.push(cell);
      ids.set(id ?? "", cell);
    }
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

export function contentRect(cell: DomEl, ids: ById): Rect | null {
  if (cell.getAttribute("vertex") !== "1") return null;
  if (isEdgeLabel(cell)) return explicitEdgeLabelRect(cell, ids);
  if (geometryIsRelative(cell)) return null;
  return absRect(cell, ids);
}

export function contentWaypoints(cell: DomEl): Point[] {
  return cell.getAttribute("edge") === "1" ? edgeWaypoints(cell) : [];
}

/** Visible vertices/containers, practical edge-label boxes, and explicit waypoints. */
export function contentBounds(cells: DomEl[], ids: ById): ContentBounds | null {
  let bounds: ContentBounds | null = null;
  for (const cell of cells) {
    if (!isVisible(cell, ids)) continue;
    const box = contentRect(cell, ids);
    if (box && !hasInvalidNumber(box)) bounds = addRectToBounds(bounds, box);
    for (const point of contentWaypoints(cell)) bounds = addPointToBounds(bounds, point);
  }
  return bounds;
}
