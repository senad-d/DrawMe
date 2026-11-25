/** Native draw.io facade and staged diagram export. */
import { addAbortListener } from "node:events";
import {
  type BigIntStats, accessSync, chmodSync, chownSync, constants, existsSync, lstatSync, readlinkSync,
  realpathSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { DOMParser, XMLSerializer, onErrorStopParsing, type Element } from "@xmldom/xmldom";
import { enhanceAnimatedSvg, type AnimatedSvgSummary } from "./animation";
import { type DomEl, diagramPages, firstByTag, pageModel } from "./dom";
import { checkRasterSize, jpegSize, planExportSize } from "./export-size";
import { DEFAULT_FIT_MARGIN } from "./fitcanvas";
import { collectCellsWithIds, contentBounds } from "./geometry";
import { repairPng } from "./png";
import { invokeRenderer, isRootUser, resolveBinary } from "./renderer";
import { finishSvgFile } from "./svgexport";
import { readDiagramXml } from "./xml-input";

export { cappedScale, MAX_FINAL_RASTER_PIXELS } from "./export-size";
export { type DrawioInfo, openFile, resolveBinary, run, xvfbScreen } from "./renderer";
export {
  LAYOUT_PRESETS, applyLayout, convertMermaid, layoutArgs, mermaidArgs,
  type LayoutOptions, type LayoutPreset, type LayoutResult, type MermaidOptions, type MermaidResult,
} from "./import-layout";

export type ExportFormat = "png" | "svg" | "pdf" | "jpg";
export type ExportMode = "preview" | "final";

export interface ExportOptions {
  input: string;
  format?: ExportFormat;
  mode?: ExportMode;
  output?: string;
  scale?: number;
  width?: number;
  height?: number;
  transparent?: boolean;
  border?: number;
  pageIndex?: number;
  embed?: boolean;
  /** Require and verify animation in a final SVG, compiling portable page sequences when present. */
  animated?: boolean;
  binary?: string;
  /** Internal cancellation from the caller, not a tool argument. */
  signal?: AbortSignal;
}

export interface ExportPlan {
  format: ExportFormat;
  mode: ExportMode;
  embed: boolean;
  animated: boolean;
  output: string;
  /** Export flags ending with `-o <output>`. The input path is appended after these. */
  args: string[];
  input: string;
  /** Flags that must go AFTER the input path on Linux (draw.io argument-parsing quirk). */
  linuxExtra: string[];
  /** SVG only: outer margin DrawMe adds after export (draw.io's own SVG border is uneven). */
  svgMargin: number;
}

/** Derive a sibling without resolving `..` across symlinked parents. */
export function deriveOutput(input: string, format: ExportFormat, embed: boolean, mode: ExportMode = "final"): string {
  const dir = dirname(input);
  const base = basename(input, extname(input));
  const suffix = mode === "preview" ? `.preview.${format}` : format === "png" && embed ? ".drawio.png" : `.${format}`;
  if (dir === ".") return base + suffix;
  const hasSeparator = dir.endsWith(sep) || dir.endsWith("/");
  const driveRelative = process.platform === "win32" && /^[a-z]:$/i.test(dir);
  return `${dir}${hasSeparator || driveRelative ? "" : sep}${base}${suffix}`;
}

function exportSettings(opts: ExportOptions) {
  const animated = opts.animated ?? false;
  const format = opts.format ?? (animated ? "svg" : "png");
  const mode = opts.mode ?? "final";
  if (animated && format !== "svg") throw new Error("animated export requires format='svg'");
  if (animated && mode !== "final") throw new Error("animated export requires mode='final'; use a PNG preview for review");
  if (mode === "final" && format === "jpg" && opts.embed === true) throw new Error("JPG export cannot embed diagram XML");
  const embed = mode === "final" && (opts.embed ?? format !== "jpg");
  const output = opts.output ?? deriveOutput(opts.input, format, embed, mode);
  return { format, mode, animated, embed, output };
}

function validatePageIndex(pageIndex?: number): void {
  if (pageIndex != null && (!Number.isInteger(pageIndex) || pageIndex < 1)) {
    throw new Error("pageIndex must be a positive one-based integer");
  }
}

/** Build flags without probing or writing. One raster axis preserves aspect ratio; SVG padding is post-processing. */
export function planExport(
  opts: ExportOptions,
  plat: string = platform(),
  isRoot = isRootUser(),
  contentWidth?: number,
  contentHeight?: number,
): ExportPlan {
  if (plat === "linux" && isRoot) throw new Error("draw.io cannot run as root on Linux. Run Pi and native draw.io as an unprivileged user.");
  const settings = exportSettings(opts);
  const { format, mode, embed, output } = settings;
  if (opts.output !== undefined) {
    const suffix = extname(output).toLowerCase();
    if (suffix !== `.${format}` && !(format === "jpg" && suffix === ".jpeg")) {
      const expected = format === "jpg" ? ".jpg or .jpeg" : `.${format}`;
      throw new Error(`export output suffix must match the requested format (${expected}): ${output}`);
    }
  }
  validatePageIndex(opts.pageIndex);
  const margin = opts.border ?? DEFAULT_FIT_MARGIN;
  const args: string[] = ["-x", "-f", format];
  if (embed) args.push("-e");
  const border = planExportSize(opts, mode, format === "png" || format === "jpg", margin, args, contentWidth, contentHeight);
  args.push("-b", String(format === "svg" ? 0 : border));
  if (opts.transparent && format === "png") args.push("-t");
  if (opts.pageIndex != null) args.push("--page-index", String(opts.pageIndex));
  args.push("-o", output);
  const linuxExtra = plat === "linux" ? ["--disable-gpu"] : [];
  return { ...settings, args, input: opts.input, linuxExtra, svgMargin: format === "svg" ? margin : 0 };
}

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
  /** True when this preview replaced an earlier tracked preview for the same source. */
  replacedPreview: boolean;
  /** Superseded preview artifacts removed after this successful preview or final export. */
  removedPreviews: string[];
  /** Best-effort preview cleanup failures; the export itself still succeeded. */
  previewCleanupWarnings: string[];
  command: string;
}

interface TrackedPreview {
  displayPath: string;
  /** Never unlink the target of a user-supplied output symlink. */
  removable: boolean;
  file: BigIntStats;
}

/** Preview ownership snapshots, grouped by canonical source and destination. */
const previewOutputs = new Map<string, Map<string, TrackedPreview>>();
/** Each entry owns the source and holds FIFO waiters. Independent of editable-source transactions. */
const exportQueues = new Map<string, Set<() => void>>();

async function withSourceExportQueue<T>(input: string, action: (key: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const key = realpathSync.native(input);
  const waiting = exportQueues.get(key);
  const queue = waiting ?? new Set<() => void>();
  if (waiting) {
    await new Promise<void>((resolveTurn, reject) => {
      function advance() {
        abort?.[Symbol.dispose]();
        resolveTurn();
      }
      const abort = signal && addAbortListener(signal, () => {
        queue.delete(advance);
        reject(signal.reason);
      });
      queue.add(advance);
    });
  } else {
    exportQueues.set(key, queue);
  }
  try {
    signal?.throwIfAborted();
    return await action(key);
  } finally {
    const next = queue.values().next().value;
    if (next === undefined) exportQueues.delete(key);
    else {
      queue.delete(next);
      next();
    }
  }
}

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

async function readDiagram(input: string, signal?: AbortSignal): Promise<{ root: Element; pages: DomEl[] }> {
  const xml = await readDiagramXml(input);
  signal?.throwIfAborted();
  let root: Element | null;
  try {
    root = new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, "text/xml").documentElement;
  } catch (error) {
    throw new Error("input is not well-formed draw.io XML", { cause: error });
  }
  if (!root) throw new Error("input is missing a draw.io XML root");
  return { root, pages: diagramPages(root as unknown as DomEl) };
}

function measurePage(page?: DomEl): { width: number; height: number } | undefined {
  const model = page && pageModel(page);
  if (!model) return undefined;
  const { cells, ids } = collectCellsWithIds(firstByTag(model, "root"));
  const bounds = contentBounds(cells, ids);
  return bounds ? { width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY } : undefined;
}

/** Size of the visible content in diagram units, or undefined when the page cannot be measured. */
export async function pageContentSize(input: string, pageIndex: number): Promise<{ width: number; height: number } | undefined> {
  return measurePage((await readDiagram(input)).pages[pageIndex - 1]);
}

function rejectSourceAlias(input: string, output: string): void {
  const source = statSync(input, { bigint: true });
  const destination = statSync(output, { bigint: true, throwIfNoEntry: false });
  if (destination && sameFile(source, destination)) {
    throw new Error(`output aliases the input file: ${output}`);
  }
}

function checkOutputName(path: string, output = path): void {
  if (!path || path.endsWith("/") || path.endsWith(sep)) throw new Error(`export destination must name a file: ${output}`);
}

function publicationPath(output: string): string {
  let path = output;
  const seen = new Set<string>();
  for (;;) {
    checkOutputName(path, output);
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

function publishExport(
  plan: ExportPlan, key: string, destination: string, staged: string, implicitPreview: boolean,
): PreviewCleanup {
  if (publicationPath(plan.output) !== destination) throw new Error(`export destination changed: ${plan.output}`);
  rejectSourceAlias(plan.input, destination);
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
  const published = stagedFile && fileAt(destination);
  const latest = published && sameFile(published, stagedFile)
    ? { displayPath: plan.output, removable: !linked, file: published }
    : undefined;
  const cleanup = retirePreviews(key, destination, latest);
  return { ...cleanup, replaced: replaced || cleanup.replaced };
}

function requireStagedFile(plan: ExportPlan, staged: string): void {
  const file = fileAt(staged);
  if (!file) throw new Error(`draw.io reported no error but the output was not created: ${plan.output}`);
  if (!file.isFile()) throw new Error(`draw.io output is not a regular file: ${plan.output}`);
}

async function verifyRenderedFile(opts: ExportOptions, plan: ExportPlan, staged: string): Promise<boolean> {
  requireStagedFile(plan, staged);
  const checkSize = (width: number, height: number) => checkRasterSize(opts, plan.mode, width, height);
  if (plan.format === "png") return repairPng(staged, plan.embed, { size: checkSize, preview: plan.mode === "preview" });
  if (plan.format === "svg") {
    try {
      await finishSvgFile(staged, plan.svgMargin);
    } catch (error) {
      throw new Error(`SVG post-processing failed: ${(error as Error).message}`, { cause: error });
    }
  } else {
    const data = await readFile(staged);
    if (plan.format === "jpg") {
      const size = jpegSize(data);
      if (!size) throw new Error(`draw.io output is not a complete JPG: ${plan.output}`);
      checkSize(size.width, size.height);
    } else if (data.subarray(0, 5).toString("ascii") !== "%PDF-" || !data.subarray(-32).toString("ascii").trimEnd().endsWith("%%EOF")) {
      throw new Error(`draw.io output is not a complete PDF: ${plan.output}`);
    }
  }
  return false;
}

function supportsPageIndex(version?: string): boolean {
  if (!version) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 27 || (major === 27 && (minor > 0 || (minor === 0 && patch >= 2)));
}

type SvgFinalizer = (path: string, signal?: AbortSignal) => Promise<void>;

/** Export, verify and optionally finalize a staged artifact before publishing it. */
export async function exportDiagram(
  opts: ExportOptions,
  finishStagedSvg?: SvgFinalizer,
): Promise<ExportResult> {
  opts.signal?.throwIfAborted();
  if (!existsSync(opts.input)) throw new Error(`input file not found: ${opts.input}`);
  return withSourceExportQueue(opts.input, (key) => exportDiagramQueued(opts, key, finishStagedSvg), opts.signal);
}

async function exportDiagramQueued(
  opts: ExportOptions,
  key: string,
  finishStagedSvg?: SvgFinalizer,
): Promise<ExportResult> {
  const { output, format, mode } = exportSettings(opts);
  // Keep alias and malformed file-path errors ahead of format/sizing checks.
  checkOutputName(output);
  rejectSourceAlias(opts.input, output);
  const destination = publicationPath(output);
  const existing = fileAt(destination);
  if (existing && !existing.isFile()) throw new Error(`export destination is not a regular file: ${output}`);

  const { signal, pageIndex } = opts;
  validatePageIndex(pageIndex);
  const { root, pages } = await readDiagram(opts.input, signal);
  if (pageIndex != null && pageIndex > pages.length) {
    throw new Error(`pageIndex ${pageIndex} is out of range: input has ${pages.length} page(s)`);
  }
  const raster = format === "png" || format === "jpg";
  const content = raster ? measurePage(pages[(pageIndex ?? 1) - 1]) : undefined;
  // Leave absolute spellings and '..' across symlinked parents intact.
  const input = isAbsolute(opts.input) ? opts.input : process.platform === "win32" && /^[a-z]:/i.test(opts.input)
    ? resolve(opts.input) : `${process.cwd()}${sep}${opts.input}`;
  const plan = planExport({ ...opts, input, output }, platform(), isRootUser(), content?.width, content?.height);
  const explicitRasterSize = opts.width != null || opts.height != null || (mode === "final" && opts.scale != null);
  if (raster && explicitRasterSize && (!content || !Number.isFinite(content.width) || !Number.isFinite(content.height) ||
    !(content.width > 0 || content.height > 0))) {
    throw new Error("cannot budget an explicit raster size without measurable page bounds");
  }

  const info = await resolveBinary(opts.binary, signal);
  if (!info.available || !info.binary) throw new Error(info.reason ?? "draw.io CLI not found. Install draw.io desktop.");
  if (pageIndex != null && !supportsPageIndex(info.version)) {
    throw new Error(`pageIndex requires draw.io 27.0.2 or later (found ${info.version ?? "an unknown version"})`);
  }
  signal?.throwIfAborted();
  const stageDir = await mkdtemp(join(dirname(destination), ".drawme-export-"));
  try {
    // draw.io uses the suffix to select the encoder even when -f is given.
    const staged = join(stageDir, `artifact.${plan.format}`);
    let rendererInput = plan.input;
    if (root.tagName === "diagram") {
      // Stock draw.io accepts this page inside an mxfile but not as a standalone root.
      // Wrap a private copy, keeping the authored source and its file permissions untouched.
      rendererInput = join(stageDir, "source.drawio");
      await writeFile(rendererInput, `<mxfile>${new XMLSerializer().serializeToString(root)}</mxfile>`, { signal });
    }
    const fullArgs = [...plan.args.slice(0, -1), staged, rendererInput, ...plan.linuxExtra];
    let command: string;
    try {
      command = await invokeRenderer(info.binary, fullArgs, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(`draw.io export failed: ${(error as Error).message}`, { cause: error });
    }
    signal?.throwIfAborted();
    const repaired = await verifyRenderedFile(opts, plan, staged);
    signal?.throwIfAborted();
    let animation: AnimatedSvgSummary | undefined;
    if (plan.format === "svg" && (plan.animated || finishStagedSvg)) {
      try {
        if (plan.animated) animation = await enhanceAnimatedSvg(rendererInput, staged, pageIndex ?? 1);
        signal?.throwIfAborted();
        await finishStagedSvg?.(staged, signal);
        requireStagedFile(plan, staged);
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`animated SVG verification failed: ${(error as Error).message}`, { cause: error });
      }
    }
    // Nothing asynchronous may intervene between the final cancellation check, rename and preview retirement.
    signal?.throwIfAborted();
    const cleanup = publishExport(plan, key, destination, staged, plan.mode === "preview" && opts.output === undefined);
    return {
      output: plan.output,
      format: plan.format,
      mode: plan.mode,
      embed: plan.embed,
      animated: plan.animated,
      animation,
      binary: info.binary,
      version: info.version,
      repaired,
      replacedPreview: cleanup.replaced,
      removedPreviews: cleanup.removed,
      previewCleanupWarnings: cleanup.warnings,
      command,
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}
