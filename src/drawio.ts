/**
 * draw.io desktop CLI wrapper: binary resolution + export. Encodes the tricky
 * flag knowledge for focused previews vs final export, the vision width cap,
 * `-e` PNG IEND repair, page indexing, and headless-Linux handling so callers never
 * hand-build a draw.io command line.
 */
import { spawn } from "node:child_process";
import {
  type BigIntStats, accessSync, chmodSync, chownSync, constants, existsSync, lstatSync, readlinkSync,
  realpathSync, renameSync, statSync, unlinkSync,
} from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { platform, tmpdir } from "node:os";
import { repairPng } from "./png";
import { enhanceAnimatedSvg, type AnimatedSvgSummary } from "./animation";
import { DEFAULT_FIT_MARGIN } from "./fitcanvas";
import { DOMParser } from "@xmldom/xmldom";
import { type DomEl, childrenByTag, firstByTag } from "./dom";
import { collectCellsWithIds, contentBounds } from "./geometry";
import { finishSvgFile } from "./svgexport";

export type ExportFormat = "png" | "svg" | "pdf" | "jpg";
export type ExportMode = "preview" | "final";

export interface DrawioInfo {
  available: boolean;
  binary?: string;
  version?: string;
  major?: number;
  /** Mermaid import and the `--layout` pass both need draw.io v30+. */
  supportsMermaid?: boolean;
  supportsLayout?: boolean;
}

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

/** Candidate binary names and paths in resolution order. */
const CANDIDATES = [
  "drawio", // Homebrew cask, jgraph .deb/.rpm, Arch AUR
  "draw.io", // older builds / custom symlinks
  "/Applications/draw.io.app/Contents/MacOS/draw.io", // macOS .app bundle
  String.raw`C:\Program Files\draw.io\draw.io.exe`, // Windows
  String.raw`C:\Program Files (x86)\draw.io\draw.io.exe`,
  "/mnt/c/Program Files/draw.io/draw.io.exe", // WSL2
];

/**
 * Run a command and collect its output. Off Windows the child leads its own process
 * group, so a timeout ends the whole tree (xvfb-run, Xvfb, Electron), not only the
 * direct child: SIGTERM first so xvfb-run can clean up, SIGKILL after a grace period.
 */
export function run(bin: string, args: string[], timeout = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const group = platform() !== "win32";
    const child = spawn(bin, args, { detached: group, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, group, "SIGTERM");
      killTimer = setTimeout(() => killTree(child.pid, group, "SIGKILL"), 5_000);
    }, timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(Object.assign(err, { stderr }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        // Reap anything in the group that ignored SIGTERM.
        clearTimeout(killTimer);
        killTree(child.pid, group, "SIGKILL");
      }
      if (code === 0 && !timedOut) {
        resolve({ stdout, stderr });
        return;
      }
      const exitReason = signal ?? `code ${code}`;
      const why = timedOut ? `timed out after ${timeout / 1000}s` : `exited with ${exitReason}`;
      reject(Object.assign(new Error(`${bin} ${why}`), { code, signal, stderr }));
    });
  });
}

function killTree(pid: number | undefined, group: boolean, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(group ? -pid : pid, signal);
  } catch {
    // already gone
  }
}

function parseMajor(version: string): number {
  const m = /(\d+)/.exec(version);
  return m ? Number.parseInt(m[1], 10) : 0;
}

/**
 * Resolve the draw.io CLI. Tries an explicit `override` first, then the standard
 * candidates. Absolute paths are existence-checked before spawning; PATH names are
 * probed with `--version` (a short timeout guards the sandbox-hang case).
 */
export async function resolveBinary(override?: string): Promise<DrawioInfo> {
  const candidates = override ? [override, ...CANDIDATES] : CANDIDATES;
  const tried = new Set<string>();
  for (const bin of candidates) {
    if (tried.has(bin)) continue;
    tried.add(bin);
    const looksLikePath = bin.includes("/") || bin.includes("\\");
    if (looksLikePath && !existsSync(bin)) continue;
    try {
      const { stdout } = await run(bin, ["--version"], 15_000);
      const version = stdout.trim().split(/\r?\n/)[0] ?? "";
      if (version) {
        const major = parseMajor(version);
        return { available: true, binary: bin, version, major, supportsMermaid: major >= 30, supportsLayout: major >= 30 };
      }
    } catch {
      // not this one — try the next candidate
    }
  }
  return { available: false };
}

/** Derive a default output path next to the input, using the `.drawio.png` convention when embedding. */
export function deriveOutput(input: string, format: ExportFormat, embed: boolean, mode: ExportMode = "final"): string {
  const dir = dirname(input);
  const ext = extname(input);
  const base = ext ? basename(input).slice(0, -ext.length) : basename(input);
  if (mode === "preview") return join(dir, `${base}.preview.${format}`);
  if (format === "png" && embed) return join(dir, `${base}.drawio.png`);
  return join(dir, `${base}.${format}`);
}

/**
 * Build the full export plan (no side effects) so the argument logic is unit-testable.
 *
 * Export planning rules:
 * - preview → never `-e`, width-capped at 2000px (Claude vision rejects >2576px)
 * - final   → `-e` for png/svg/pdf (jpg can't embed), raster scale 2, lowered so the
 *   raster stays within MAX_FINAL_RASTER_PIXELS (larger rasters fail with UnknownVizError)
 * - animated → final SVG only; defaults the format to SVG and verifies motion after export
 * - `--width` and `-s` are never combined; an explicit width/height wins
 * - `-t` (transparent) is PNG-only; `--page-index` is 1-based
 * - the outer margin defaults to the canvas-fit margin in diagram units. draw.io
 *   applies `-b` unevenly with `-s` (left/top get border × scale) and with SVG
 *   (the canvas grows by 3 × border), so a scaled raster is sized with `--width`
 *   from `contentWidth`, and SVG is exported borderless and padded afterwards.
 */
export function planExport(
  opts: ExportOptions,
  plat: string = platform(),
  isRoot = false,
  contentWidth?: number,
  contentHeight?: number,
): ExportPlan {
  const animated = opts.animated ?? false;
  const format = opts.format ?? (animated ? "svg" : "png");
  const mode = opts.mode ?? "final";
  if (animated && format !== "svg") throw new Error("animated export requires format='svg'");
  if (animated && mode !== "final") throw new Error("animated export requires mode='final'; use a PNG preview for review");
  const embed = mode === "final" && (opts.embed ?? format !== "jpg");
  const output = opts.output ?? deriveOutput(opts.input, format, embed, mode);
  const raster = format === "png" || format === "jpg";

  const margin = opts.border ?? DEFAULT_FIT_MARGIN;
  const args: string[] = ["-x", "-f", format];
  if (embed) args.push("-e");
  const border = planExportSize(opts, mode, raster, margin, args, contentWidth, contentHeight);
  // draw.io crops exports to the content, so the border is the image's only outer margin.
  args.push("-b", String(format === "svg" ? 0 : border));
  if (opts.transparent && format === "png") args.push("-t");
  if (opts.pageIndex != null) args.push("--page-index", String(opts.pageIndex));
  args.push("-o", output);

  // On Linux these must trail the input filename, or draw.io treats them as the input.
  const linuxExtra: string[] = [];
  if (plat === "linux") {
    linuxExtra.push("--disable-gpu");
    if (isRoot) linuxExtra.push("--no-sandbox");
  }
  return { format, mode, embed, animated, output, args, input: opts.input, linuxExtra, svgMargin: format === "svg" ? margin : 0 };
}

/** Pixel budget for a final raster; draw.io fails with UnknownVizError on much larger images. */
export const MAX_FINAL_RASTER_PIXELS = 6_000_000;

/** The requested scale, lowered so the bordered raster stays within MAX_FINAL_RASTER_PIXELS. */
export function cappedScale(scale: number, margin: number, contentWidth?: number, contentHeight?: number): number {
  if (!contentWidth || !contentHeight || contentWidth <= 0 || contentHeight <= 0) return scale;
  const area = (contentWidth + 2 * margin) * (contentHeight + 2 * margin);
  const max = Math.floor(Math.sqrt(MAX_FINAL_RASTER_PIXELS / area) * 100) / 100;
  return Math.min(scale, max);
}

function planExportSize(
  opts: ExportOptions, mode: ExportMode, raster: boolean, margin: number, args: string[],
  contentWidth?: number, contentHeight?: number,
): number {
  if (opts.width != null) args.push("--width", String(opts.width));
  else if (opts.height != null) args.push("--height", String(opts.height));
  else if (raster) {
    if (mode === "preview") args.push("--width", "2000");
    else {
      const scale = cappedScale(opts.scale ?? 2, margin, contentWidth, contentHeight);
      if (contentWidth !== undefined && contentWidth > 0 && scale !== 1) {
        // With --width the border is in output pixels and applied evenly.
        const border = Math.round(margin * scale);
        args.push("--width", String(Math.round(contentWidth * scale + 2 * border)));
        return border;
      }
      args.push("-s", String(scale));
    }
  }
  return margin;
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
  /**
   * True when this preview replaced an earlier tracked preview for the same
   * source — including a re-export over the same output path, where nothing is
   * removed from disk. Always false for final exports.
   */
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
/** Serialize exports per source so concurrent preview calls cannot leave multiple latest artifacts. */
const exportQueues = new Map<string, Promise<void>>();

function sourceKey(input: string): string {
  try {
    return realpathSync.native(input);
  } catch {
    return resolve(input);
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

async function withSourceExportQueue<T>(input: string, action: (key: string) => Promise<T>): Promise<T> {
  const key = sourceKey(input);
  const previous = exportQueues.get(key) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent;
  });
  const tail = previous.then(() => current);
  exportQueues.set(key, tail);

  await previous;
  try {
    return await action(key);
  } finally {
    release();
    if (exportQueues.get(key) === tail) exportQueues.delete(key);
  }
}

/** Size of the visible content of a page in diagram units, or undefined when it cannot be measured. */
export async function pageContentSize(input: string, pageIndex: number): Promise<{ width: number; height: number } | undefined> {
  try {
    const root = new DOMParser().parseFromString(await readFile(input, "utf8"), "text/xml").documentElement as unknown as DomEl | null;
    if (!root) return undefined;
    const pages = childrenByTag(root, "diagram");
    const page = pages.length > 0 ? pages[pageIndex - 1] : root;
    const model = page && (page.tagName === "mxGraphModel" ? page : firstByTag(page, "mxGraphModel"));
    if (!model) return undefined;
    const { cells, ids } = collectCellsWithIds(firstByTag(model, "root"));
    const bounds = contentBounds(cells, ids);
    return bounds ? { width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY } : undefined;
  } catch {
    return undefined;
  }
}

function isRootUser(): boolean {
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  return typeof getuid === "function" && getuid() === 0;
}

/**
 * Xvfb screen for an export: draw.io fails (UnknownVizError, then hangs) when the
 * requested raster is wider than the virtual screen. The height is unknown when only
 * a width is requested, so the larger requested side sizes both, plus a margin,
 * floored at 1280x1024 and capped at 8192.
 */
export function xvfbScreen(args: string[]): string {
  const want = Math.max(flagNumber(args, "--width"), flagNumber(args, "--height"));
  const side = want > 0 ? Math.min(8192, want + 256) : 0;
  return `${Math.max(1280, side)}x${Math.max(1024, side)}x24`;
}

function flagNumber(args: string[], flag: string): number {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) || 0 : 0;
}

/** Run the export, wrapping in `xvfb-run` on headless Linux and falling back to a direct call if it's absent. */
async function invoke(binary: string, fullArgs: string[]): Promise<string> {
  if (platform() === "linux" && !process.env.DISPLAY) {
    const screen = `-screen 0 ${xvfbScreen(fullArgs)}`;
    try {
      await run("xvfb-run", ["-a", `--server-args=${screen}`, binary, ...fullArgs]);
      return `xvfb-run -a --server-args="${screen}" ${binary} ${fullArgs.join(" ")}`;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // xvfb-run not installed — fall through to a direct call
    }
  }
  await run(binary, fullArgs);
  return `${binary} ${fullArgs.join(" ")}`;
}

/**
 * Export a `.drawio` file to PNG/SVG/PDF/JPG. Resolves the binary, runs the CLI,
 * and verifies the staged artifact before replacing the destination. An internal
 * SVG finalizer can do further processing and verification before publication.
 */
export async function exportDiagram(
  opts: ExportOptions,
  finishStagedSvg?: (path: string) => Promise<void>,
): Promise<ExportResult> {
  if (!existsSync(opts.input)) throw new Error(`input file not found: ${opts.input}`);
  return withSourceExportQueue(opts.input, (key) => exportDiagramQueued(opts, key, finishStagedSvg));
}

async function invokeExport(binary: string, args: string[]): Promise<string> {
  try {
    return await invoke(binary, args);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const stderr = (e as { stderr?: string }).stderr?.trim();
    const detail = stderr ? `${message}\n${stderr}` : message;
    throw new Error(`draw.io export failed: ${detail}`, { cause: e });
  }
}

function rejectSourceAlias(input: string, output: string): void {
  const source = statSync(input, { bigint: true });
  const destination = statSync(output, { bigint: true, throwIfNoEntry: false });
  if (destination && sameFile(source, destination)) {
    throw new Error(`output aliases the input file: ${output}`);
  }
}

function publicationPath(output: string): string {
  let path = output;
  const seen = new Set<string>();
  for (;;) {
    if (path.endsWith("/") || path.endsWith(sep)) throw new Error(`export destination must name a file: ${output}`);
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

async function verifyRenderedFile(plan: ExportPlan, staged: string): Promise<boolean> {
  const file = fileAt(staged);
  if (!file) throw new Error(`draw.io reported no error but the output was not created: ${plan.output}`);
  if (!file.isFile()) throw new Error(`draw.io output is not a regular file: ${plan.output}`);
  if (plan.format === "png") return repairPng(staged, plan.embed);
  if (plan.format === "svg") {
    try {
      await finishSvgFile(staged, plan.svgMargin);
    } catch (error) {
      throw new Error(`SVG post-processing failed: ${(error as Error).message}`, { cause: error });
    }
  } else {
    const data = await readFile(staged);
    const complete = plan.format === "pdf"
      ? data.subarray(0, 5).toString("ascii") === "%PDF-" && data.subarray(-32).toString("ascii").trimEnd().endsWith("%%EOF")
      : data.length > 4 && data.readUInt16BE(0) === 0xffd8 && data.readUInt16BE(data.length - 2) === 0xffd9;
    if (!complete) throw new Error(`draw.io output is not a complete ${plan.format.toUpperCase()}: ${plan.output}`);
  }
  return false;
}

async function exportDiagramQueued(
  opts: ExportOptions,
  key: string,
  finishStagedSvg?: (path: string) => Promise<void>,
): Promise<ExportResult> {
  const content = await pageContentSize(opts.input, opts.pageIndex ?? 1);
  const plan = planExport(opts, platform(), isRootUser(), content?.width, content?.height);
  rejectSourceAlias(plan.input, plan.output);
  const destination = publicationPath(plan.output);

  const info = await resolveBinary(opts.binary);
  if (!info.available || !info.binary) {
    throw new Error(
      "draw.io CLI not found. Install draw.io desktop (macOS: `brew install --cask drawio`; " +
        "others: https://github.com/jgraph/drawio-desktop/releases), or pass an explicit `binary` path.",
    );
  }

  const stageDir = await mkdtemp(join(dirname(destination), ".drawme-export-"));
  try {
    // draw.io uses the suffix to select the encoder even when -f is given.
    const staged = join(stageDir, `artifact.${plan.format}`);
    const fullArgs = [...plan.args.slice(0, -1), staged, plan.input, ...plan.linuxExtra];
    const command = await invokeExport(info.binary, fullArgs);
    const repaired = await verifyRenderedFile(plan, staged);
    let animation: AnimatedSvgSummary | undefined;
    if (plan.format === "svg" && (plan.animated || finishStagedSvg)) {
      try {
        if (plan.animated) animation = await enhanceAnimatedSvg(plan.input, staged, opts.pageIndex ?? 1);
        await finishStagedSvg?.(staged);
      } catch (error) {
        throw new Error(`animated SVG verification failed: ${(error as Error).message}`, { cause: error });
      }
    }
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
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

// --- Mermaid → .drawio conversion + ELK auto-layout (both need draw.io v30+) ---

/** Default `.drawio` output path derived from a source file. */
function drawioOutputFor(src: string): string {
  const dir = dirname(src);
  const ext = extname(src);
  const base = ext ? basename(src).slice(0, -ext.length) : basename(src);
  return join(dir, `${base}.drawio`);
}

async function requireBinary(minMajor: number, feature: string, override?: string): Promise<DrawioInfo & { binary: string }> {
  const info = await resolveBinary(override);
  if (!info.available || !info.binary) {
    throw new Error(
      "draw.io CLI not found. Install draw.io desktop (macOS: `brew install --cask drawio`; " +
        "others: https://github.com/jgraph/drawio-desktop/releases), or pass an explicit `binary` path.",
    );
  }
  if ((info.major ?? 0) < minMajor) {
    throw new Error(
      `${feature} needs draw.io v${minMajor}+, but ${info.version} is installed. Upgrade with \`brew upgrade --cask drawio\`.`,
    );
  }
  return info as DrawioInfo & { binary: string };
}

/** Args for a Mermaid → .drawio conversion (pure, for testing). */
export function mermaidArgs(mmdPath: string, output: string): string[] {
  return ["-x", "-f", "xml", "-o", output, mmdPath];
}

export interface MermaidOptions {
  /** Path to a `.mmd` file. */
  input?: string;
  /** Inline Mermaid text (written to a temp `.mmd`); used when `input` is omitted. */
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

/**
 * Convert Mermaid text to a native `.drawio` (structure + automatic layout) via
 * the CLI. Requires draw.io v30+. Never applies `--layout` afterwards — the
 * conversion is already laid out.
 */
export async function convertMermaid(opts: MermaidOptions): Promise<MermaidResult> {
  const info = await requireBinary(30, "Mermaid conversion", opts.binary);

  let mmdPath = opts.input;
  let tempDir: string | undefined;
  try {
    if (!mmdPath) {
      if (!opts.mermaid?.trim()) {
        throw new Error("provide either `input` (a .mmd file path) or `mermaid` (inline Mermaid text)");
      }
      tempDir = await mkdtemp(join(tmpdir(), "drawme-mmd-"));
      mmdPath = join(tempDir, "diagram.mmd");
      await writeFile(mmdPath, opts.mermaid, "utf8");
    } else if (!existsSync(mmdPath)) {
      throw new Error(`input file not found: ${mmdPath}`);
    }
    const output = opts.output ?? (opts.input ? drawioOutputFor(opts.input) : join(process.cwd(), "diagram.drawio"));
    const command = await invoke(info.binary, mermaidArgs(mmdPath, output));
    if (!existsSync(output)) throw new Error(`conversion produced no output: ${output}`);
    return { output, binary: info.binary, version: info.version, command };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
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
  /** Defaults to a sibling `<name>.layout.drawio` (never overwrites the input unless you pass it explicitly). */
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

/**
 * Re-place nodes and route edges with an ELK layout preset via the CLI. Requires
 * draw.io v30+. The preset is validated against a strict allowlist first — an
 * unknown value would open a modal error dialog that hangs a headless run.
 */
export async function applyLayout(opts: LayoutOptions): Promise<LayoutResult> {
  if (!LAYOUT_PRESETS.includes(opts.preset)) {
    throw new Error(`unknown layout preset '${opts.preset}'. Allowed: ${LAYOUT_PRESETS.join(", ")}`);
  }
  if (!existsSync(opts.input)) throw new Error(`input file not found: ${opts.input}`);
  const info = await requireBinary(30, "The --layout pass", opts.binary);
  const output = opts.output ?? join(dirname(opts.input), `${basename(opts.input, extname(opts.input))}.layout.drawio`);
  const command = await invoke(info.binary, layoutArgs(opts.input, opts.preset, output));
  if (!existsSync(output)) throw new Error(`layout produced no output: ${output}`);
  return { output, preset: opts.preset, binary: info.binary, version: info.version, command };
}

/** Open a file in the OS default handler (draw.io desktop for `.drawio`). No version gate. */
export async function openFile(path: string): Promise<{ opener: string }> {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const plat = platform();
  if (plat === "darwin") {
    await run("open", [path], 15_000);
    return { opener: "open" };
  }
  if (plat === "win32") {
    await run("cmd", ["/c", "start", "", path], 15_000);
    return { opener: "start" };
  }
  await run("xdg-open", [path], 15_000);
  return { opener: "xdg-open" };
}
