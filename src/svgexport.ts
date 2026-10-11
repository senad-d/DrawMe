/**
 * draw.io SVG post-processing: an even outer margin, and authored colors.
 *
 * Pin draw.io SVG exports to their authored colors. draw.io wraps every color
 * in CSS `light-dark(authored, generated-dark)` and declares
 * `color-scheme: light dark`, so a viewer in dark mode sees an automatically
 * inverted diagram that no longer matches the PNG/PDF output or the chosen
 * theme. Resolving each `light-dark()` to its first argument makes every
 * export show the same colors in every viewer.
 */
import { readFile, writeFile } from "node:fs/promises";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { type DomEl, TEXT_NODE, attr, elemChildren } from "./dom";

const FUNCTION = "light-dark(";
const CDATA_NODE = 4;

/** Replace every `light-dark(a, b)` in a CSS string with `a`, honoring nested parentheses. */
export function resolveLightDark(css: string): string {
  let result = "";
  let index = 0;
  for (;;) {
    const start = css.indexOf(FUNCTION, index);
    if (start < 0) return result + css.slice(index);
    const { depth, comma, cursor } = findFunctionEnd(css, start + FUNCTION.length);
    if (depth !== 0) return result + css.slice(index);
    const end = cursor - 1;
    const first = css.slice(start + FUNCTION.length, comma < 0 ? end : comma).trim();
    result += css.slice(index, start) + resolveLightDark(first);
    index = cursor;
  }
}

function findFunctionEnd(css: string, start: number): { depth: number; comma: number; cursor: number } {
  let depth = 1;
  let comma = -1;
  let cursor = start;
  for (; cursor < css.length && depth > 0; cursor++) {
    const char = css[cursor];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "," && depth === 1 && comma < 0) comma = cursor;
  }
  return { depth, comma, cursor };
}

function pinColorScheme(style: string): string {
  return style.replace(/color-scheme\s*:\s*[^;]*/g, "color-scheme: light");
}

function walk(root: DomEl): DomEl[] {
  const elements: DomEl[] = [root];
  for (const child of elemChildren(root)) elements.push(...walk(child));
  return elements;
}

/** Return the SVG with all adaptive colors resolved to the authored ones. */
export function pinAuthoredColors(svg: string): string {
  if (!svg.includes(FUNCTION) && !/color-scheme\s*:\s*light\s+dark/.test(svg)) return svg;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement as unknown as DomEl | null;
  if (root?.tagName !== "svg") throw new Error("draw.io output is not valid SVG");
  for (const element of walk(root)) {
    const style = attr(element, "style");
    if (style !== null) element.setAttribute("style", pinColorScheme(resolveLightDark(style)));
    if (element.tagName === "style") pinStyleText(element);
  }
  return new XMLSerializer().serializeToString(doc);
}

function pinStyleText(element: DomEl): void {
  for (const node of Array.from(element.childNodes) as (DomEl & { data?: string })[]) {
    if ((node.nodeType === TEXT_NODE || node.nodeType === CDATA_NODE) && node.data) {
      node.data = resolveLightDark(node.data);
      node.nodeValue = node.data;
    }
  }
}

function dimension(value: string | null): number | undefined {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Add an even outer margin to a borderless draw.io SVG: grow the canvas by
 * `margin` on every side and shift the drawing (everything except `defs` and the
 * full-size background rect) into the middle.
 */
export function padSvg(svg: string, margin: number): string {
  if (margin <= 0 || Number.isNaN(margin)) return svg;
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement as unknown as DomEl | null;
  if (root?.tagName !== "svg") throw new Error("draw.io output is not valid SVG");
  const box = (attr(root, "viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  const width = box.length === 4 && box.every(Number.isFinite) ? box[2] : dimension(attr(root, "width"));
  const height = box.length === 4 && box.every(Number.isFinite) ? box[3] : dimension(attr(root, "height"));
  if (width === undefined || height === undefined) throw new Error("SVG has no measurable size to pad");
  const [minX, minY] = box.length === 4 && box.every(Number.isFinite) ? box : [0, 0];

  const node = root as unknown as { appendChild(child: unknown): void };
  const group = doc.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("transform", `translate(${margin - minX},${margin - minY})`);
  group.setAttribute("data-drawme-margin", String(margin)); // NOSONAR: xmldom XML elements have no browser dataset API.
  for (const child of elemChildren(root)) {
    const background = child.tagName === "rect" && attr(child, "width") === "100%" && attr(child, "height") === "100%";
    if (child.tagName === "defs" || child.tagName === "style" || background) continue;
    group.appendChild(child as never);
  }
  node.appendChild(group);
  const newWidth = Math.round((width + 2 * margin) * 100) / 100;
  const newHeight = Math.round((height + 2 * margin) * 100) / 100;
  root.setAttribute("viewBox", `0 0 ${newWidth} ${newHeight}`);
  root.setAttribute("width", `${newWidth}px`);
  root.setAttribute("height", `${newHeight}px`);
  return new XMLSerializer().serializeToString(doc);
}

/** Finish an exported SVG file in place: even margin, then authored colors. */
export async function finishSvgFile(path: string, margin: number): Promise<void> {
  const svg = await readFile(path, "utf8");
  const finished = pinAuthoredColors(padSvg(svg, margin));
  if (finished !== svg) await writeFile(path, finished, "utf8");
}
