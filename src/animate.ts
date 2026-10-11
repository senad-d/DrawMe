/**
 * `drawio_animate` orchestration: validate a typed motion spec against a page,
 * store it on the page root cell, export the page to SVG with the draw.io CLI,
 * inject the compiled motion, and render a storyboard PNG for review.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
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

export interface AnimateOptions {
  input: string;
  /** New motion steps. Omit to re-export the motion already stored on the page. */
  steps?: unknown[];
  loop?: boolean;
  hold?: number;
  pageIndex?: number;
  output?: string;
  /** Render a storyboard PNG of the step end states (default true). */
  storyboard?: boolean;
  binary?: string;
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

function stem(path: string): string {
  const ext = extname(path);
  return join(dirname(path), ext ? basename(path).slice(0, -ext.length) : basename(path));
}

function serialize(original: string, doc: unknown): string {
  let serialized = new XMLSerializer().serializeToString(doc as never);
  const declaration = /^<\?xml[^>]*\?>/.exec(original)?.[0];
  if (declaration && !serialized.startsWith("<?xml")) serialized = `${declaration}\n${serialized}`;
  if (original.endsWith("\n") && !serialized.endsWith("\n")) serialized += "\n";
  return serialized;
}

function resolveSpec(opts: AnimateOptions, model: DomEl): { spec: MotionSpec; changed: boolean } {
  const errors: string[] = [];
  let spec: MotionSpec | null;
  const stored = readStoredMotion(model);
  if (opts.steps !== undefined) {
    spec = parseMotionSpec({ loop: opts.loop, hold: opts.hold, steps: opts.steps }, errors);
  } else {
    if (stored === null || stored.trim() === "") {
      throw new Error("the page has no stored motion; pass steps to define one");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch (error) {
      throw new Error(`stored motion contains malformed JSON: ${(error as Error).message}`, { cause: error });
    }
    spec = parseMotionSpec(parsed, errors);
    if (spec && opts.loop !== undefined) spec.loop = opts.loop;
    if (spec && opts.hold !== undefined) spec.hold = opts.hold;
  }
  if (!spec || errors.length > 0) throw new Error(errors.join("; ") || "motion specification is invalid");
  return { spec, changed: JSON.stringify(spec) !== stored };
}

/** Validate, store, export, and verify motion for one page. Throws on any failure. */
export async function animateDiagram(opts: AnimateOptions): Promise<AnimateResult> {
  if (!existsSync(opts.input)) throw new Error(`input file not found: ${opts.input}`);
  const pageIndex = opts.pageIndex ?? 1;
  const xml = await readFile(opts.input, "utf8");
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
    await writeFile(opts.input, serialize(xml, doc), "utf8");
  }

  const output = opts.output ?? `${stem(opts.input)}.animated.svg`;
  const exported = await exportDiagram({ input: opts.input, format: "svg", mode: "final", output, pageIndex, binary: opts.binary });
  try {
    const svg = await readFile(output, "utf8");
    await writeFile(output, injectMotion(svg, motion, native.flowEdgeIds), "utf8");
  } catch (error) {
    await rm(output, { force: true });
    throw new Error(`animated SVG verification failed: ${(error as Error).message}`, { cause: error });
  }

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

  if (opts.storyboard ?? true) {
    const frames = sampleFrames(motion.frames);
    const tempDir = await mkdtemp(join(tmpdir(), "drawme-storyboard-"));
    try {
      const boardSource = join(tempDir, "storyboard.drawio");
      await writeFile(boardSource, buildStoryboard(model, frames), "utf8");
      const board = await exportDiagram({
        input: boardSource,
        format: "png",
        mode: "final",
        embed: false,
        width: 2000,
        output: `${stem(opts.input)}.storyboard.png`,
        binary: opts.binary,
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
