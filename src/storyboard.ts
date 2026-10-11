/**
 * Storyboard: renders a motion timeline as a grid of static frames on one
 * draw.io page, one tile per sequential step, so motion order and visibility
 * can be reviewed in a single PNG. Each tile is a copy of the page with cell
 * opacity set to its state after that step; highlight and travel steps show
 * their accent color on the stroke.
 */
import { XMLSerializer } from "@xmldom/xmldom";
import { type DomEl, attr, elemChildren, firstByTag } from "./dom";
import { contentBounds, collectCellsWithIds, pyFloat } from "./geometry";
import { shiftCell } from "./fitcanvas";
import { type MotionFrame, isDarkBackground } from "./motion";

export const MAX_STORYBOARD_FRAMES = 12;
const GAP = 80;
const CAPTION_HEIGHT = 56;

interface PageEntry {
  id: string;
  element: DomEl;
  cell: DomEl;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStyle(style: string, values: Record<string, string>): string {
  const items = style.split(";").filter((item) => item.trim() !== "");
  for (const [key, value] of Object.entries(values)) {
    const index = items.findIndex((item) => item.split("=")[0].trim() === key);
    if (index >= 0) items[index] = `${key}=${value}`;
    else items.push(`${key}=${value}`);
  }
  return `${items.join(";")};`;
}

/** Evenly sample at most MAX_STORYBOARD_FRAMES frames, always keeping the first and last. */
export function sampleFrames(frames: MotionFrame[]): MotionFrame[] {
  if (frames.length <= MAX_STORYBOARD_FRAMES) return frames;
  const last = frames.length - 1;
  const picks = new Set<number>();
  for (let i = 0; i < MAX_STORYBOARD_FRAMES; i++) picks.add(Math.round((i * last) / (MAX_STORYBOARD_FRAMES - 1)));
  return [...picks].map((index) => frames[index]);
}

function pageSize(model: DomEl): { width: number; height: number } {
  const width = pyFloat(attr(model, "pageWidth") ?? "");
  const height = pyFloat(attr(model, "pageHeight") ?? "");
  if (width !== undefined && height !== undefined && width > 0 && height > 0 && Number.isFinite(width + height)) {
    return { width, height };
  }
  const { cells, ids } = collectCellsWithIds(firstByTag(model, "root"));
  const bounds = contentBounds(cells, ids);
  return { width: Math.ceil((bounds?.maxX ?? 800) + 40), height: Math.ceil((bounds?.maxY ?? 600) + 40) };
}

function pageEntries(model: DomEl): PageEntry[] {
  const root = firstByTag(model, "root");
  const entries: PageEntry[] = [];
  for (const element of root ? elemChildren(root) : []) {
    const cell = element.tagName === "mxCell" ? element : firstByTag(element, "mxCell");
    const id = attr(element, "id");
    if (cell && id !== null) entries.push({ id, element, cell });
  }
  return entries;
}

/** Opacity a cell shows in a frame: its own value times every container ancestor's (SVG groups nest). */
function effectiveOpacity(id: string, frame: MotionFrame, parents: Map<string, string | null>): number {
  let opacity = 1;
  let current: string | null | undefined = id;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    opacity *= frame.opacity.get(current) ?? 1;
    current = parents.get(current);
  }
  return opacity;
}

/** Build a one-page `.drawio` document that lays out the frames as a captioned grid. */
export function buildStoryboard(model: DomEl, frames: MotionFrame[]): string {
  if (frames.length === 0) throw new Error("motion has no visual steps to storyboard");
  const { width, height } = pageSize(model);
  const entries = pageEntries(model);
  const parents = new Map(entries.map((entry) => [entry.id, attr(entry.cell, "parent")]));
  const layers = new Set(entries.filter((entry) => attr(entry.cell, "parent") === "0").map((entry) => entry.id));
  const columns = Math.min(frames.length, width >= height ? 2 : 3);
  const rows = Math.ceil(frames.length / columns);
  const tileHeight = CAPTION_HEIGHT + height;
  const serializer = new XMLSerializer();
  const parts: string[] = [];
  const dark = isDarkBackground(attr(model, "background"));
  const captionColor = dark ? "#CBD5E1" : "#334155";
  const frameColor = dark ? "#334155" : "#CBD5E1";

  frames.forEach((frame, index) => {
    const prefix = `f${index + 1}-`;
    const ox = GAP + (index % columns) * (width + GAP);
    const oy = GAP + Math.floor(index / columns) * (tileHeight + GAP);
    const seconds = (frame.time / 1000).toFixed(1);
    const caption = `${index + 1} · ${seconds}s · ${frame.label}`;
    parts.push(
      `<mxCell id="${prefix}frame" value="" style="rounded=1;absoluteArcSize=1;arcSize=16;fillColor=none;strokeColor=${frameColor};dashed=1;" vertex="1" parent="1"><mxGeometry x="${ox}" y="${oy + CAPTION_HEIGHT}" width="${width}" height="${height}" as="geometry"/></mxCell>`,
      `<mxCell id="${prefix}caption" value="${escapeXml(caption)}" style="text;html=1;align=left;verticalAlign=middle;whiteSpace=wrap;fontSize=22;fontStyle=1;fontColor=${captionColor};" vertex="1" parent="1"><mxGeometry x="${ox}" y="${oy}" width="${width}" height="${CAPTION_HEIGHT - 8}" as="geometry"/></mxCell>`,
    );
    for (const entry of entries) {
      if (entry.id === "0" || layers.has(entry.id)) continue;
      const element = (entry.element as unknown as { cloneNode(deep: boolean): DomEl }).cloneNode(true);
      const cell = element.tagName === "mxCell" ? element : firstByTag(element, "mxCell")!;
      element.setAttribute("id", `${prefix}${entry.id}`);
      const parent = attr(cell, "parent");
      const topLevel = parent === null || layers.has(parent);
      cell.setAttribute("parent", topLevel ? "1" : `${prefix}${parent}`);
      for (const end of ["source", "target"]) {
        const ref = attr(cell, end);
        if (ref !== null) cell.setAttribute(end, `${prefix}${ref}`);
      }
      if (topLevel) shiftCell(cell, ox, oy + CAPTION_HEIGHT);

      const updates: Record<string, string> = {};
      const opacity = effectiveOpacity(entry.id, frame, parents);
      if (opacity < 1) {
        const percent = String(Math.round(opacity * 100));
        Object.assign(updates, { opacity: percent, textOpacity: percent });
      }
      const accent = frame.accent.get(entry.id);
      if (accent) Object.assign(updates, { strokeColor: accent, strokeWidth: "3" });
      if (Object.keys(updates).length > 0) cell.setAttribute("style", setStyle(attr(cell, "style") ?? "", updates));
      parts.push(serializer.serializeToString(element as never));
    }
  });

  const pageWidth = GAP + columns * (width + GAP);
  const pageHeight = GAP + rows * (tileHeight + GAP);
  const background = attr(model, "background");
  const backgroundAttr = background ? ` background="${escapeXml(background)}"` : "";
  return [
    '<mxfile host="drawme">',
    '<diagram name="Storyboard">',
    `<mxGraphModel grid="0" page="1" pageScale="1" pageWidth="${pageWidth}" pageHeight="${pageHeight}"${backgroundAttr}>`,
    '<root><mxCell id="0"/><mxCell id="1" parent="0"/>',
    ...parts,
    "</root></mxGraphModel></diagram></mxfile>",
    "",
  ].join("\n");
}
