import { ChildProcess, spawn } from "node:child_process";
import { getEventListeners, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliPageIndex, invokeRenderer, openFile, resolveBinary, run } from "../src/renderer";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(), platform: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);
let dir: string;

function asLinux(): void {
  vi.mocked(platform).mockReturnValue("linux");
  // Linux preparation is also exercised on Windows, where these APIs do not exist.
  for (const name of ["getuid", "geteuid"] as const) {
    if (process[name]) vi.spyOn(process, name).mockReturnValue(1001);
  }
}

function fixtureChild(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
  return Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
}

function reply(stdout = "", code = 0, launchError?: NodeJS.ErrnoException) {
  const child = fixtureChild();
  queueMicrotask(() => {
    if (launchError) child.emit("error", launchError);
    else child.emit("spawn");
    child.stdout.end(stdout);
    child.stderr.end();
    child.emit("close", launchError ? -2 : code, null);
  });
  return child;
}

function missingCommand() {
  return reply("", 0, Object.assign(new Error("private-launch-marker in original error"), { code: "ENOENT" }));
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "drawme renderer-")));
  vi.mocked(platform).mockReturnValue(process.platform);
  vi.stubEnv("DRAWME_DRAWIO_BINARY", undefined);
  vi.stubEnv("DISPLAY", undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  spawnMock.mockReset();
  vi.mocked(existsSync).mockReset();
  await rm(dir, { recursive: true, force: true });
});

describe("renderer preparation", () => {
  it("probes and renders through Xvfb without a display, but launches directly with a display", async () => {
    asLinux();
    const binary = join(dir, "Local drawio");
    await writeFile(binary, "");
    const args = ["-x", "--width", "1600", "-o", join(dir, "-out.png"), join(dir, "-input.drawio")];
    // This renderer is only usable when prepared for the system it runs on.
    spawnMock.mockImplementation((bin, argv) => bin === "xvfb-run" ? reply(
      Array.isArray(argv) && argv.includes("--version") ? "[ERROR:dbus/bus.cc] startup note\n32.4.1\n[ERROR] another note\n" : "",
    ) : reply("", 1));
    await expect(resolveBinary(binary)).resolves.toMatchObject({ available: true, version: "32.4.1", binary });
    await invokeRenderer(binary, args);
    expect(spawnMock.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([
      ["xvfb-run", ["-a", "--server-args=-screen 0 1280x1024x24", binary, "--version"]],
      ["xvfb-run", ["-a", "--server-args=-screen 0 1856x1856x24", binary, ...args]],
    ]);

    vi.stubEnv("DISPLAY", ":42");
    spawnMock.mockReset().mockImplementation(() => reply("32.4.1\n"));
    await expect(resolveBinary(binary)).resolves.toMatchObject({ available: true, binary });
    await invokeRenderer(binary, args);
    expect(spawnMock.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([
      [binary, ["--version"]], [binary, args],
    ]);
  });

  it("tries a direct invocation only when the Xvfb wrapper is absent", async () => {
    asLinux();
    spawnMock.mockImplementationOnce(missingCommand).mockImplementationOnce(() => reply());
    await expect(invokeRenderer("drawio", ["-x"])).resolves.toBe("drawio -x");
    expect(spawnMock.mock.calls.map(([bin]) => bin)).toEqual(["xvfb-run", "drawio"]);

    spawnMock.mockReset().mockImplementation(() => reply("", 127));
    await expect(invokeRenderer("drawio", ["-x"])).rejects.toThrow("exited with code 127");
    expect(spawnMock.mock.calls.map(([bin]) => bin)).toEqual(["xvfb-run"]);
  });

  it("refuses root before probing or starting Electron on Linux", async () => {
    asLinux();
    if (process.getuid) vi.mocked(process.getuid).mockReturnValue(0);
    else vi.stubGlobal("process", Object.assign(Object.create(process), { getuid: () => 0 }));
    spawnMock.mockImplementation(() => reply("32.4.1\n"));
    await expect(resolveBinary()).resolves.toMatchObject({ available: false, reason: expect.stringMatching(/unprivileged/i) });
    await expect(invokeRenderer("drawio", ["-x"])).rejects.toThrow(/unprivileged/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reports the existing WSL fallback without launching it, but allows native Windows draws", async () => {
    asLinux();
    const fallback = "/mnt/c/Program Files/draw.io/draw.io.exe";
    vi.mocked(existsSync).mockImplementation(path => path === fallback);
    spawnMock.mockImplementation(missingCommand);
    await expect(resolveBinary()).resolves.toMatchObject({ available: false, reason: expect.stringMatching(/WSL.*native Linux/) });
    expect(spawnMock.mock.calls.flatMap(([bin, argv]) => [bin, ...(Array.isArray(argv) ? argv : [])])).not.toContain(fallback);

    spawnMock.mockClear();
    await expect(invokeRenderer(fallback, ["-x", "-o", "/mnt/c/-report.svg", "/mnt/c/-input.drawio"])).rejects.toThrow(/native Linux/);
    await expect(resolveBinary(fallback)).resolves.toMatchObject({ available: false, reason: expect.stringMatching(/native Linux/) });
    expect(spawnMock).not.toHaveBeenCalled();

    vi.mocked(platform).mockReturnValue("win32");
    const exe = join(dir, "drawio.EXE");
    vi.mocked(existsSync).mockImplementation(path => path === exe);
    const args = ["-x", "-o", join(dir, "converted.drawio"), join(dir, "inline.mmd")];
    spawnMock.mockImplementation(() => reply("32.4.1\n"));
    await expect(resolveBinary(exe)).resolves.toMatchObject({ available: true, binary: exe });
    await invokeRenderer(exe, args);
    expect(spawnMock.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([[exe, ["--version"]], [exe, args]]);
  });

  it("does not keep scanning when a version probe is canceled", async () => {
    vi.mocked(platform).mockReturnValue("darwin");
    const controller = new AbortController();
    const child = fixtureChild();
    spawnMock.mockReturnValueOnce(child);
    const probe = resolveBinary(undefined, controller.signal);
    controller.abort("private-abort-marker");
    child.emit("close", 1, null);
    await expect(probe).rejects.toMatchObject({ name: "AbortError", message: expect.not.stringContaining("private-abort-marker") });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    await expect(resolveBinary(undefined, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe("CLI version conventions", () => {
  it("enables Mermaid and layout at the verified numeric baseline only", async () => {
    vi.mocked(platform).mockReturnValue("darwin");
    for (const [version, supported] of [["30.0.4", false], ["30.2.4", true], ["30.10.1", true], ["32.4.1", true]] as const) {
      spawnMock.mockImplementationOnce(() => reply(`${version}\n`));
      await expect(resolveBinary()).resolves.toMatchObject({ available: true, version, supportsMermaid: supported, supportsLayout: supported });
    }
    for (const unrecognized of ["custom build: unrecognized-version-marker\n", `${"x".repeat(8185)}\n32.4.12\n`]) {
      spawnMock.mockImplementationOnce(() => reply(unrecognized));
      const info = await resolveBinary();
      expect(info).toMatchObject({ available: true, supportsMermaid: false, supportsLayout: false });
      expect(info.version).toBeUndefined();
    }
  });

  it("uses the historical page base and refuses to guess with an unknown version or invalid page", () => {
    for (const [version, indexes] of [["26.2.15", [0, 1]], ["27.0.2", [1, 2]], ["32.4.1", [1, 2]]] as const) {
      expect([cliPageIndex(version, 1), cliPageIndex(version, 2)]).toEqual(indexes);
    }
    expect(() => cliPageIndex("unknown", 2)).toThrow(/version/i);
    expect(() => cliPageIndex("32.4.1", 0)).toThrow(/positive integer/);
    expect(() => cliPageIndex("32.4.1", 1.9)).toThrow(/positive integer/);
  });
});

describe("renderer process lifecycle", () => {
  it("drains both noisy pipes while capping retained UTF-8 output by bytes", async () => {
    const script = join(dir, "noise.cjs");
    await writeFile(script, `
      const glyph = Buffer.from("🧪");
      process.stdout.write(Buffer.concat([Buffer.from("v!"), glyph.subarray(0, 1)]));
      setImmediate(() => {
        process.stdout.write(glyph.subarray(1));
        process.stdout.write("🧪".repeat(300_000));
        process.stderr.write("€".repeat(300_000));
      });
    `);
    const { stdout, stderr } = await run(process.execPath, [script], 4_000);
    expect(Buffer.byteLength(stdout)).toBe(8190);
    expect(Buffer.byteLength(stderr)).toBe(8190);
    expect(stdout.startsWith("v!🧪")).toBe(true);
    expect(stdout.includes("\ufffd") || stderr.includes("\ufffd")).toBe(false);
  });

  it("returns useful failure categories without renderer output or spawn details", async () => {
    const script = join(dir, "failure.cjs");
    const marker = "private-renderer-marker";
    await writeFile(script, `
      process.stdout.write("${marker}" + "a".repeat(800_000));
      process.stderr.write("${marker}" + "b".repeat(800_000));
      process.exitCode = 17;
    `);
    const error = await run(process.execPath, [script], 4_000).catch((error: unknown) => error);
    expect(error).toMatchObject({ message: expect.stringMatching(/exited with code 17/) });
    expect(JSON.stringify(error)).not.toContain(marker);
    expect(error).not.toHaveProperty("stderr");
    expect(error).not.toHaveProperty("cause");

    spawnMock.mockImplementationOnce(missingCommand);
    const missing = await run("missing", ["private-command-marker"]).catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: "ENOENT", message: expect.stringMatching(/not found/i) });
    expect((missing as Error).message).not.toMatch(/private-(command|launch)-marker/);
    expect(spawnMock.mock.results.at(-1)?.value?.listenerCount("error")).toBe(0);
  });

  it.each(["abort", "timeout"] as const)("reaps the running child and its descendant on %s", async (reason) => {
    const script = join(dir, "tree.cjs");
    const ids = join(dir, "tree ids.json");
    await writeFile(script, `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      if (process.argv[2] === "descendant") {
        setInterval(() => {}, 1000);
      } else {
        const child = spawn(process.execPath, [__filename, "descendant"], { stdio: "inherit" });
        process.on("SIGTERM", () => { /* give Node time to reap the descendant */ });
        child.on("exit", () => { process.exitCode = 0; });
        writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid]));
      }
    `);
    const controller = new AbortController();
    const result = run(process.execPath, [script, ids], reason === "timeout" ? 1_500 : 4_000, controller.signal)
      .then(() => undefined, (error: unknown) => error);
    let pids: number[] = [];
    try {
      await vi.waitFor(async () => {
        pids = JSON.parse(await readFile(ids, "utf8")) as number[];
        expect(pids).toHaveLength(2);
      }, { timeout: 1_200, interval: 20 });
      for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
      if (reason === "abort") controller.abort();
      expect(await result).toMatchObject(reason === "abort"
        ? { name: "AbortError", message: expect.stringMatching(/aborted/i) }
        : { message: expect.stringMatching(/timed out/i) });
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      await expect(run(process.execPath, ["--version"])).resolves.toMatchObject({ stdout: expect.stringMatching(/^v\d/) });
    } finally {
      controller.abort();
      await result;
      for (const pid of pids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  }, 12_000);

  it.skipIf(process.platform === "win32")("escalates to SIGKILL when the renderer ignores SIGTERM", async () => {
    const script = join(dir, "stubborn.cjs");
    await writeFile(script, `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      process.stdout.write("ready\\n");
    `);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    let child!: ChildProcess;
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockImplementationOnce((bin, args, options) => (child = real.spawn(bin, args as string[], options)));
    const result = run(process.execPath, [script], 120_000, controller.signal)
      .then(() => undefined, (error: unknown) => error);
    try {
      await once(child.stdout!, "data");
      controller.abort();
      await vi.advanceTimersByTimeAsync(5001);
      expect(await result).toMatchObject({ name: "AbortError" });
      expect(child.signalCode).toBe("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await result;
    }
  });
});

describe("viewer launch", () => {
  it("acknowledges a foreground viewer promptly and leaves it alive beyond the old deadline", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const document = join(dir, "-diagram with spaces.drawio");
    const script = join(dir, "viewer.cjs");
    await writeFile(document, "");
    await writeFile(script, "setInterval(() => {}, 1000);\n");
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    let viewer!: ChildProcess;
    spawnMock.mockImplementationOnce((_bin, _args, options) => (viewer = real.spawn(process.execPath, [script], options)));
    const opened = vi.fn();
    const result = openFile(relative(process.cwd(), document)).then(opened, opened);
    const done = once(viewer, "close");
    try {
      await once(viewer, "spawn");
      await vi.advanceTimersByTimeAsync(1000);
      expect(opened).toHaveBeenCalledExactlyOnceWith({ opener: "xdg-open" });
      expect(spawnMock).toHaveBeenCalledExactlyOnceWith("xdg-open", [document], expect.not.objectContaining({ shell: true }));
      await vi.advanceTimersByTimeAsync(15_001);
      expect(() => process.kill(viewer.pid!, 0)).not.toThrow();
    } finally {
      viewer.kill();
      await done;
      await result;
    }
  });

  it("reports both missing launchers and immediate viewer failures", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    const document = join(dir, "diagram.drawio");
    await writeFile(document, "");
    spawnMock.mockImplementationOnce(missingCommand).mockImplementationOnce(() => reply("", 3));
    await expect(openFile(document)).rejects.toThrow(/xdg-open.*not found/i);
    await expect(openFile(document)).rejects.toThrow(/xdg-open.*code 3/i);
  });
});
