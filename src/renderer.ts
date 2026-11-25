/** Local draw.io CLI discovery, process policy, and desktop document opening. */
import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import { extname, isAbsolute, win32 } from "node:path";

export interface DrawioInfo {
  available: boolean;
  binary?: string;
  version?: string;
  major?: number;
  /** Mermaid import and layout both require draw.io 30.2.4 or later. */
  supportsMermaid?: boolean;
  supportsLayout?: boolean;
  reason?: string;
}

const CANDIDATES = [
  "drawio", // Homebrew cask, jgraph .deb/.rpm, Arch AUR
  "draw.io", // older builds / custom symlinks
  "/Applications/draw.io.app/Contents/MacOS/draw.io", // macOS .app bundle
  String.raw`C:\Program Files\draw.io\draw.io.exe`,
  String.raw`C:\Program Files (x86)\draw.io\draw.io.exe`,
  "/mnt/c/Program Files/draw.io/draw.io.exe", // detect for the WSL diagnostic only
];
const PROBE_TIMEOUT = 15_000;
const TERMINATION_GRACE = 5_000;
const STREAM_LIMIT = 8192;
const ROOT_REASON = "draw.io cannot run as root on Linux. Run Pi and native draw.io as an unprivileged user.";
const WINDOWS_ON_LINUX_REASON = "The Windows draw.io renderer is unsupported on Linux/WSL. Install native Linux draw.io instead.";
const HEADLESS_ADVICE = "For headless Linux, install Xvfb and ensure xvfb-run is on PATH.";

export function isRootUser(): boolean {
  return process.getuid?.() === 0 || process.geteuid?.() === 0;
}

function abortError(): DOMException {
  return new DOMException("draw.io operation aborted", "AbortError");
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function windowsOnLinux(binary: string): boolean {
  return platform() === "linux" && /\.exe$/i.test(binary);
}

function headlessLinux(): boolean {
  return platform() === "linux" && !process.env.DISPLAY;
}

const LAUNCH_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC", "ENOTDIR", "EAGAIN", "EMFILE", "ENFILE"]);

class ProcessLaunchError extends Error {
  readonly code: string | undefined;

  constructor(error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const safeCode = code && LAUNCH_CODES.has(code) ? code : undefined;
    super(safeCode ? `could not start (${safeCode})` : "could not start");
    this.code = safeCode;
  }
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `exited with signal ${signal}` : `exited with code ${code ?? "unknown"}`;
}

function killTree(pid: number | undefined, group: boolean, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(group ? -pid : pid, signal);
  } catch {
    // The child or process group may already have exited.
  }
}

/** Copy a bounded byte prefix, without holding references to the incoming chunks. */
function streamPrefix() {
  const bytes = Buffer.alloc(STREAM_LIMIT);
  let length = 0;
  return {
    append(chunk: Buffer) {
      if (length < bytes.length) length += chunk.copy(bytes, length);
    },
    text: () => bytes.toString("utf8", 0, length),
  };
}

/** Drain both pipes. On timeout or cancellation, terminate and wait for the child to close. */
export async function run(bin: string, args: string[], timeout = 120_000, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  checkAbort(signal);
  const group = platform() !== "win32";
  let child;
  try {
    child = spawn(bin, args, { detached: group, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new ProcessLaunchError(error);
  }
  const stdout = streamPrefix();
  const stderr = streamPrefix();
  return new Promise((resolve, reject) => {
    let stopReason: "abort" | "timeout" | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let launchError: ProcessLaunchError | undefined;
    const stop = (reason: "abort" | "timeout") => {
      if (stopReason) return;
      stopReason = reason;
      killTree(child.pid, group, "SIGTERM");
      killTimer = setTimeout(() => killTree(child.pid, group, "SIGKILL"), TERMINATION_GRACE);
    };
    const abort = () => stop("abort");
    const timer = setTimeout(() => stop("timeout"), timeout);
    const onError = (error: Error) => { launchError = new ProcessLaunchError(error); };
    child.stdout.on("data", stdout.append);
    child.stderr.on("data", stderr.append);
    child.once("error", onError);
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      child.stdout.off("data", stdout.append);
      child.stderr.off("data", stderr.append);
      child.off("error", onError);
      // If the group leader has closed, ensure no remaining descendants survive a stop.
      if (stopReason && group) killTree(child.pid, true, "SIGKILL");
      if (stopReason === "abort") reject(abortError());
      else if (stopReason === "timeout") reject(new Error(`timed out after ${timeout / 1000}s`));
      else if (launchError) reject(launchError);
      else if (code !== 0) reject(new Error(exitStatus(code, exitSignal)));
      else resolve({ stdout: stdout.text(), stderr: stderr.text() });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Size the virtual screen for raster exports, with space for borders and an unknown second axis. */
export function xvfbScreen(args: string[]): string {
  const want = Math.max(flagNumber(args, "--width"), flagNumber(args, "--height"));
  const side = want > 0 ? Math.min(8192, want + 256) : 0;
  return `${Math.max(1280, side)}x${Math.max(1024, side)}x24`;
}

function flagNumber(args: string[], flag: string): number {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) || 0 : 0;
}

/** Probe and render with the same headless preparation. Only a missing wrapper permits direct fallback. */
async function runRenderer(binary: string, args: string[], timeout?: number, signal?: AbortSignal) {
  if (headlessLinux()) {
    const screen = `-screen 0 ${xvfbScreen(args)}`;
    try {
      const { stdout } = await run("xvfb-run", ["-a", `--server-args=${screen}`, binary, ...args], timeout, signal);
      return { stdout, command: `xvfb-run -a --server-args="${screen}" ${binary} ${args.join(" ")}` };
    } catch (error) {
      if (!(error instanceof ProcessLaunchError) || error.code !== "ENOENT") throw error;
    }
  }
  const { stdout } = await run(binary, args, timeout, signal);
  return { stdout, command: `${binary} ${args.join(" ")}` };
}

/** Parse only a bounded numeric version line, not arbitrary child prose. */
function versionInfo(stdout: string): Pick<DrawioInfo, "version" | "major" | "supportsMermaid" | "supportsLayout"> | undefined {
  const lines = stdout.split("\n");
  // A wrapper can mix logs into stdout. Ignore noise and never use a possibly clipped line.
  if (Buffer.byteLength(stdout) >= STREAM_LIMIT) lines.pop();
  for (const line of lines) {
    if (line.length > 64) continue;
    const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(line.trim());
    if (!match) continue;
    const [, majorPart, minorPart, patchPart] = match;
    const major = Number(majorPart);
    const minor = Number(minorPart);
    const patch = Number(patchPart);
    const capable = major > 30 || (major === 30 && (minor > 2 || (minor === 2 && patch >= 4)));
    return { version: `${majorPart}.${minorPart}.${patchPart}`, major, supportsMermaid: capable, supportsLayout: capable };
  }
  return undefined;
}

/** Resolve trusted launch-environment or code overrides before standard candidates. Never pass a tool override. */
export async function resolveBinary(trustedOverride?: string, signal?: AbortSignal): Promise<DrawioInfo> {
  checkAbort(signal);
  if (platform() === "linux" && isRootUser()) return { available: false, reason: ROOT_REASON };
  const configured = process.env.DRAWME_DRAWIO_BINARY;
  const preferred = trustedOverride || (configured && isAbsolute(configured) ? configured : undefined);
  const candidates = new Set(preferred ? [preferred, ...CANDIDATES] : CANDIDATES);
  let unsupportedWindows = false;
  for (const bin of candidates) {
    checkAbort(signal);
    const looksLikePath = bin.includes("/") || bin.includes("\\");
    if (windowsOnLinux(bin)) {
      if (bin === preferred || (looksLikePath && existsSync(bin))) unsupportedWindows = true;
      continue;
    }
    if (looksLikePath && !existsSync(bin)) continue;
    try {
      const { stdout } = await runRenderer(bin, ["--version"], PROBE_TIMEOUT, signal);
      checkAbort(signal);
      const info = versionInfo(stdout);
      if (info) return { available: true, binary: bin, ...info };
    } catch {
      checkAbort(signal);
      // Unusable candidate. Keep discovery order without surfacing its output.
    }
  }
  if (unsupportedWindows) return { available: false, reason: WINDOWS_ON_LINUX_REASON };
  const install = "draw.io CLI not found or did not report a usable version. Install draw.io desktop or set DRAWME_DRAWIO_BINARY in Pi's launch environment.";
  return { available: false, reason: headlessLinux() ? `${install} ${HEADLESS_ADVICE}` : install };
}

/** Run a trusted native renderer. Callers supply absolute file operands, never shell-quoted paths. */
export async function invokeRenderer(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  if (platform() === "linux" && isRootUser()) throw new Error(ROOT_REASON);
  if (windowsOnLinux(binary)) throw new Error(WINDOWS_ON_LINUX_REASON);
  try {
    const result = await runRenderer(binary, args, undefined, signal);
    checkAbort(signal);
    return result.command;
  } catch (error) {
    checkAbort(signal);
    const advice = headlessLinux() ? ` ${HEADLESS_ADVICE}` : "";
    throw new Error(`draw.io renderer ${(error as Error).message}.${advice}`, { cause: error });
  }
}

const DOCUMENT_EXTENSIONS = new Set([".drawio", ".png", ".svg", ".pdf", ".jpg", ".jpeg"]);
const OPEN_ACK_GRACE = 250;

/** Let a Linux foreground handler outlive Pi; surface spawn and observed early exit failures. */
async function launchLinuxViewer(document: string): Promise<void> {
  let child;
  try {
    child = spawn("xdg-open", [document], { detached: true, stdio: "ignore" });
  } catch (error) {
    throw new ProcessLaunchError(error);
  }
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("close", onClose);
      child.off("error", onError);
      if (error) reject(error);
      else {
        child.unref();
        resolve();
      }
    };
    const onSpawn = () => { timer = setTimeout(finish, OPEN_ACK_GRACE); };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code === 0 ? undefined : new Error(exitStatus(code, signal)));
    };
    const onError = (error: Error) => finish(new ProcessLaunchError(error));
    child.once("spawn", onSpawn);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

/** Open an existing diagram or export with its OS file association, without a shell. */
export async function openFile(path: string): Promise<{ opener: string }> {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const document = realpathSync.native(path);
  if (!statSync(document).isFile()) throw new Error(`not a regular file: ${path}`);
  if (!DOCUMENT_EXTENSIONS.has(extname(document).toLowerCase())) {
    throw new Error(`not a supported diagram or export: ${path}`);
  }

  const plat = platform();
  const opener = plat === "darwin" ? "open" : plat === "win32" ? "rundll32" : "xdg-open";
  try {
    if (plat === "linux") {
      await launchLinuxViewer(document);
    } else if (plat === "win32") {
      const root = process.env.SystemRoot;
      if (!root || !win32.isAbsolute(root)) throw new Error("Windows SystemRoot is not configured");
      await run(win32.join(root, "System32", "rundll32.exe"), ["shell32.dll,ShellExec_RunDLL", document], PROBE_TIMEOUT);
    } else {
      await run(opener, [document], PROBE_TIMEOUT);
    }
  } catch (error) {
    throw new Error(`${opener}: ${(error as Error).message}. Check that a desktop application is available for this file type.`, { cause: error });
  }
  return { opener };
}
