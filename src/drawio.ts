/** Public draw.io facade and ownership-aware publication of staged export artifacts. */
import {
  type BigIntStats, accessSync, chmodSync, chownSync, constants, existsSync, lstatSync, readlinkSync,
  realpathSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { enhanceAnimatedSvg, type AnimatedSvgSummary } from "./animation";
import { diagramPages, pageModel, readDiagramXml, withDiagramFiles } from "./diagram-files";
import { type DomEl, firstByTag } from "./dom";
import { type ExportFormat, type ExportMode, type ExportOptions, type ExportPlan, planExport, verifyStagedArtifact } from "./export-policy";
import { collectCellsWithIds, contentBounds } from "./geometry";
import { invokeRenderer, resolveBinary } from "./renderer";
import { assertStandaloneImages } from "./svg-helpers";

export {
  applyLayout, convertMermaid, layoutArgs, mermaidArgs, LAYOUT_PRESETS,
  type LayoutOptions, type LayoutPreset, type LayoutResult, type MermaidOptions, type MermaidResult,
} from "./editable-import";
export { type ExportFormat, type ExportMode, type ExportOptions, type ExportPlan } from "./export-policy";
export { cappedScale, deriveOutput, MAX_FINAL_RASTER_PIXELS, planExport } from "./export-policy";
export { type DrawioInfo, openFile, resolveBinary, run, xvfbScreen } from "./renderer";

export interface ExportResult {
  output: string;
  format: ExportFormat;
  mode: ExportMode;
  embed: boolean;
  /** True only when animated SVG export was explicitly requested and verified. */
  animated: boolean;
  animation?: AnimatedSvgSummary;
  binary: string;
  version?: string;
  /** True if the truncated `-e` PNG IEND chunk was repaired after export. */
  repaired: boolean;
  /** Digest of the verified PNG preview, before publication. */
  previewSha256?: string;
  /** Digest of the verified persistent review board, not a preview receipt. */
  storyboardSha256?: string;
  /** A tracked preview for this source was replaced. Always false for finals. */
  replacedPreview: boolean;
  /** Superseded preview artifacts removed after this successful preview or final export. */
  removedPreviews: string[];
  /** Best-effort preview cleanup failures; the export itself still succeeded. */
  previewCleanupWarnings: string[];
  command: string;
}

export interface PreparedExport {
  /** Return the directory entry commit will replace, rejecting any retargeting since preparation. */
  publicationDestination: () => string;
  commit: () => ExportResult;
  dispose: () => Promise<void>;
}

interface PrepareOptions extends ExportOptions {
  /** Editable source to protect when rendering from a private copy. Its caller holds the lock. */
  logicalInput?: string;
}

interface TrackedPreview {
  displayPath: string;
  /** Never unlink the target of a user-supplied output symlink. */
  removable: boolean;
  file: BigIntStats;
}

/** Preview ownership snapshots, grouped by canonical source and destination. */
const previewOutputs = new Map<string, Map<string, TrackedPreview>>();

interface PreviewCleanup {
  removed: string[];
  warnings: string[];
  /** A tracked preview for the same source existed before this export (even at the same path). */
  replaced: boolean;
}

function fileAt(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function stillOwned(current: BigIntStats | undefined, tracked: TrackedPreview): boolean {
  return current?.isFile() === true && sameFile(current, tracked.file) && current.ctimeNs === tracked.file.ctimeNs &&
    current.mtimeNs === tracked.file.mtimeNs && current.size === tracked.file.size;
}

/** Check and unlink without yielding to another export between those operations. */
function retirePreviews(key: string, destination: string, latest: TrackedPreview | undefined): PreviewCleanup {
  const removed: string[] = [];
  const warnings: string[] = [];
  const retained = new Map<string, TrackedPreview>();
  let replaced = false;
  if (latest) retained.set(destination, latest);
  for (const [path, preview] of previewOutputs.get(key) ?? []) {
    if (path === destination) continue;
    try {
      const current = fileAt(path);
      if (current && !current.isFile()) {
        warnings.push(`${preview.displayPath}: no longer a regular file; left in place`);
      } else if (stillOwned(current, preview)) {
        replaced = true;
        if (preview.removable) {
          unlinkSync(path);
          removed.push(preview.displayPath);
        }
      }
    } catch (error) {
      retained.set(path, preview);
      warnings.push(`${preview.displayPath}: ${(error as Error).message}`);
    }
  }
  if (retained.size > 0) previewOutputs.set(key, retained);
  else previewOutputs.delete(key);
  return { removed, warnings, replaced: latest !== undefined && replaced };
}

async function readPages(input: string): Promise<DomEl[]> {
  const xml = await readDiagramXml(input);
  const root = new DOMParser({ onError: () => { throw new Error("input is not well-formed draw.io XML"); } })
    .parseFromString(xml, "text/xml").documentElement as unknown as DomEl | null;
  if (!root) throw new Error("input XML has no root element");
  return diagramPages(root);
}

function pageSize(page: DomEl | undefined): { width: number; height: number } | undefined {
  const model = page && pageModel(page);
  if (!model) return undefined; // Compressed pages count but their geometry is not available here.
  const { cells, ids } = collectCellsWithIds(firstByTag(model, "root"));
  const bounds = contentBounds(cells, ids);
  return bounds ? { width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY } : undefined;
}

/** Size of the visible content in diagram units, or undefined for an unmeasurable page. */
export async function pageContentSize(input: string, pageIndex: number): Promise<{ width: number; height: number } | undefined> {
  return pageSize((await readPages(input))[pageIndex - 1]);
}

function rejectSourceAlias(sources: readonly string[], output: string): void {
  const destination = statSync(output, { bigint: true, throwIfNoEntry: false });
  for (const input of sources) {
    const source = statSync(input, { bigint: true });
    if (destination && sameFile(source, destination)) throw new Error(`output aliases the input file: ${output}`);
  }
}

function publicationPath(output: string): string {
  let path = output;
  const seen = new Set<string>();
  for (;;) {
    if (!path || path.endsWith("/") || path.endsWith(sep)) throw new Error(`export destination must name a file: ${output}`);
    const parent = realpathSync.native(dirname(path));
    const entry = join(parent, basename(path));
    if (!fileAt(entry)?.isSymbolicLink()) return entry;
    if (seen.has(entry)) throw new Error(`export destination has a symlink loop: ${output}`);
    seen.add(entry);
    const target = readlinkSync(entry);
    // The final target can be new. Don't collapse '..' across a symlinked directory.
    path = isAbsolute(target) ? target : `${parent}${sep}${target}`;
  }
}

function checkDestination(output: string, sources: readonly string[]): string {
  const destination = publicationPath(output);
  rejectSourceAlias(sources, destination);
  const existing = fileAt(destination);
  if (existing) {
    if (!existing.isFile()) throw new Error(`export destination is not a regular file: ${output}`);
    accessSync(destination, constants.W_OK);
  }
  return destination;
}

/** Renaming over a file must not bypass its write protection or broaden access to its contents. */
function preserveFileAccess(destination: string, existing: BigIntStats, staged: string): void {
  if (!existing.isFile()) throw new Error(`export destination is not a regular file: ${destination}`);
  accessSync(destination, constants.W_OK);
  const rendered = statSync(staged, { bigint: true });
  if (existing.uid !== rendered.uid || existing.gid !== rendered.gid) {
    chownSync(staged, Number(existing.uid), Number(existing.gid));
  }
  chmodSync(staged, Number(existing.mode & 0o777n));
}

function checkedPublicationDestination(output: string, prepared: string): string {
  if (publicationPath(output) !== prepared) throw new Error(`export destination changed: ${output}`);
  return prepared;
}

function publishExport(
  plan: ExportPlan, key: string, sources: readonly string[], destination: string, staged: string, implicitPreview: boolean,
): PreviewCleanup {
  checkedPublicationDestination(plan.output, destination);
  rejectSourceAlias(sources, destination);
  const existing = fileAt(destination);
  const linked = fileAt(plan.output)?.isSymbolicLink() === true;
  const previous = plan.mode === "preview" ? previewOutputs.get(key)?.get(destination) : undefined;
  const replaced = previous !== undefined && stillOwned(existing, previous);
  if (implicitPreview && (linked || (existing && !(replaced && previous?.removable)))) {
    throw new Error(`preview destination is already in use: ${plan.output}; choose an explicit output`);
  }
  if (existing) preserveFileAccess(destination, existing, staged);
  const stagedFile = plan.mode === "preview" ? fileAt(staged) : undefined;
  // The private staging directory is on the same filesystem. Each export installs a new inode.
  renameSync(staged, destination);
  if (plan.reviewRaster) return { removed: [], warnings: [], replaced: false };
  const published = stagedFile && fileAt(destination);
  const latest = published && sameFile(published, stagedFile)
    ? { displayPath: plan.output, removable: !linked, file: published }
    : undefined;
  const cleanup = retirePreviews(key, destination, latest);
  return { ...cleanup, replaced: replaced || cleanup.replaced };
}

/** Export one diagram under the same source transaction used by editable writers. */
export async function exportDiagram(
  opts: ExportOptions,
  finishStagedSvg?: (path: string) => Promise<void>,
): Promise<ExportResult> {
  opts.signal?.throwIfAborted();
  if (!existsSync(opts.input)) throw new Error(`input file not found: ${opts.input}`);
  return withDiagramFiles([opts.input], opts.signal, async () => {
    const prepared = await prepareExport(opts, finishStagedSvg);
    try {
      return prepared.commit();
    } finally {
      await prepared.dispose();
    }
  });
}

/** Stage and verify without publishing. The caller owns the source or holds its transaction lock. */
export async function prepareExport(
  opts: PrepareOptions,
  finishStagedSvg?: (path: string) => Promise<void>,
): Promise<PreparedExport> {
  const { signal, pageIndex } = opts;
  signal?.throwIfAborted();
  // Keep the authored filename and local-image base; only the ownership key is canonical.
  // On POSIX a lexical collapse of '..' across a symlink could select a different file.
  const input = isAbsolute(opts.input) ? opts.input : sep === "/" ? `${process.cwd()}/${opts.input}` : resolve(opts.input);
  const key = realpathSync.native(opts.logicalInput ?? input);
  const sources = opts.logicalInput ? [input, opts.logicalInput] : [input];
  const output = opts.output;
  const explicitDestination = output === undefined ? undefined : checkDestination(output, sources);
  if (pageIndex != null && (!Number.isSafeInteger(pageIndex) || pageIndex < 1)) {
    throw new Error("pageIndex must be a positive integer");
  }
  const pages = await readPages(input);
  if (pageIndex != null && pageIndex > pages.length) {
    throw new Error(`pageIndex ${pageIndex} is out of range: the diagram has ${pages.length} page(s)`);
  }
  const size = pageSize(pages[(pageIndex ?? 1) - 1]);
  const requestedPlan = planExport(opts, undefined, false, size?.width, size?.height);
  const destination = explicitDestination ?? checkDestination(requestedPlan.output, sources);

  const { available, binary, version, reason } = await resolveBinary(opts.binary, signal);
  if (!available || !binary) {
    throw new Error(reason ?? "draw.io CLI not found. Install draw.io desktop (macOS: `brew install --cask drawio`; " +
      "others: https://github.com/jgraph/drawio-desktop/releases), or set DRAWME_DRAWIO_BINARY in Pi's launch environment.");
  }
  // Only discovery can choose the index base; unknown versions must not guess.
  const plan = pageIndex == null ? requestedPlan : planExport(opts, undefined, false, size?.width, size?.height, version ?? "");
  signal?.throwIfAborted();
  const stageDir = await mkdtemp(join(dirname(destination), ".drawme-export-"));
  const dispose = () => rm(stageDir, { recursive: true, force: true });
  try {
    // The encoder is selected by the staged suffix, not by the user's final filename.
    const staged = join(stageDir, `artifact.${plan.format}`);
    const fullArgs = [...plan.args.slice(0, -1), staged, input, ...plan.linuxExtra];
    let command: string;
    try {
      command = await invokeRenderer(binary, fullArgs, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`draw.io export failed: ${(error as Error).message}`, { cause: error });
    }
    signal?.throwIfAborted();
    const verified = await verifyStagedArtifact(plan, staged);
    signal?.throwIfAborted();
    let animation: AnimatedSvgSummary | undefined;
    if (plan.format === "svg" && (plan.animated || finishStagedSvg)) {
      try {
        // The native animation helper verifies resources in its own finalized SVG.
        if (plan.animated) animation = await enhanceAnimatedSvg(input, staged, pageIndex ?? 1);
        signal?.throwIfAborted();
        if (finishStagedSvg) {
          await finishStagedSvg(staged);
          signal?.throwIfAborted();
          if (!fileAt(staged)?.isFile()) throw new Error("finalized SVG is not a regular file");
          assertStandaloneImages(await readFile(staged, { encoding: "utf8", signal }));
        }
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`animated SVG verification failed: ${(error as Error).message}`, { cause: error });
      }
    }
    signal?.throwIfAborted();
    return {
      publicationDestination: () => checkedPublicationDestination(plan.output, destination),
      commit() {
        signal?.throwIfAborted();
        const cleanup = publishExport(plan, key, sources, destination, staged, plan.mode === "preview" && output === undefined);
        return {
          output: plan.output, format: plan.format, mode: plan.mode, embed: plan.embed,
          animated: plan.animated, animation, binary, version, ...verified,
          replacedPreview: cleanup.replaced, removedPreviews: cleanup.removed,
          previewCleanupWarnings: cleanup.warnings, command,
        };
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
