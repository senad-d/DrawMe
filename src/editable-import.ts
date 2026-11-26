/** Mermaid import and geometry-only ELK layout through the trusted desktop renderer. */
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";
import { DEFAULT_VALIDATION_LIMITS, diagramPages, pageModel, readDiagramXml, withDiagramFiles } from "./diagram-files";
import { type DomEl, firstByTag } from "./dom";
import { collectCellsWithIds } from "./geometry";
import { type DrawioInfo, invokeRenderer, resolveBinary } from "./renderer";

export interface MermaidOptions {
  /** Path to a `.mmd` file. */
  input?: string;
  /** Inline Mermaid text, mutually exclusive with a file input. */
  mermaid?: string;
  output?: string;
  binary?: string;
  /** Session directory for the default inline destination. */
  cwd?: string;
}
export interface MermaidResult {
  output: string;
  binary: string;
  version?: string;
  command: string;
}

/** Unknown presets can open a modal that hangs headless runs. */
export const LAYOUT_PRESETS = ["verticalFlow", "horizontalFlow", "verticalTree", "horizontalTree", "radialTree", "organic"] as const;
export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];

export interface LayoutOptions {
  input: string;
  preset: LayoutPreset;
  /** Defaults to a sibling `<name>.layout.drawio`. */
  output?: string;
  binary?: string;
}
export interface LayoutResult extends MermaidResult {
  preset: LayoutPreset;
}

export function mermaidArgs(input: string, output: string): string[] {
  return ["-x", "-f", "xml", "-o", output, input];
}

export function layoutArgs(input: string, preset: LayoutPreset, output: string): string[] {
  return ["-x", "-f", "xml", "--layout", preset, "-o", output, input];
}

async function requireBinary(feature: "supportsMermaid" | "supportsLayout", override?: string): Promise<DrawioInfo & { binary: string }> {
  const info = await resolveBinary(override);
  if (!info.available || !info.binary) {
    throw new Error(info.reason ?? "draw.io CLI not found. Install draw.io desktop (macOS: `brew install --cask drawio`; " +
      "others: https://github.com/jgraph/drawio-desktop/releases), or set DRAWME_DRAWIO_BINARY in Pi's launch environment.");
  }
  if (!info[feature]) {
    const label = feature === "supportsMermaid" ? "Mermaid conversion" : "The --layout pass";
    throw new Error(`${label} needs draw.io v30.2.4 or later (detected ${info.version ?? "unknown version"}). Upgrade draw.io Desktop.`);
  }
  return { ...info, binary: info.binary };
}

function appendPath(directory: string, name: string): string {
  // On POSIX only the filesystem may resolve '..' after a directory symlink.
  if (sep === "/") return directory.endsWith(sep) ? directory + name : directory + sep + name;
  return join(directory, name);
}

function absoluteOperand(path: string): string {
  if (sep !== "/") return resolve(path);
  return isAbsolute(path) ? path : appendPath(process.cwd(), path);
}

function resolveOutput(path: string): string {
  if (path.endsWith("/") || path.endsWith(sep) || !path) throw new Error(`editable destination must name a file: ${path}`);
  return absoluteOperand(path);
}

async function readInput<T>(path: string, inspect: (path: string) => Promise<T>): Promise<T> {
  try { return await inspect(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`input file not found: ${path}`, { cause: error });
    throw error;
  }
}

async function readRenderOutput(path: string, operation: "conversion" | "layout"): Promise<string> {
  try { return await readDiagramXml(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${operation} produced no output`, { cause: error });
    throw new Error(`${operation} output could not be read: ${(error as Error).message}`, { cause: error });
  }
}

function parseEditableXml(xml: string, description: string) {
  let doc;
  try {
    doc = new DOMParser({ onError: () => { throw new Error("XML parser diagnostic"); } }).parseFromString(xml, "text/xml");
  } catch {
    throw new Error(`${description} is not well-formed XML`);
  }
  if (!doc.documentElement || !["mxfile", "diagram", "mxGraphModel"].includes(doc.documentElement.tagName)) {
    throw new Error(`${description} is not a draw.io document`);
  }
  return { doc, root: doc.documentElement as unknown as DomEl };
}

function requireGraph(model: DomEl | null, description: string): { model: Element; root: DomEl } {
  const root = model && firstByTag(model, "root");
  if (!model || !root) throw new Error(`${description} has no readable <mxGraphModel> with a <root>`);
  return { model: model as unknown as Element, root };
}

/** Publish only inspected bytes, retaining the identity of existing editable files. */
async function writeEditableFile(path: string, xml: string): Promise<void> {
  const notFile = () => new Error(`editable destination is not a regular file: ${path}`);
  try {
    if (!(await stat(path)).isFile()) throw notFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Check the actual descriptor before truncating: a replaced FIFO must neither
  // block this process nor receive the document contents.
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await fd.stat()).isFile()) throw notFile();
    await fd.truncate(0);
    await fd.writeFile(xml, "utf8");
  } finally {
    await fd.close();
  }
}

/** Convert exactly one Mermaid source to a new, finite, already laid-out diagram. */
export async function convertMermaid(opts: MermaidOptions): Promise<MermaidResult> {
  const input = opts.input?.trim() ? absoluteOperand(opts.input) : undefined;
  const inline = opts.mermaid ?? "";
  if (!!input === !!inline.trim()) throw new Error("provide exactly one of `input` (a .mmd file path) or `mermaid` (inline Mermaid text)");
  const output = resolveOutput(opts.output ?? (input
    ? appendPath(dirname(input), `${basename(input, extname(input))}.drawio`)
    : appendPath(absoluteOperand(opts.cwd ?? process.cwd()), "diagram.drawio")));

  // Check the source name separately: lock canonicalization can fail if its parent is absent.
  if (input) await readInput(input, stat);
  return withDiagramFiles(input ? [input, output] : [output], undefined, async () => {
    if (input) await readInput(input, readDiagramXml);
    else if (Buffer.byteLength(inline) > DEFAULT_VALIDATION_LIMITS.maxBytes) {
      throw new Error(`inline Mermaid exceeds the ${DEFAULT_VALIDATION_LIMITS.maxBytes} byte limit`);
    }
    const { binary, version } = await requireBinary("supportsMermaid", opts.binary);
    const dir = await mkdtemp(appendPath(absoluteOperand(tmpdir()), "drawme-mmd-"));
    try {
      const source = input ?? appendPath(dir, "diagram.mmd");
      if (!input) await writeFile(source, inline, "utf8");
      const staged = appendPath(dir, "converted.drawio");
      const command = await invokeRenderer(binary, mermaidArgs(source, staged));
      const xml = await readRenderOutput(staged, "conversion");
      const { doc, root } = parseEditableXml(xml, "conversion output");
      const pages = diagramPages(root);
      if (!pages.length) throw new Error("conversion output has no diagram pages");
      for (const page of pages) {
        requireGraph(pageModel(page), "conversion output").model.setAttribute("page", "1");
      }
      await writeEditableFile(output, new XMLSerializer().serializeToString(doc));
      return { output, binary, version, command };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

/** Draw.io's compressed pages hold a base64 raw-deflate payload of URI-encoded XML. */
function readLayoutModel(page: DomEl): { model: DomEl | null; compressed: boolean } {
  const model = pageModel(page);
  if (model || page.tagName !== "diagram") return { model, compressed: false };
  const payload = (page as unknown as Element).textContent?.trim();
  if (!payload) return { model: null, compressed: false };
  try {
    const data = inflateRawSync(Buffer.from(payload, "base64"), { maxOutputLength: DEFAULT_VALIDATION_LIMITS.maxBytes });
    const { root } = parseEditableXml(decodeURIComponent(data.toString("utf8")), "compressed page");
    if (root.tagName === "mxGraphModel") return { model: root, compressed: true };
  } catch {
    // The diagnostic below is also used for malformed or over-limit compressed data.
  }
  throw new Error("cannot read the compressed first page for layout; save it as uncompressed draw.io XML");
}

/** A layout is a geometry update, not a replacement for user objects, labels,
 * styles, IDs, or connections. Import only mxGeometry, including route points. */
function mergeLayoutGeometry(sourceRoot: DomEl, outputRoot: DomEl): void {
  const input = collectCellsWithIds(sourceRoot);
  const rendered = collectCellsWithIds(outputRoot);
  for (const { cells, ids } of [input, rendered]) {
    if (cells.length !== ids.size || ids.has("")) throw new Error("layout requires unique, nonempty cell IDs in both input and output");
  }
  for (const [id, cell] of input.ids) {
    const placed = rendered.ids.get(id);
    if (!placed || ["parent", "source", "target", "edge", "vertex"].some(key =>
      (placed.getAttribute(key) || "") !== (cell.getAttribute(key) || ""))) {
      throw new Error("layout output does not match the input graph");
    }
    const previous = firstByTag(cell, "mxGeometry") as unknown as Element | null;
    const geometry = firstByTag(placed, "mxGeometry") as unknown as Element | null;
    if (!geometry) {
      if (previous) throw new Error("layout output is missing cell geometry");
      continue;
    }
    const element = cell as unknown as Element;
    const next = element.ownerDocument!.importNode(geometry, true);
    if (previous) element.replaceChild(next, previous);
    else element.appendChild(next);
  }
}

/** Lay out only the first page. Preserve the authored document and canvas settings. */
export async function applyLayout(opts: LayoutOptions): Promise<LayoutResult> {
  if (!LAYOUT_PRESETS.includes(opts.preset)) {
    throw new Error(`unknown layout preset '${opts.preset}'. Allowed: ${LAYOUT_PRESETS.join(", ")}`);
  }
  const input = absoluteOperand(opts.input);
  const output = resolveOutput(opts.output ?? appendPath(dirname(input), `${basename(input, extname(input))}.layout.drawio`));
  await readInput(input, stat);
  return withDiagramFiles([input, output], undefined, async () => {
    const xml = await readInput(input, readDiagramXml);
    const { doc, root } = parseEditableXml(xml, "layout input");
    const [page] = diagramPages(root);
    const selected = page ? readLayoutModel(page) : { model: null, compressed: false };
    const { model, root: sourceRoot } = requireGraph(selected.model, "layout input first page");
    const { binary, version } = await requireBinary("supportsLayout", opts.binary);
    const dir = await mkdtemp(appendPath(absoluteOperand(tmpdir()), "drawme-layout-"));
    try {
      const serializer = new XMLSerializer();
      const name = basename(input);
      const source = appendPath(dir, name);
      const staged = appendPath(dir, name.toLowerCase() === "layout.drawio" ? "layout-result.drawio" : "layout.drawio");
      await writeFile(source, `<mxfile compressed="false"><diagram>${serializer.serializeToString(model)}</diagram></mxfile>`, "utf8");
      const command = await invokeRenderer(binary, layoutArgs(source, opts.preset, staged));
      const result = parseEditableXml(await readRenderOutput(staged, "layout"), "layout output");
      const pages = diagramPages(result.root);
      const returned = pages.length === 1 ? pageModel(pages[0]) : null;
      mergeLayoutGeometry(sourceRoot, requireGraph(returned, "layout output").root);
      if (selected.compressed) {
        const payload = deflateRawSync(encodeURIComponent(serializer.serializeToString(model))).toString("base64");
        (page as unknown as Element).textContent = payload;
      }
      let updated = serializer.serializeToString(doc);
      if (xml.endsWith("\n") && !updated.endsWith("\n")) updated += "\n";
      await writeEditableFile(output, updated);
      return { output, preset: opts.preset, binary, version, command };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
