/**
 * `drawio_animate` orchestration: validate a typed motion spec against a page,
 * store it on the page root cell, export the page to SVG with the draw.io CLI,
 * inject the compiled motion, and render a storyboard PNG for review.
 */
import { randomUUID } from "node:crypto";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { DomEl } from "./dom";
import { analyzeDrawioAnimation } from "./animation";
import { readDiagramXml, withDiagramFiles } from "./diagram-files";
import { prepareExport, type PreparedExport } from "./drawio";
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
  storyboardSha256?: string;
  storyboardFrames?: number;
  storyboardFramesTotal?: number;
  binary: string;
  version?: string;
}

function stem(path: string): string {
  const ext = extname(path);
  return join(dirname(path), ext ? basename(path).slice(0, -ext.length) : basename(path));
}

const ANIMATED_SUFFIX = ".animated.svg";

function storyboardPath(output: string, pageIndex: number): string {
  const name = basename(output);
  return join(dirname(output), pageIndex === 1 && name.endsWith(ANIMATED_SUFFIX)
    ? `${name.slice(0, -ANIMATED_SUFFIX.length)}.storyboard.png`
    : `${name}.storyboard-p${pageIndex}.png`);
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
    if (spec && errors.length === 0 && (opts.loop !== undefined || opts.hold !== undefined)) {
      spec = parseMotionSpec({
        ...spec,
        loop: opts.loop === undefined ? spec.loop : opts.loop,
        hold: opts.hold === undefined ? spec.hold : opts.hold,
      }, errors);
    }
  }
  if (!spec || errors.length > 0) throw new Error(errors.join("; ") || "motion specification is invalid");
  return { spec, changed: JSON.stringify(spec) !== stored };
}

type AnimateRequest = AnimateOptions & { signal?: AbortSignal };

/** Validate, store, export, and verify motion for one page under the source lock. */
export async function animateDiagram(opts: AnimateRequest): Promise<AnimateResult> {
  opts.signal?.throwIfAborted();
  if (!existsSync(opts.input)) throw new Error(`input file not found: ${opts.input}`);
  return withDiagramFiles([opts.input], opts.signal, () => animatePage(opts));
}

async function animatePage(opts: AnimateRequest): Promise<AnimateResult> {
  const { input, binary, signal } = opts;
  const pageIndex = opts.pageIndex ?? 1;
  const xml = await readDiagramXml(input);
  const doc = new DOMParser({ onError: () => { throw new Error("input is not well-formed draw.io XML"); } })
    .parseFromString(xml, "text/xml");
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

  signal?.throwIfAborted();
  // The editable save is independent of rendering; keep its inode and use the
  // original input for SVG so draw.io retains the authored image base.
  if (changed) {
    storeMotion(model, JSON.stringify(spec));
    await writeFile(input, serialize(xml, doc), "utf8");
  }

  const output = opts.output ?? `${stem(input)}${ANIMATED_SUFFIX}`;
  const svg = await prepareExport(
    { input, format: "svg", mode: "final", output, pageIndex, binary, signal },
    async (staged) => {
      const svg = await readFile(staged, { encoding: "utf8", signal });
      await writeFile(staged, injectMotion(svg, motion, native.flowEdgeIds), "utf8");
    },
  );

  let board: PreparedExport | undefined;
  let boardSource: string | undefined;
  try {
    const frames = opts.storyboard === false ? undefined : sampleFrames(motion.frames);
    if (frames) {
      signal?.throwIfAborted();
      const boardXml = buildStoryboard(model, frames);
      // A private sibling .drawio keeps any relative images based at the
      // same directory as in the authored SVG input.
      const temp = join(dirname(input), `.drawme-storyboard-${randomUUID()}.drawio`);
      const file = await open(temp, "wx", 0o600);
      boardSource = temp;
      try {
        await file.writeFile(boardXml, "utf8");
      } finally {
        await file.close();
      }
      board = await prepareExport({
        input: boardSource, logicalInput: input, format: "png", mode: "final",
        embed: false, reviewRaster: true, output: storyboardPath(output, pageIndex), binary, signal,
      });
    }

    // Abort cannot split the publications or retire a preview mid-transaction.
    // A synchronous filesystem failure is not an all-files rollback boundary.
    signal?.throwIfAborted();
    // If a board supersedes a tracked preview at the same name, replace its
    // inode first so the SVG's preview retirement cannot unlink the board.
    const review = board?.commit();
    const exported = svg.commit();
    return {
      source: input,
      saved: changed,
      page: name,
      output: exported.output,
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
      ...(review && {
        storyboard: review.output,
        storyboardSha256: review.storyboardSha256,
        storyboardFrames: frames?.length,
        storyboardFramesTotal: motion.frames.length,
      }),
    };
  } finally {
    await Promise.all([svg.dispose(), board?.dispose(), boardSource && rm(boardSource, { force: true })]);
  }
}
