/**
 * draw.io desktop CLI wrapper: binary resolution + export. Encodes the tricky
 * flag knowledge for preview vs final export, the vision width cap, `-e` PNG
 * IEND repair, page indexing, and headless-Linux handling so callers never
 * hand-build a draw.io command line.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { platform, tmpdir } from "node:os";
import { repairPng } from "./png";

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
  binary?: string;
}

export interface ExportPlan {
  format: ExportFormat;
  mode: ExportMode;
  embed: boolean;
  output: string;
  /** Export flags ending with `-o <output>`. The input path is appended after these. */
  args: string[];
  input: string;
  /** Flags that must go AFTER the input path on Linux (draw.io argument-parsing quirk). */
  linuxExtra: string[];
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

function run(bin: string, args: string[], timeout = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        (err as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr?.toString();
        const reason = err instanceof Error ? err : new Error("draw.io process failed with an unknown error");
        reject(reason);
      } else {
        resolve({ stdout: stdout.toString(), stderr: stderr?.toString() ?? "" });
      }
    });
  });
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
export function deriveOutput(input: string, format: ExportFormat, embed: boolean): string {
  const dir = dirname(input);
  const ext = extname(input);
  const base = ext ? basename(input).slice(0, -ext.length) : basename(input);
  if (format === "png" && embed) return join(dir, `${base}.drawio.png`);
  return join(dir, `${base}.${format}`);
}

/**
 * Build the full export plan (no side effects) so the argument logic is unit-testable.
 *
 * Export planning rules:
 * - preview → never `-e`, width-capped at 2000px (Claude vision rejects >2576px)
 * - final   → `-e` for png/svg/pdf (jpg can't embed), raster scale 2
 * - `--width` and `-s` are never combined; an explicit width/height wins
 * - `-t` (transparent) is PNG-only; `--page-index` is 1-based
 */
export function planExport(opts: ExportOptions, plat: string = platform(), isRoot = false): ExportPlan {
  const format = opts.format ?? "png";
  const mode = opts.mode ?? "final";
  const embed = opts.embed ?? (mode === "final" && format !== "jpg");
  const output = opts.output ?? deriveOutput(opts.input, format, embed);
  const raster = format === "png" || format === "jpg";

  const args: string[] = ["-x", "-f", format];
  if (embed) args.push("-e");
  if (opts.width != null) args.push("--width", String(opts.width));
  else if (opts.height != null) args.push("--height", String(opts.height));
  else if (raster) {
    if (mode === "preview") args.push("--width", "2000");
    else args.push("-s", String(opts.scale ?? 2));
  }
  args.push("-b", String(opts.border ?? 10));
  if (opts.transparent && format === "png") args.push("-t");
  if (opts.pageIndex != null) args.push("--page-index", String(opts.pageIndex));
  args.push("-o", output);

  // On Linux these must trail the input filename, or draw.io treats them as the input.
  const linuxExtra: string[] = [];
  if (plat === "linux") {
    linuxExtra.push("--disable-gpu");
    if (isRoot) linuxExtra.push("--no-sandbox");
  }
  return { format, mode, embed, output, args, input: opts.input, linuxExtra };
}

export interface ExportResult {
  output: string;
  format: ExportFormat;
  mode: ExportMode;
  embed: boolean;
  binary: string;
  version?: string;
  /** True if the truncated `-e` PNG IEND chunk was repaired after export. */
  repaired: boolean;
  command: string;
}

function isRootUser(): boolean {
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  return typeof getuid === "function" && getuid() === 0;
}

/** Run the export, wrapping in `xvfb-run` on headless Linux and falling back to a direct call if it's absent. */
async function invoke(binary: string, fullArgs: string[]): Promise<string> {
  if (platform() === "linux" && !process.env.DISPLAY) {
    try {
      await run("xvfb-run", ["-a", "--server-args=-screen 0 1280x1024x24", binary, ...fullArgs]);
      return `xvfb-run -a --server-args="-screen 0 1280x1024x24" ${binary} ${fullArgs.join(" ")}`;
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
 * and (for embedded PNG) repairs the truncated IEND chunk. Throws on missing
 * input, missing CLI, or a failed export.
 */
export async function exportDiagram(opts: ExportOptions): Promise<ExportResult> {
  if (!existsSync(opts.input)) throw new Error(`input file not found: ${opts.input}`);
  const info = await resolveBinary(opts.binary);
  if (!info.available || !info.binary) {
    throw new Error(
      "draw.io CLI not found. Install draw.io desktop (macOS: `brew install --cask drawio`; " +
        "others: https://github.com/jgraph/drawio-desktop/releases), or pass an explicit `binary` path.",
    );
  }

  const plan = planExport(opts, platform(), isRootUser());
  const fullArgs = [...plan.args, plan.input, ...plan.linuxExtra];

  let command: string;
  try {
    command = await invoke(info.binary, fullArgs);
  } catch (e) {
    const detail = ((e as { stderr?: string }).stderr || (e as Error).message || String(e)).trim();
    throw new Error(`draw.io export failed: ${detail}`, { cause: e });
  }
  if (!existsSync(plan.output)) {
    throw new Error(`draw.io reported no error but the output was not created: ${plan.output}`);
  }

  const repaired = plan.embed && plan.format === "png" ? await repairPng(plan.output) : false;
  return {
    output: plan.output,
    format: plan.format,
    mode: plan.mode,
    embed: plan.embed,
    binary: info.binary,
    version: info.version,
    repaired,
    command,
  };
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
