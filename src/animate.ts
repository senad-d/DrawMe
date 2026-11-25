/**
 * `drawio_animate` orchestration: validate a typed motion spec against a page,
 * store it on the page root cell, export the page to SVG with the draw.io CLI,
 * inject the compiled motion, and render a storyboard PNG for review.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { DomEl } from "./dom";
import { analyzeDrawioAnimation } from "./animation";
import { exportDiagram } from "./drawio";
import {
  type MotionSpec,
  compileMotion,
  injectMotion,
  motionCells,
  parseMotionSpec,
  readStoredMotion,
  selectPage,
  storeMotion,
  themeAccent,
} from "./motion";
import { buildStoryboard, sampleFrames } from "./storyboard";
import { withSourceEdits } from "./source-edits";
import { readDiagramXml } from "./xml-input";

export interface AnimateOptions {
  input: string;
  /** New motion steps. Omit to re-export the motion already stored on the page. */
  steps?: unknown[];
  loop?: boolean;
  hold?: number;
  pageIndex?: number;
  output?: string;
  /** Render a storyboard PNG of sampled visual-batch end states (default true). */
  storyboard?: boolean;
  binary?: string;
  /** Internal cancellation signal, not part of the tool schema. */
  signal?: AbortSignal;
}

export interface AnimateResult {
  source: string;
  /** True when the motion spec was written into the source file. */
  saved: boolean;
  page: string;
  output: string;
  steps: number;
  loop: boolean;
  sequenceMs: number;
  durationMs: number;
  animatedCells: number;
  drawnConnectors: number;
  travellingDots: number;
  connectorFlows: number;
  storyboard?: string;
  storyboardFrames?: number;
  storyboardFramesTotal?: number;
  binary: string;
  version?: string;
}

function serialize(original: string, doc: unknown): string {
  let serialized = new XMLSerializer().serializeToString(doc as never);
  const declaration = /^<\?xml[^>]*\?>/.exec(original)?.[0];
  if (declaration && !serialized.startsWith("<?xml")) serialized = `${declaration}\n${serialized}`;
  if (original.endsWith("\n") && !serialized.endsWith("\n")) serialized += "\n";
  return serialized;
}

function resolveSpec(opts: AnimateOptions, model: DomEl): { spec: MotionSpec; changed: boolean } {
  const stored = readStoredMotion(model);
  const validate = (raw: unknown): MotionSpec => {
    const errors: string[] = [];
    const spec = parseMotionSpec(raw, errors);
    if (!spec || errors.length > 0) throw new Error(errors.join("; ") || "motion specification is invalid");
    return spec;
  };
  if (opts.steps !== undefined) {
    const spec = validate({ loop: opts.loop, hold: opts.hold, steps: opts.steps });
    return { spec, changed: JSON.stringify(spec) !== stored };
  }
  if (stored === null || stored.trim() === "") {
    throw new Error("the page has no stored motion; pass steps to define one");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    throw new Error(`stored motion contains malformed JSON: ${(error as Error).message}`, { cause: error });
  }
  // An override must not mask an invalid stored value, and must itself pass the same checks as new steps.
  const original = validate(parsed);
  if (opts.loop === undefined && opts.hold === undefined) return { spec: original, changed: false };
  const spec = validate({
    ...original,
    loop: opts.loop === undefined ? original.loop : opts.loop,
    hold: opts.hold === undefined ? original.hold : opts.hold,
  });
  return { spec, changed: original.loop !== spec.loop || original.hold !== spec.hold };
}

/** Validate, store, export, and verify motion for one page. Throws on any failure. */
export async function animateDiagram(opts: AnimateOptions): Promise<AnimateResult> {
  const { input, signal } = opts;
  const pageIndex = opts.pageIndex ?? 1;
  const stem = input.slice(0, input.length - extname(input).length);
  const defaultOutput = `${stem}.animated.svg`;
  const output = opts.output ?? defaultOutput;
  const boardOutput = (opts.storyboard ?? true)
    ? pageIndex === 1 && output === defaultOutput ? `${stem}.storyboard.png` : `${output}.page-${pageIndex}.board.png`
    : undefined;
  const writablePaths = boardOutput ? [input, output, boardOutput] : [input, output];
  return withSourceEdits(writablePaths, () => animatePage(opts, pageIndex, output, boardOutput), signal);
}

async function animatePage(opts: AnimateOptions, pageIndex: number, output: string, boardOutput?: string): Promise<AnimateResult> {
  const { signal } = opts;
  const xml = await readDiagramXml(opts.input).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`input file not found: ${opts.input}`, { cause: error });
    throw error;
  });
  signal?.throwIfAborted();
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const root = doc.documentElement as unknown as DomEl | null;
  if (!root) throw new Error("no root element (malformed XML)");
  const { model, name } = selectPage(root, pageIndex);

  // Analyze native animation on its own parse: cell collection rewrites wrapper ids in the DOM it reads.
  const native = analyzeDrawioAnimation(xml, pageIndex);
  if (native.errors.length > 0) throw new Error(native.errors.join("; "));
  if (native.sequence?.enabled) {
    throw new Error(
      "the page already has a native draw.io page animation; remove its animation attribute (or set enabled:false) so the motion steps are the only timeline",
    );
  }

  const { spec, changed } = resolveSpec(opts, model);
  const analysis = compileMotion(spec, motionCells(model), themeAccent(model));
  if (!analysis.compiled) throw new Error(analysis.errors.join("; "));
  const motion = analysis.compiled;

  if (changed) {
    storeMotion(model, JSON.stringify(spec));
    const updated = serialize(xml, doc);
    signal?.throwIfAborted();
    // Once writing starts, finish the in-place edit rather than leave a partial XML file on abort.
    await writeFile(opts.input, updated, "utf8");
  }

  const exported = await exportDiagram(
    { input: opts.input, format: "svg", mode: "final", output, pageIndex, binary: opts.binary, signal },
    async (staged) => {
      const svg = await readFile(staged, { encoding: "utf8", signal });
      await writeFile(staged, injectMotion(svg, motion, native.flowEdgeIds), { signal });
    },
  );

  const result: AnimateResult = {
    source: opts.input,
    saved: changed,
    page: name,
    output,
    steps: spec.steps.length,
    loop: motion.loop,
    sequenceMs: Math.round(motion.sequenceMs),
    durationMs: Math.round(motion.durationMs),
    animatedCells: motion.targetCellIds.length,
    drawnConnectors: motion.drawInEdgeIds.length,
    travellingDots: motion.dots.length,
    connectorFlows: native.flowEdgeIds.length,
    binary: exported.binary,
    version: exported.version,
  };

  if (boardOutput !== undefined) {
    signal?.throwIfAborted();
    const frames = sampleFrames(motion.frames);
    const tempDir = await mkdtemp(join(tmpdir(), "drawme-storyboard-"));
    try {
      const boardSource = join(tempDir, "storyboard.drawio");
      await writeFile(boardSource, buildStoryboard(model, frames), { signal });
      const board = await exportDiagram({
        input: boardSource,
        format: "png",
        mode: "final",
        embed: false,
        width: 2000,
        output: boardOutput,
        binary: opts.binary,
        signal,
      });
      result.storyboard = board.output;
      result.storyboardFrames = frames.length;
      result.storyboardFramesTotal = motion.frames.length;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  return result;
}
