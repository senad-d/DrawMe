/**
 * Deterministic structural linter for `.drawio` files. It rejects broken cell
 * contracts and reports conservative geometry/readability findings that can be
 * checked without rendering. Typography and automatically routed connectors
 * still require visual review.
 */
import { readFile } from "node:fs/promises";
import { DOMParser } from "@xmldom/xmldom";
import { type DomEl, attr, childrenByTag, directText, elemChildren, firstByTag } from "./dom";

const RESERVED = new Set(["0", "1"]);
export const MIN_OUTER_MARGIN = 20;
const EXCESSIVE_CANVAS_AREA_RATIO = 4;
const EXCESSIVE_CANVAS_AXIS_RATIO = 0.6;

/** [x, y, width, height]. width/height may be NaN when the source omits them. */
type Rect = [number, number, number, number];
type Point = [number, number];
type ById = Map<string, DomEl>;

export interface ValidateResult {
  errors: string[];
  warnings: string[];
  /** Informational limitations/settings that do not require a source correction. */
  observations: string[];
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

/** Quote an optional attribute consistently in diagnostic messages. */
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

function hasInvalidNumber(values: number[]): boolean {
  return values.some((value) => !Number.isFinite(value));
}

function geometryIsRelative(cell: DomEl): boolean {
  return firstByTag(cell, "mxGeometry")?.getAttribute("relative") === "1";
}

/** True for separate edge-label vertices. */
function isEdgeLabel(cell: DomEl): boolean {
  return (attr(cell, "style") ?? "").includes("edgeLabel");
}

function isVisible(cell: DomEl, byId: ById): boolean {
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

function styleHas(style: string | null, key: string, expected: string): boolean {
  return (style ?? "").split(";").includes(`${key}=${expected}`);
}

/** Absolute (x, y, w, h) of a non-relative vertex, summing parent-container offsets. */
function absRect(cell: DomEl, byId: ById): Rect | null {
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
  const points: Point[] = [];
  for (const point of childrenByTag(arr, "mxPoint")) {
    const x = pyFloat(attr(point, "x") ?? "");
    const y = pyFloat(attr(point, "y") ?? "");
    if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}

/** Absolute polyline for a waypointed edge, or null when auto-routed / unresolved. */
function edgeRoute(edge: DomEl, byId: ById): Point[] | null {
  const waypoints = edgeWaypoints(edge);
  if (waypoints.length === 0) return null;
  const source = endpoint(edge, "source", byId);
  const target = endpoint(edge, "target", byId);
  if (source === null || target === null) return null;
  return [source, ...waypoints, target];
}

function routeMidpoint(points: Point[]): Point {
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
function explicitEdgeLabelRect(cell: DomEl, byId: ById): Rect | null {
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

function geometryWarnings(cells: DomEl[], ids: ById, parents: Set<string | null>): string[] {
  const routed = collectRoutedEdges(cells, ids);
  const leaves = collectLeafBoxes(cells, ids, parents);
  return [...routeThroughWarnings(routed, leaves), ...routeCrossWarnings(routed)];
}

/** Fold UserObject/object wrappers into their inner mxCell so wrapper ids resolve. */
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

/** Per-cell reference and geometry checks. */
function checkCell(cell: DomEl, ids: ById, errors: string[], warnings: string[]): void {
  const id = attr(cell, "id");
  const parent = attr(cell, "parent");
  const isVertex = cell.getAttribute("vertex") === "1";
  const isEdge = cell.getAttribute("edge") === "1";
  if (parent !== null && !ids.has(parent)) errors.push(`cell ${repr(id)} parent ${repr(parent)} does not exist`);
  for (const end of ["source", "target"] as const) {
    const reference = attr(cell, end);
    if (reference && !ids.has(reference)) errors.push(`edge ${repr(id)} ${end} ${repr(reference)} does not exist`);
  }
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

function containmentWarnings(cells: DomEl[], ids: ById): string[] {
  const warnings: string[] = [];
  for (const cell of cells) {
    if (
      cell.getAttribute("vertex") !== "1" ||
      geometryIsRelative(cell) ||
      isEdgeLabel(cell) ||
      !isVisible(cell, ids)
    ) {
      continue;
    }
    const parentId = attr(cell, "parent");
    const parent = parentId ? ids.get(parentId) : undefined;
    if (parent?.getAttribute("vertex") !== "1" || !isVisible(parent, ids)) continue;
    const childBox = absRect(cell, ids);
    const parentBox = absRect(parent, ids);
    if (!childBox || !parentBox) continue;
    const [x, y, width, height] = childBox;
    const [px, py, parentWidth, parentHeight] = parentBox;
    const sides: string[] = [];
    if (x < px) sides.push("left");
    if (y < py) sides.push("top");
    if (x + width > px + parentWidth) sides.push("right");
    if (y + height > py + parentHeight) sides.push("bottom");
    if (sides.length > 0) {
      warnings.push(`vertex ${repr(attr(cell, "id"))} extends beyond parent ${repr(parentId)} (${sides.join(", ")})`);
    }
  }
  return warnings;
}

interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function addRectToBounds(bounds: ContentBounds | null, box: Rect): ContentBounds {
  const [x, y, width, height] = box;
  const next = bounds ?? { minX: x, minY: y, maxX: x + width, maxY: y + height };
  next.minX = Math.min(next.minX, x);
  next.minY = Math.min(next.minY, y);
  next.maxX = Math.max(next.maxX, x + width);
  next.maxY = Math.max(next.maxY, y + height);
  return next;
}

function addPointToBounds(bounds: ContentBounds | null, point: Point): ContentBounds {
  return addRectToBounds(bounds, [point[0], point[1], 0, 0]);
}

/** Visible vertices/containers, practical edge-label boxes, and explicit waypoints. */
function contentBounds(cells: DomEl[], ids: ById): ContentBounds | null {
  let bounds: ContentBounds | null = null;
  for (const cell of cells) {
    if (!isVisible(cell, ids)) continue;
    if (cell.getAttribute("vertex") === "1") {
      const box = isEdgeLabel(cell)
        ? explicitEdgeLabelRect(cell, ids)
        : geometryIsRelative(cell)
          ? null
          : absRect(cell, ids);
      if (box && !hasInvalidNumber(box)) bounds = addRectToBounds(bounds, box);
    }
    if (cell.getAttribute("edge") === "1") {
      for (const point of edgeWaypoints(cell)) bounds = addPointToBounds(bounds, point);
    }
  }
  return bounds;
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

function canvasWarnings(bounds: ContentBounds | null, settings: PageSettings): string[] {
  if (!bounds || !settings.enabled || settings.width === undefined || settings.height === undefined) return [];
  const warnings: string[] = [];
  const { width, height } = settings;
  if (bounds.minX < 0) warnings.push(`content extends beyond left page boundary by ${-bounds.minX}px`);
  if (bounds.minY < 0) warnings.push(`content extends beyond top page boundary by ${-bounds.minY}px`);
  if (bounds.maxX > width) warnings.push(`content extends beyond right page boundary by ${bounds.maxX - width}px`);
  if (bounds.maxY > height) warnings.push(`content extends beyond bottom page boundary by ${bounds.maxY - height}px`);

  const marginSides: string[] = [];
  if (bounds.minX >= 0 && bounds.minX < MIN_OUTER_MARGIN) marginSides.push(`left ${bounds.minX}px`);
  if (bounds.minY >= 0 && bounds.minY < MIN_OUTER_MARGIN) marginSides.push(`top ${bounds.minY}px`);
  const right = width - bounds.maxX;
  const bottom = height - bounds.maxY;
  if (right >= 0 && right < MIN_OUTER_MARGIN) marginSides.push(`right ${right}px`);
  if (bottom >= 0 && bottom < MIN_OUTER_MARGIN) marginSides.push(`bottom ${bottom}px`);
  if (marginSides.length > 0) {
    warnings.push(`content outer margin is below ${MIN_OUTER_MARGIN}px (${marginSides.join(", ")})`);
  }

  const contentWidth = bounds.maxX - bounds.minX;
  const contentHeight = bounds.maxY - bounds.minY;
  if (contentWidth > 0 && contentHeight > 0) {
    const areaRatio = (width * height) / (contentWidth * contentHeight);
    if (
      areaRatio >= EXCESSIVE_CANVAS_AREA_RATIO &&
      contentWidth / width <= EXCESSIVE_CANVAS_AXIS_RATIO &&
      contentHeight / height <= EXCESSIVE_CANVAS_AXIS_RATIO
    ) {
      warnings.push(
        `canvas has excessive empty space (content ${contentWidth}x${contentHeight}px within ${width}x${height}px page)`,
      );
    }
  }
  return warnings;
}

function labelText(cell: DomEl): string {
  return (attr(cell, "value") ?? "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .trim();
}

/** Conservative static checks only; uncertain typography remains a visual concern. */
function readabilityWarnings(cells: DomEl[]): string[] {
  const warnings: string[] = [];
  for (const cell of cells) {
    const label = labelText(cell);
    if (!label) continue;
    const style = attr(cell, "style");
    const fontSize = styleNum(style, "fontSize");
    const isEdgeText = cell.getAttribute("edge") === "1" || isEdgeLabel(cell);
    const box = rect(cell);
    const isCompactBorderPort =
      cell.getAttribute("vertex") === "1" &&
      geometryIsRelative(cell) &&
      !isEdgeLabel(cell) &&
      box !== null &&
      !hasInvalidNumber(box) &&
      box[2] <= 30 &&
      box[3] <= 30;
    const minimum = isEdgeText ? 9 : 10;
    if (
      !isCompactBorderPort &&
      fontSize !== undefined &&
      Number.isFinite(fontSize) &&
      fontSize > 0 &&
      fontSize < minimum
    ) {
      warnings.push(
        `${isEdgeText ? "connector label" : "vertex"} ${repr(attr(cell, "id"))} has very small explicit fontSize ${fontSize}px`,
      );
    }

    if (cell.getAttribute("vertex") === "1" && !isEdgeLabel(cell) && !geometryIsRelative(cell)) {
      const oneLineLength = label.replaceAll("\n", "").length;
      if (
        box &&
        !hasInvalidNumber(box) &&
        oneLineLength > 32 &&
        !label.includes("\n") &&
        box[2] < 160 &&
        !styleHas(style, "whiteSpace", "wrap")
      ) {
        warnings.push(`vertex ${repr(attr(cell, "id"))} has a long label in narrow geometry without whiteSpace=wrap`);
      }
    }
  }
  return warnings;
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
    ...containmentWarnings(cells, ids),
    ...readabilityWarnings(cells),
  );
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
  return {
    errors,
    warnings,
    observations,
    score: { total: 20 * through + 10 * crossings + 5 * overlaps, through, crossings, overlaps },
  };
}

function emptyScore(): ValidateResult["score"] {
  return { total: 0, through: 0, crossings: 0, overlaps: 0 };
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
