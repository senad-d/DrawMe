/**
 * Deterministic structural linter for `.drawio` files — a pure-TypeScript port of
 * the skill's `scripts/validate.py`. Catches the class of mistakes a vision
 * self-check is slow and unreliable at: dangling edge endpoints, duplicate or
 * reserved ids, broken parent references, and (as warnings) off-grid geometry,
 * overlapping sibling nodes, and edge-routing defects. Runs without launching
 * draw.io. Local-only, no network.
 */
import { readFile } from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";
import { type DomEl, attr, childrenByTag, directText, elemChildren, firstByTag } from "./dom";

const RESERVED = new Set(["0", "1"]);

/** [x, y, width, height]. width/height may be NaN when the source omits them. */
type Rect = [number, number, number, number];
type ById = Map<string, DomEl>;

export interface ValidateResult {
  errors: string[];
  warnings: string[];
  /** Readability score (lower is better); comparable only across variants of the same graph. */
  score: { total: number; through: number; crossings: number; overlaps: number };
}

/** Python `float()` semantics: accepts nan/inf, strict-numeric otherwise; else undefined (≈ ValueError). */
function pyFloat(s: string): number | undefined {
  const t = s.trim().toLowerCase();
  if (t === "nan" || t === "+nan" || t === "-nan") return Number.NaN;
  if (t === "inf" || t === "+inf" || t === "infinity" || t === "+infinity") return Infinity;
  if (t === "-inf" || t === "-infinity") return -Infinity;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isNaN(n) ? undefined : n;
}

/** Python `repr()` of an optional attribute, for message parity with validate.py. */
function repr(s: string | null): string {
  return s === null ? "None" : `'${s}'`;
}

function rect(cell: DomEl): Rect | null {
  const gy = firstByTag(cell, "mxGeometry");
  if (!gy) return null;
  const x = pyFloat(attr(gy, "x") ?? "0");
  const y = pyFloat(attr(gy, "y") ?? "0");
  const w = pyFloat(attr(gy, "width") ?? "nan");
  const h = pyFloat(attr(gy, "height") ?? "nan");
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return [x, y, w, h];
}

function hasNaN(r: Rect): boolean {
  return r.some((v) => Number.isNaN(v));
}

/** True for edge labels / relative-positioned child vertices (they legitimately omit w/h). */
function isEdgeLabel(cell: DomEl): boolean {
  if ((attr(cell, "style") ?? "").includes("edgeLabel")) return true;
  const gy = firstByTag(cell, "mxGeometry");
  return gy !== null && gy.getAttribute("relative") === "1";
}

function overlap(a: Rect, b: Rect): boolean {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

function styleNum(style: string | null, key: string): number | undefined {
  for (const part of (style ?? "").split(";")) {
    if (part.startsWith(key + "=")) return pyFloat(part.split("=").slice(1).join("="));
  }
  return undefined;
}

/** Absolute (x, y, w, h) of a vertex, summing parent-container offsets. */
function absRect(cell: DomEl, byId: ById): Rect | null {
  const r = rect(cell);
  if (r === null || hasNaN(r)) return null;
  let [x, y] = r;
  const [, , w, h] = r;
  let parent = attr(cell, "parent");
  const seen = new Set<string>();
  while (parent && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    const p = byId.get(parent)!;
    if (p.getAttribute("vertex") === "1") {
      const pr = rect(p);
      if (pr && !hasNaN(pr)) {
        x += pr[0];
        y += pr[1];
      }
    }
    parent = attr(p, "parent");
  }
  return [x, y, w, h];
}

type Point = [number, number];

/** Absolute point where `edge` meets its source/target vertex (honours exit/entry). */
function endpoint(edge: DomEl, end: "source" | "target", byId: ById): Point | null {
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

function edgeWaypoints(edge: DomEl): Point[] {
  const gy = firstByTag(edge, "mxGeometry");
  if (!gy) return [];
  const arr = firstByTag(gy, "Array");
  if (!arr) return [];
  const pts: Point[] = [];
  for (const pt of childrenByTag(arr, "mxPoint")) {
    const px = attr(pt, "x");
    const py = attr(pt, "y");
    if (px !== null && py !== null) {
      const nx = pyFloat(px);
      const ny = pyFloat(py);
      if (nx !== undefined && ny !== undefined) pts.push([nx, ny]);
    }
  }
  return pts;
}

/** Absolute polyline for a waypointed edge, or null when auto-routed / unresolved. */
function edgeRoute(edge: DomEl, byId: ById): Point[] | null {
  const wp = edgeWaypoints(edge);
  if (wp.length === 0) return null;
  const s = endpoint(edge, "source", byId);
  const t = endpoint(edge, "target", byId);
  if (s === null || t === null) return null;
  return [s, ...wp, t];
}

function orient(a: Point, b: Point, c: Point): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : -1;
}

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orient(p1, p2, p3);
  const o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1);
  const o4 = orient(p3, p4, p2);
  return o1 !== o2 && o3 !== o4 && ![o1, o2, o3, o4].includes(0);
}

function pointInRect(p: Point, box: Rect, eps = 1e-6): boolean {
  const [x, y, w, h] = box;
  return x + eps < p[0] && p[0] < x + w - eps && y + eps < p[1] && p[1] < y + h - eps;
}

function routeHitsRect(points: Point[], box: Rect): boolean {
  const [x, y, w, h] = box;
  const corners: Point[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  const borders: [Point, Point][] = corners.map((c, i) => [c, corners[(i + 1) % 4]]);
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (pointInRect(a, box) || pointInRect(b, box)) return true;
    for (const [c, d] of borders) if (segmentsCross(a, b, c, d)) return true;
  }
  return false;
}

function routesCross(pa: Point[], pb: Point[]): boolean {
  for (let i = 0; i < pa.length - 1; i++)
    for (let j = 0; j < pb.length - 1; j++)
      if (segmentsCross(pa[i], pa[i + 1], pb[j], pb[j + 1])) return true;
  return false;
}

type RoutedEdge = [string | null, Point[], Set<string | null>];
type LeafBox = [string | null, Rect];

/** Edges with a resolvable waypointed route, tagged with their id and endpoint ids. */
function collectRoutedEdges(cells: DomEl[], ids: ById): RoutedEdge[] {
  const routed: RoutedEdge[] = [];
  for (const c of cells) {
    if (c.getAttribute("edge") === "1") {
      const pts = edgeRoute(c, ids);
      if (pts) routed.push([attr(c, "id"), pts, new Set([attr(c, "source"), attr(c, "target")])]);
    }
  }
  return routed;
}

/** Absolute boxes of leaf vertices (real nodes, not containers or edge labels). */
function collectLeafBoxes(cells: DomEl[], ids: ById, parents: Set<string | null>): LeafBox[] {
  const leaves: LeafBox[] = [];
  for (const c of cells) {
    if (c.getAttribute("vertex") === "1" && !parents.has(attr(c, "id")) && !isEdgeLabel(c)) {
      const box = absRect(c, ids);
      if (box) leaves.push([attr(c, "id"), box]);
    }
  }
  return leaves;
}

function routeThroughWarnings(routed: RoutedEdge[], leaves: LeafBox[]): string[] {
  const warns: string[] = [];
  for (const [eid, pts, ends] of routed) {
    for (const [vid, box] of leaves) {
      if (!ends.has(vid) && routeHitsRect(pts, box)) warns.push(`edge ${repr(eid)} routes through vertex ${repr(vid)}`);
    }
  }
  return warns;
}

function routeCrossWarnings(routed: RoutedEdge[]): string[] {
  const warns: string[] = [];
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      if (routesCross(routed[i][1], routed[j][1])) warns.push(`edges ${repr(routed[i][0])} and ${repr(routed[j][0])} cross`);
    }
  }
  return warns;
}

function geometryWarnings(cells: DomEl[], ids: ById, parents: Set<string | null>): string[] {
  const routed = collectRoutedEdges(cells, ids);
  const leaves = collectLeafBoxes(cells, ids, parents);
  return [...routeThroughWarnings(routed, leaves), ...routeCrossWarnings(routed)];
}

/**
 * Fold UserObject/object wrappers (links & metadata) into their inner mxCell so
 * the wrapper id resolves for edges that reference it.
 */
function collectCells(root: DomEl | null): DomEl[] {
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

/** Map every cell by id (blank key for id-less cells); report duplicate ids as errors. */
function buildIds(cells: DomEl[], errors: string[]): ById {
  const ids: ById = new Map();
  for (const c of cells) {
    const cid = attr(c, "id");
    if (cid !== null && ids.has(cid)) errors.push(`duplicate id ${repr(cid)}`);
    ids.set(cid ?? "", c);
  }
  return ids;
}

/** Geometry checks for a single non-edge-label vertex. */
function checkVertexGeometry(c: DomEl, cid: string | null, errors: string[], warns: string[]): void {
  const r = rect(c);
  if (r === null || hasNaN(r)) {
    errors.push(`vertex ${repr(cid)} has missing/invalid geometry`);
    return;
  }
  const [x, y, w, h] = r;
  if (w <= 0 || h <= 0) warns.push(`vertex ${repr(cid)} non-positive size ${String(w)}x${String(h)}`);
  if (x < 0 || y < 0) warns.push(`vertex ${repr(cid)} negative position (${String(x)},${String(y)})`);
}

/** Per-cell reference and geometry checks (parents, edge endpoints, reserved ids, geometry). */
function checkCell(c: DomEl, ids: ById, errors: string[], warns: string[]): void {
  const cid = attr(c, "id");
  const parent = attr(c, "parent");
  const isV = c.getAttribute("vertex") === "1";
  const isE = c.getAttribute("edge") === "1";
  if (parent !== null && !ids.has(parent)) errors.push(`cell ${repr(cid)} parent ${repr(parent)} does not exist`);
  for (const end of ["source", "target"] as const) {
    const ref = attr(c, end);
    if (ref && !ids.has(ref)) errors.push(`edge ${repr(cid)} ${end} ${repr(ref)} does not exist`);
  }
  if ((isV || isE) && cid !== null && RESERVED.has(cid)) errors.push(`cell ${repr(cid)} reuses reserved id 0/1`);
  if (isV && !isEdgeLabel(c)) checkVertexGeometry(c, cid, errors, warns);
}

/** Sibling overlap: leaf vertices only (containers legitimately wrap children). */
function overlapWarnings(cells: DomEl[], parents: Set<string | null>): string[] {
  const boxes: [string | null, string | null, Rect][] = [];
  for (const c of cells) {
    if (c.getAttribute("vertex") === "1" && !parents.has(attr(c, "id"))) {
      const r = rect(c);
      if (r && !hasNaN(r)) boxes.push([attr(c, "id"), attr(c, "parent"), r]);
    }
  }
  const warns: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [ia, pa, ra] = boxes[i];
      const [ib, pb, rb] = boxes[j];
      if (pa === pb && overlap(ra, rb)) warns.push(`vertices ${repr(ia)} and ${repr(ib)} overlap`);
    }
  }
  return warns;
}

function checkPage(diagram: DomEl): [string[], string[]] {
  const name = attr(diagram, "name") ?? "?";
  const model = firstByTag(diagram, "mxGraphModel");
  if (!model) {
    if (directText(diagram).trim()) return [[], [`page '${name}': compressed, skipped (cannot lint)`]];
    return [[`page '${name}': no <mxGraphModel>`], []];
  }
  const cells = collectCells(firstByTag(model, "root"));

  const errors: string[] = [];
  const warns: string[] = [];
  const ids = buildIds(cells, errors);
  const parents = new Set<string | null>();
  for (const c of cells) parents.add(attr(c, "parent"));

  for (const c of cells) checkCell(c, ids, errors, warns);
  warns.push(...overlapWarnings(cells, parents), ...geometryWarnings(cells, ids, parents));
  return [errors, warns];
}

/** Lint a `.drawio` XML string. Throws only on unrecoverable parse failure. */
export function validateXml(xml: string): ValidateResult {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const rootEl = doc.documentElement as unknown as DomEl | null;
  if (!rootEl) throw new Error("no root element (malformed XML)");
  const pageList = childrenByTag(rootEl, "diagram");
  const pages = pageList.length > 0 ? pageList : [rootEl];

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const page of pages) {
    const [e, w] = checkPage(page);
    errors.push(...e);
    warnings.push(...w);
  }
  const through = warnings.filter((w) => w.includes("routes through")).length;
  const crossings = warnings.filter((w) => w.endsWith(" cross")).length;
  const overlaps = warnings.filter((w) => w.endsWith(" overlap")).length;
  return {
    errors,
    warnings,
    score: { total: 20 * through + 10 * crossings + 5 * overlaps, through, crossings, overlaps },
  };
}

/** Read and lint a `.drawio` file. Read/parse failures are returned as errors, never thrown. */
export async function validateFile(path: string): Promise<ValidateResult> {
  const empty = { total: 0, through: 0, crossings: 0, overlaps: 0 };
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch (e) {
    return { errors: [`cannot read ${path}: ${(e as Error).message}`], warnings: [], score: empty };
  }
  try {
    return validateXml(xml);
  } catch (e) {
    return { errors: [`cannot parse ${path}: ${(e as Error).message}`], warnings: [], score: empty };
  }
}
