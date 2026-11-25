/** Process boundary for the trusted draw.io Desktop CLI and desktop document opener. */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import { extname, isAbsolute, win32 } from "node:path";

export interface DrawioInfo {
  available: boolean;
  binary?: string;
  version?: string;
  major?: number;
  supportsMermaid?: boolean;
  supportsLayout?: boolean;
  reason?: string;
}

const OUTPUT_LIMIT = 8192; // bytes retained per stream, not characters
const RENDER_TIMEOUT = 120_000;
const PROBE_TIMEOUT = 15_000;
const KILL_GRACE = 5_000;
const VIEWER_STARTUP = 200;

export const LINUX_ROOT_RENDERER_REASON =
  "draw.io cannot run as root on Linux with its sandbox enabled. Run Pi as an unprivileged user.";
const WINDOWS_RENDERER_REASON =
  "Windows draw.io executables are not supported on Linux or WSL. Install the native Linux draw.io desktop CLI.";

const PLATFORM_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/Applications/draw.io.app/Contents/MacOS/draw.io"],
  win32: [String.raw`C:\Program Files\draw.io\draw.io.exe`, String.raw`C:\Program Files (x86)\draw.io\draw.io.exe`],
  linux: ["/mnt/c/Program Files/draw.io/draw.io.exe"],
};

class SpawnFailure extends Error {
  readonly code?: "ENOENT" | "EACCES" | "EPERM";

  constructor(subject: string, original: unknown) {
    // Never forward spawn's message, path, argv, or cause to the caller.
    const code = (original as NodeJS.ErrnoException | null)?.code;
    const why = code === "ENOENT" ? "executable not found"
      : code === "EACCES" || code === "EPERM" ? "permission denied" : "could not start";
    super(`${subject}: ${why}`);
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") this.code = code;
  }
}

function abortError(): DOMException {
  return new DOMException("draw.io operation was aborted", "AbortError");
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return `terminated by ${signal}`;
  if (code !== null) return `exited with code ${code}`;
  return "exited without a status";
}

function byteBuffer() {
  const bytes = Buffer.allocUnsafe(OUTPUT_LIMIT);
  let used = 0;
  let truncated = false;
  return {
    append(chunk: Buffer) {
      const keep = Math.min(chunk.length, bytes.length - used);
      if (keep > 0) used += chunk.copy(bytes, used, 0, keep);
      truncated ||= keep < chunk.length;
    },
    get truncated() { return truncated; },
    text() {
      // Ignore a partial last character rather than exceed the byte cap with a replacement glyph.
      // Invalid UTF-8 is not useful for version discovery or other textual callers.
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used), { stream: true }); }
      catch { return ""; }
    },
  };
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); } catch { /* process group already gone */ }
}

function killChild(child: ChildProcess): void {
  try { child.kill(); } catch { /* process already gone */ }
}

function windowsSystemTool(file: string): string | undefined {
  const root = process.env.SystemRoot;
  return root && win32.isAbsolute(root) ? win32.join(root, "System32", file) : undefined;
}

async function stopWindowsTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const taskkill = windowsSystemTool("taskkill.exe");
  if (taskkill) {
    try {
      // Keep the parent alive until taskkill can enumerate its descendants.
      const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const killed = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => killChild(killer), KILL_GRACE);
        const onError = () => { /* close reports a failed launch */ };
        killer.on("error", onError);
        killer.once("close", code => {
          clearTimeout(timer);
          killer.off("error", onError);
          resolve(code === 0);
        });
      });
      if (killed) return;
    } catch { /* fall back to terminating the directly owned process */ }
  }
  killChild(child);
}

type ProcessOutput = { stdout: string; stderr: string };
type CapturedOutput = ProcessOutput & { stdoutTruncated: boolean };

/** Run a command, drain both pipes, and await close even after an abort or timeout. */
export async function run(bin: string, args: string[], timeout = RENDER_TIMEOUT, signal?: AbortSignal): Promise<ProcessOutput> {
  const { stdout, stderr } = await runProcess(bin, args, timeout, signal);
  return { stdout, stderr };
}

function runProcess(
  bin: string, args: string[], timeout: number, signal?: AbortSignal, subject = "draw.io process",
): Promise<CapturedOutput> {
  return new Promise((resolve, reject) => {
    checkAbort(signal);
    const grouped = platform() !== "win32";
    const child = (() => {
      try { return spawn(bin, args, { detached: grouped, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
      catch (error) { throw new SpawnFailure(subject, error); }
    })();
    const stdout = byteBuffer();
    const stderr = byteBuffer();
    let failure: Error | undefined;
    let stopping = false;
    let killTimer: NodeJS.Timeout | undefined;
    let windowsCleanup: Promise<void> | undefined;
    const forceGroupExit = () => {
      killTimer = undefined;
      signalGroup(child.pid, "SIGKILL");
    };
    const stop = (error: Error) => {
      if (stopping) return;
      failure = error;
      stopping = true;
      clearTimeout(timer);
      if (grouped) {
        signalGroup(child.pid, "SIGTERM");
        if (child.pid !== undefined) killTimer = setTimeout(forceGroupExit, KILL_GRACE);
      } else {
        windowsCleanup = stopWindowsTree(child);
      }
    };
    const onAbort = () => stop(abortError());
    const onPipeError = () => stop(new Error(`${subject}: could not read process output`));
    const onError = (error: Error) => { failure ??= new SpawnFailure(subject, error); };
    const timer = setTimeout(() => stop(new Error(`${subject} timed out after ${timeout / 1000}s`)), timeout);

    child.stdout.on("data", stdout.append).on("error", onPipeError);
    child.stderr.on("data", stderr.append).on("error", onPipeError);
    child.on("error", onError);
    child.once("close", (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", stdout.append).off("error", onPipeError);
      child.stderr.off("data", stderr.append).off("error", onPipeError);
      // A descendant might have closed its pipes before the group leader exited.
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        forceGroupExit();
      }

      const settle = () => {
        child.off("error", onError);
        if (failure) reject(failure);
        else if (code === 0) resolve({ stdout: stdout.text(), stderr: stderr.text(), stdoutTruncated: stdout.truncated });
        else reject(new Error(`${subject} ${exitReason(code, killedBy)}`));
      };
      if (windowsCleanup) void windowsCleanup.then(settle);
      else settle();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

type VersionTuple = [number, number, number];

function versionTuple(version: string): VersionTuple | undefined {
  const match = /^v?(\d{1,8})\.(\d{1,8})\.(\d{1,8})$/.exec(version);
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: VersionTuple, minimum: VersionTuple): boolean {
  for (let i = 0; i < version.length; i++) {
    if (version[i] !== minimum[i]) return version[i] > minimum[i];
  }
  return true;
}

/** DrawMe exposes 1-based pages. Desktop switched from 0-based in v27.0.2. */
export function cliPageIndex(version: string, page: number): number {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("pageIndex must be a positive integer");
  const tuple = versionTuple(version);
  if (!tuple) throw new Error("Cannot select a page with an unknown draw.io version. Install a tagged draw.io Desktop release.");
  return atLeast(tuple, [27, 0, 2]) ? page : page - 1;
}

function linuxRoot(plat: NodeJS.Platform): boolean {
  return plat === "linux" && (process.getuid?.() === 0 || process.geteuid?.() === 0);
}

function unsupportedBinary(plat: NodeJS.Platform, bin: string): string | undefined {
  if (plat === "linux" && /\.exe$/i.test(bin)) return WINDOWS_RENDERER_REASON;
}

/** Resolve a trusted override or absolute launch configuration, then standard candidates. */
export async function resolveBinary(trustedOverride?: string, signal?: AbortSignal): Promise<DrawioInfo> {
  checkAbort(signal);
  const plat = platform();
  if (linuxRoot(plat)) return { available: false, reason: LINUX_ROOT_RENDERER_REASON };
  const configured = process.env.DRAWME_DRAWIO_BINARY;
  const preferred = trustedOverride || (configured && isAbsolute(configured) ? configured : undefined);
  const preferredRefusal = preferred && unsupportedBinary(plat, preferred);
  if (preferredRefusal) return { available: false, reason: preferredRefusal };
  const candidates = new Set([...(preferred ? [preferred] : []), "drawio", "draw.io", ...(PLATFORM_CANDIDATES[plat] ?? [])]);
  let reason: string | undefined;
  for (const bin of candidates) {
    checkAbort(signal);
    if ((bin.includes("/") || bin.includes("\\")) && !existsSync(bin)) continue;
    const refusal = unsupportedBinary(plat, bin);
    if (refusal) {
      reason = refusal;
      continue;
    }
    try {
      const { stdout, stdoutTruncated } = await preparedRenderer(bin, ["--version"], PROBE_TIMEOUT, signal);
      checkAbort(signal);
      if (!stdout.trim()) continue;
      // Under Xvfb, Electron's startup diagnostics can precede the actual version on stdout.
      // Accept only an unambiguous complete version line, never the diagnostics themselves.
      const lines = stdout.split(/\r?\n/);
      if (stdoutTruncated) lines.pop();
      const versions = new Set(lines.map(line => line.trim()).filter(line => versionTuple(line)));
      const version = versions.size === 1 ? versions.values().next().value : undefined;
      const tuple = version ? versionTuple(version) : undefined;
      // v30.0.4 lacks both options; v30.2.4 is the verified functional baseline.
      const supported = tuple !== undefined && atLeast(tuple, [30, 2, 4]);
      return {
        available: true, binary: bin, version, major: tuple?.[0],
        supportsMermaid: supported, supportsLayout: supported,
      };
    } catch {
      checkAbort(signal);
      // This candidate is not usable; continue discovery.
    }
  }
  return reason ? { available: false, reason } : { available: false };
}

/** Fit the requested raster in the virtual screen, allowing room for renderer padding. */
export function xvfbScreen(args: string[]): string {
  const want = Math.max(flagNumber(args, "--width"), flagNumber(args, "--height"));
  const side = want > 0 ? Math.min(8192, want + 256) : 0;
  return `${Math.max(1280, side)}x${Math.max(1024, side)}x24`;
}

function flagNumber(args: string[], flag: string): number {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) || 0 : 0;
}

async function preparedRenderer(
  binary: string, args: string[], timeout: number, signal?: AbortSignal,
): Promise<CapturedOutput & { command: string }> {
  checkAbort(signal);
  const plat = platform();
  const refusal = linuxRoot(plat) ? LINUX_ROOT_RENDERER_REASON : unsupportedBinary(plat, binary);
  if (refusal) throw new Error(refusal);
  if (plat === "linux" && !process.env.DISPLAY) {
    const screen = `-screen 0 ${xvfbScreen(args)}`;
    try {
      const result = await runProcess("xvfb-run", ["-a", `--server-args=${screen}`, binary, ...args], timeout, signal);
      return { ...result, command: `xvfb-run -a --server-args="${screen}" ${[binary, ...args].join(" ")}` };
    } catch (error) {
      checkAbort(signal);
      // A running wrapper's failure is not evidence that the wrapper is missing.
      if (!(error instanceof SpawnFailure && error.code === "ENOENT")) throw error;
    }
  }
  const result = await runProcess(binary, args, timeout, signal);
  return { ...result, command: [binary, ...args].join(" ") };
}

/** File arguments must already be absolute. The returned command is diagnostic only. */
export async function invokeRenderer(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { command } = await preparedRenderer(binary, args, RENDER_TIMEOUT, signal);
  checkAbort(signal);
  return command;
}

const DOCUMENT_EXTENSIONS = new Set([".drawio", ".png", ".svg", ".pdf", ".jpg", ".jpeg"]);

/** Launch xdg-open without imposing a lifetime on a foreground viewer. */
function launchViewer(document: string): Promise<void> {
  const subject = "xdg-open";
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawn(subject, [document], { detached: true, stdio: "ignore" }); }
    catch (error) { throw new SpawnFailure(subject, error); }
    let timer: NodeJS.Timeout | undefined;
    const settle = (error?: Error) => {
      clearTimeout(timer);
      child.off("spawn", onSpawn).off("error", onError).off("close", onClose);
      child.unref();
      if (error) reject(error);
      else resolve();
    };
    const onSpawn = () => { timer = setTimeout(settle, VIEWER_STARTUP); };
    const onError = (error: Error) => settle(new SpawnFailure(subject, error));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      settle(code === 0 ? undefined : new Error(`${subject} ${exitReason(code, signal)}`));
    };
    child.once("spawn", onSpawn).once("error", onError).once("close", onClose);
  });
}

/** Open an existing diagram or export in its OS default application. No version gate. */
export async function openFile(path: string): Promise<{ opener: string }> {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const document = realpathSync.native(path);
  if (!statSync(document).isFile()) throw new Error(`not a regular file: ${path}`);
  if (!DOCUMENT_EXTENSIONS.has(extname(document).toLowerCase())) {
    throw new Error(`not a supported diagram or export: ${path}`);
  }
  const plat = platform();
  if (plat === "darwin") {
    await runProcess("open", [document], PROBE_TIMEOUT, undefined, "open");
    return { opener: "open" };
  }
  if (plat === "win32") {
    const rundll32 = windowsSystemTool("rundll32.exe");
    if (!rundll32) throw new Error("Windows SystemRoot is not configured");
    await runProcess(rundll32, ["shell32.dll,ShellExec_RunDLL", document], PROBE_TIMEOUT, undefined, "rundll32");
    return { opener: "rundll32" };
  }
  await launchViewer(document);
  return { opener: "xdg-open" };
}
