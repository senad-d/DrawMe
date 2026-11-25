/** Native Mermaid conversion and geometry-only layout of editable diagrams. */
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { DOMParser, XMLSerializer, onErrorStopParsing, type Document, type Element } from "@xmldom/xmldom";
import { type DomEl, attr, diagramPages, firstByTag, pageModel } from "./dom";
import { collectCellsWithIds } from "./geometry";
import { invokeRenderer, resolveBinary } from "./renderer";
import { withSourceEdits } from "./source-edits";
import { readDiagramXml } from "./xml-input";

/** Args for a Mermaid → .drawio conversion (pure, for testing). */
export function mermaidArgs(mmdPath: string, output: string): string[] {
  return ["-x", "-f", "xml", "-o", output, mmdPath];
}

export interface MermaidOptions {
  /** Path to a `.mmd` file. Mutually exclusive with inline Mermaid. */
  input?: string;
  /** Inline Mermaid text (written to a temporary `.mmd`). */
  mermaid?: string;
  output?: string;
  binary?: string;
}

export interface MermaidResult {
  output: string;
  binary: string;
  version?: string;
  command: string;
}

/** ELK layout presets the CLI accepts. Any other value opens a modal that hangs headless runs. */
export const LAYOUT_PRESETS = ["verticalFlow", "horizontalFlow", "verticalTree", "horizontalTree", "radialTree", "organic"] as const;
export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];

/** Args for an ELK `--layout` pass (pure, for testing). */
export function layoutArgs(input: string, preset: LayoutPreset, output: string): string[] {
  return ["-x", "-f", "xml", "--layout", preset, "-o", output, input];
}

export interface LayoutOptions {
  input: string;
  preset: LayoutPreset;
  /** Defaults to a sibling `<name>.layout.drawio` (pass the input as output for in-place layout). */
  output?: string;
  binary?: string;
}

export interface LayoutResult {
  output: string;
  preset: LayoutPreset;
  binary: string;
  version?: string;
  command: string;
}

export function absoluteFile(path: string): string {
  if (isAbsolute(path)) return path;
  if (process.platform === "win32" && /^[a-z]:/i.test(path)) return resolve(path);
  // Let the filesystem resolve '..' after symlinked directories, not before.
  return `${process.cwd()}${sep}${path}`;
}

export function siblingOutput(input: string, suffix: string): string {
  const directory = dirname(input);
  const name = `${basename(input, extname(input))}${suffix}`;
  if (directory === ".") return name;
  const hasSeparator = directory.endsWith(sep) || directory.endsWith("/");
  const driveRelative = process.platform === "win32" && /^[a-z]:$/i.test(directory);
  return `${directory}${hasSeparator || driveRelative ? "" : sep}${name}`;
}

async function featureRenderer(feature: "Mermaid" | "Layout", override?: string): Promise<{ binary: string; version?: string }> {
  const info = await resolveBinary(override);
  if (!info.available || !info.binary) {
    throw new Error(info.reason ?? "draw.io CLI not found. Install draw.io desktop.");
  }
  if (!(feature === "Mermaid" ? info.supportsMermaid : info.supportsLayout)) {
    const name = feature === "Mermaid" ? "Mermaid conversion" : "The --layout pass";
    throw new Error(`${name} requires draw.io 30.2.4 or later (found ${info.version ?? "an unknown version"}).`);
  }
  return { binary: info.binary, version: info.version };
}

function outputFile(output: string): string {
  if (!output || output.endsWith("/") || output.endsWith(sep)) {
    throw new Error(`output must name a file: ${output}`);
  }
  return absoluteFile(output);
}

async function checkOutputFile(path: string): Promise<void> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (info && !info.isFile()) throw new Error(`output must name a regular file: ${path}`);
}

export function parseDiagram(xml: string, kind: string): { doc: Document; root: Element; pages: DomEl[] } {
  let doc: Document;
  try {
    doc = new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, "text/xml");
  } catch (error) {
    throw new Error(`${kind} is not well-formed draw.io XML`, { cause: error });
  }
  const root = doc.documentElement;
  if (!root) throw new Error(`${kind} is missing a draw.io XML root`);
  return { doc, root, pages: diagramPages(root as unknown as DomEl) };
}

async function readRendererOutput(path: string, operation: string): Promise<string> {
  try {
    return await readDiagramXml(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${operation} produced no output`, { cause: error });
    throw error;
  }
}

function serializeDiagram(doc: Document, original: string): string {
  const xml = new XMLSerializer().serializeToString(doc);
  return original.endsWith("\n") && !xml.endsWith("\n") ? `${xml}\n` : xml;
}

/** Convert exactly one Mermaid input. Import already lays out the graph; no extra layout pass. */
export async function convertMermaid(opts: MermaidOptions): Promise<MermaidResult> {
  const { input, mermaid = "" } = opts;
  if (input !== undefined ? !input || opts.mermaid !== undefined : !mermaid.trim()) {
    throw new Error("provide exactly one of `input` (a .mmd file path) or `mermaid` (nonblank inline Mermaid text)");
  }
  const output = opts.output ?? (input ? siblingOutput(input, ".drawio") : join(process.cwd(), "diagram.drawio"));
  const destination = outputFile(output);
  const source = input ? absoluteFile(input) : undefined;
  const renderer = await featureRenderer("Mermaid", opts.binary);

  return withSourceEdits(source ? [source, destination] : [destination], async () => {
    if (source) {
      const info = await stat(source).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`input file not found: ${input}`, { cause: error });
        throw error;
      });
      if (!info.isFile()) throw new Error(`input is not a regular file: ${input}`);
    }
    await checkOutputFile(destination);
    const temp = await mkdtemp(join(absoluteFile(tmpdir()), "drawme-import-"));
    try {
      const mmd = source ?? join(temp, "diagram.mmd");
      if (!source) await writeFile(mmd, mermaid, "utf8");
      const staged = join(temp, "import.drawio");
      const command = await invokeRenderer(renderer.binary, mermaidArgs(mmd, staged));
      const xml = await readRendererOutput(staged, "conversion");
      const { doc, pages } = parseDiagram(xml, "conversion result");
      if (!pages.length) throw new Error("conversion produced no diagram pages");
      for (const page of pages) {
        const model = pageModel(page);
        if (!model || !firstByTag(model, "root")) throw new Error("conversion did not produce an uncompressed graph model with a root");
        model.setAttribute("page", "1");
      }
      // Write the existing inode if present so cooperating editors through links see the same file.
      await writeFile(destination, serializeDiagram(doc, xml), "utf8");
      return { output, ...renderer, command };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}

function pageCells(page: DomEl | undefined, kind: string) {
  const model = page && pageModel(page);
  const root = model && firstByTag(model, "root");
  if (!root) throw new Error(`${kind} must have an uncompressed first page with a graph root`);
  const { cells, ids } = collectCellsWithIds(root);
  if (ids.has("") || ids.size !== cells.length) throw new Error(`${kind} must have unique nonempty cell IDs`);
  return ids;
}

function sameTopology(before: DomEl, after: DomEl): boolean {
  return ["parent", "source", "target"].every((name) => (attr(before, name) ?? "") === (attr(after, name) ?? "")) &&
    ["vertex", "edge"].every((name) => (attr(before, name) === "1") === (attr(after, name) === "1"));
}

function mergeGeometry(doc: Document, source: ReturnType<typeof pageCells>, laidOut: ReturnType<typeof pageCells>): void {
  if (source.size !== laidOut.size) throw new Error("layout result cell IDs do not match the original first page");
  for (const [id, cell] of source) {
    const rendered = laidOut.get(id);
    if (!rendered) throw new Error(`layout result is missing cell ID ${id}`);
    if (!sameTopology(cell, rendered)) throw new Error(`layout result changed the graph topology at cell ${id}`);

    const before = firstByTag(cell, "mxGeometry") as unknown as Element | null;
    const after = firstByTag(rendered, "mxGeometry") as unknown as Element | null;
    if (!after) {
      if (before) throw new Error(`layout result is missing geometry for cell ${id}`);
      continue;
    }
    const element = cell as unknown as Element;
    const geometry = doc.importNode(after, true);
    if (before) element.replaceChild(geometry, before);
    else element.appendChild(geometry);
  }
}

/** Lay out the first page by copying geometry only; keep page settings and all other pages. */
export async function applyLayout(opts: LayoutOptions): Promise<LayoutResult> {
  if (!LAYOUT_PRESETS.includes(opts.preset)) {
    throw new Error(`unknown layout preset '${opts.preset}'. Allowed: ${LAYOUT_PRESETS.join(", ")}`);
  }
  const input = absoluteFile(opts.input);
  const output = opts.output ?? siblingOutput(opts.input, ".layout.drawio");
  const destination = outputFile(output);
  return withSourceEdits([input, destination], async () => {
    const xml = await readDiagramXml(input);
    const { doc, pages } = parseDiagram(xml, "layout input");
    const original = pageCells(pages[0], "layout input");
    await checkOutputFile(destination);
    const renderer = await featureRenderer("Layout", opts.binary);

    const temp = await mkdtemp(join(absoluteFile(tmpdir()), "drawme-layout-"));
    try {
      const staged = join(temp, "layout.drawio");
      const command = await invokeRenderer(renderer.binary, layoutArgs(input, opts.preset, staged));
      const layout = parseDiagram(await readRendererOutput(staged, "layout"), "layout result");
      mergeGeometry(doc, original, pageCells(layout.pages[0], "layout result"));
      await writeFile(destination, serializeDiagram(doc, xml), "utf8");
      return { output, preset: opts.preset, ...renderer, command };
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}
