/**
 * Deterministic canvas fit for `.drawio` files: per page, resize
 * pageWidth/pageHeight to the visible content plus a margin and shift content
 * so it starts exactly at that margin. Grows cramped pages and tightens
 * oversized ones without touching element sizes or relative positions. No
 * draw.io CLI involved.
 */
import { readFile, writeFile } from "node:fs/promises";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { type DomEl, attr, childrenByTag, directText, firstByTag } from "./dom";
import { type ById, collectCellsWithIds, contentBounds, geometryIsRelative, pyFloat } from "./geometry";

export const DEFAULT_FIT_MARGIN = 40;

export interface FitPageResult {
  page: string;
  status: "fitted" | "unchanged" | "skipped";
  /** Why the page was skipped. */
  reason?: string;
  before?: { width?: number; height?: number };
  after?: { width: number; height: number };
  shift?: { dx: number; dy: number };
}

export interface FitCanvasOptions {
  input: string;
  /** Outer margin between content and page edge, in model px (default 40). */
  margin?: number;
  /** Destination path; defaults to overwriting the input. */
  output?: string;
}

export interface FitCanvasResult {
  input: string;
  output: string;
  margin: number;
  /** True when at least one page was resized or shifted. */
  changed: boolean;
  pages: FitPageResult[];
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function shiftAttr(el: DomEl, name: "x" | "y", delta: number): void {
  const current = pyFloat(attr(el, name) ?? "0");
  if (current === undefined || !Number.isFinite(current)) return;
  el.setAttribute(name, fmt(current + delta));
}

/** Shift one top-level cell: absolute vertex origin, or edge points/waypoints. */
function shiftCell(cell: DomEl, dx: number, dy: number): void {
  const geometry = firstByTag(cell, "mxGeometry");
  if (!geometry) return;
  if (cell.getAttribute("vertex") === "1" && !geometryIsRelative(cell)) {
    shiftAttr(geometry, "x", dx);
    shiftAttr(geometry, "y", dy);
    return;
  }
  if (cell.getAttribute("edge") === "1") {
    for (const point of childrenByTag(geometry, "mxPoint")) {
      const as = attr(point, "as");
      if (as === "sourcePoint" || as === "targetPoint") {
        shiftAttr(point, "x", dx);
        shiftAttr(point, "y", dy);
      }
    }
    const waypoints = firstByTag(geometry, "Array");
    for (const point of waypoints ? childrenByTag(waypoints, "mxPoint") : []) {
      shiftAttr(point, "x", dx);
      shiftAttr(point, "y", dy);
    }
  }
}

/** Ids of layer cells (direct children of the root cell `0`). */
function layerIds(ids: ById): Set<string> {
  const layers = new Set<string>();
  for (const [id, cell] of ids) {
    if (attr(cell, "parent") === "0") layers.add(id);
  }
  return layers;
}

function pageScale(model: DomEl): number {
  const raw = attr(model, "pageScale");
  const parsed = raw === null ? 1 : pyFloat(raw);
  return parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function currentDimension(model: DomEl, name: "pageWidth" | "pageHeight"): number | undefined {
  const raw = attr(model, name);
  if (raw === null) return undefined;
  const value = pyFloat(raw);
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Fit a single page's model in place; returns what happened. */
function fitModel(name: string, model: DomEl, margin: number): FitPageResult {
  if (attr(model, "page") === "0") {
    return { page: name, status: "skipped", reason: "page canvas disabled (infinite canvas)" };
  }
  const { cells, ids } = collectCellsWithIds(firstByTag(model, "root"));
  const bounds = contentBounds(cells, ids);
  if (!bounds) return { page: name, status: "skipped", reason: "no measurable content" };

  const scale = pageScale(model);
  const rawDx = margin - bounds.minX;
  const rawDy = margin - bounds.minY;
  const dx = Math.abs(rawDx) < 0.005 ? 0 : Math.round(rawDx * 1000) / 1000;
  const dy = Math.abs(rawDy) < 0.005 ? 0 : Math.round(rawDy * 1000) / 1000;
  const width = Math.ceil((bounds.maxX - bounds.minX + 2 * margin) / scale);
  const height = Math.ceil((bounds.maxY - bounds.minY + 2 * margin) / scale);
  const before = { width: currentDimension(model, "pageWidth"), height: currentDimension(model, "pageHeight") };

  if (dx === 0 && dy === 0 && before.width === width && before.height === height) {
    return { page: name, status: "unchanged", before, after: { width, height } };
  }

  if (dx !== 0 || dy !== 0) {
    const layers = layerIds(ids);
    for (const cell of cells) {
      const parent = attr(cell, "parent");
      if (parent !== null && layers.has(parent)) shiftCell(cell, dx, dy);
    }
  }
  model.setAttribute("pageWidth", String(width));
  model.setAttribute("pageHeight", String(height));
  return { page: name, status: "fitted", before, after: { width, height }, shift: { dx, dy } };
}

function fitPage(diagram: DomEl, margin: number): FitPageResult {
  const name = attr(diagram, "name") ?? "?";
  const model = firstByTag(diagram, "mxGraphModel");
  if (!model) {
    const reason = directText(diagram).trim() ? "compressed page (cannot fit)" : "no <mxGraphModel>";
    return { page: name, status: "skipped", reason };
  }
  return fitModel(name, model, margin);
}

/** Fit every page of a `.drawio` file. Throws on read/parse failure or invalid margin. */
export async function fitCanvasFile(options: FitCanvasOptions): Promise<FitCanvasResult> {
  const margin = options.margin ?? DEFAULT_FIT_MARGIN;
  if (!Number.isFinite(margin) || margin < 0) throw new Error(`invalid margin ${String(options.margin)}`);
  const output = options.output ?? options.input;
  const xml = await readFile(options.input, "utf8");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement as unknown as DomEl | null;
  if (!root) throw new Error("no root element (malformed XML)");

  const diagrams = childrenByTag(root, "diagram");
  let pages: FitPageResult[];
  if (diagrams.length > 0) {
    pages = diagrams.map((diagram) => fitPage(diagram, margin));
  } else if (root.tagName === "mxGraphModel") {
    pages = [fitModel("?", root, margin)];
  } else {
    pages = [{ page: "?", status: "skipped", reason: "no <diagram> pages and root is not <mxGraphModel>" }];
  }

  const changed = pages.some((page) => page.status === "fitted");
  if (changed || output !== options.input) {
    let serialized = new XMLSerializer().serializeToString(doc as never);
    const declaration = /^<\?xml[^>]*\?>/.exec(xml)?.[0];
    if (declaration && !serialized.startsWith("<?xml")) serialized = `${declaration}\n${serialized}`;
    if (xml.endsWith("\n") && !serialized.endsWith("\n")) serialized += "\n";
    await writeFile(output, serialized, "utf8");
  }
  return { input: options.input, output, margin, changed, pages };
}
