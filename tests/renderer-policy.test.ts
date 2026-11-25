import childProcess, { type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { platform, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";
import { crc32, inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeRenderer, isRootUser, openFile, resolveBinary, run } from "../src/renderer";
import { installNodeRendererFixture, TINY_PNG } from "./fixtures";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  platform: vi.fn(),
}));

const PRIVATE = "inert-private-marker";
let dir: string;
let restoreFixtures: (() => void) | undefined;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "drawme renderer policy ")));
  vi.mocked(platform).mockReturnValue(process.platform);
  vi.stubEnv("DRAWME_DRAWIO_BINARY", undefined);
  vi.stubEnv("DISPLAY", ":99");
});

afterEach(async () => {
  vi.restoreAllMocks();
  restoreFixtures?.();
  restoreFixtures = undefined;
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function script(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body);
  return path;
}

function fixtures(...scripts: string[]): void {
  restoreFixtures = installNodeRendererFixture(scripts);
}

/** Route subprocesses to real Node fixtures or a known missing path, never the host desktop. */
function routeSpawn(route: (bin: string) => string | undefined) {
  const spawn = childProcess.spawn;
  const spy = vi.spyOn(childProcess, "spawn").mockImplementation((bin, args, options) => {
    if (!Array.isArray(args)) throw new Error("expected an argv array");
    return spawn(route(bin) ?? join(dir, "missing-executable"), args, options);
  });
  syncBuiltinESMExports();
  return spy;
}

const versionScript = (version: string) => `
  const [action] = process.argv.slice(2);
  if (action === "--version") console.log(${JSON.stringify(version)});
  else require("node:fs").writeFileSync(process.argv[3], Buffer.from("${TINY_PNG}", "base64"));
`;

it("uses Node only for approved fixtures and restores spawn and identity", async () => {
  const standIn = await script("fixture with spaces.cjs", "console.log(JSON.stringify(process.argv.slice(2)));");
  const originalSpawn = childProcess.spawn;
  const originalUid = process.getuid;
  process.getuid = () => 0;
  try {
    const restore = installNodeRendererFixture([standIn]);
    try {
      const args = ["-dash leading file.drawio", join(dir, "output image.png")];
      expect(JSON.parse((await run(standIn, args)).stdout)).toEqual(args);
      expect((await run(process.execPath, ["--version"])).stdout).toMatch(/^v\d/);
      expect(isRootUser()).toBe(false);
    } finally {
      restore();
    }
    expect(childProcess.spawn).toBe(originalSpawn);
    expect(process.getuid()).toBe(0);
  } finally {
    process.getuid = originalUid;
  }
});

it("provides a complete decodable 1×1 PNG with valid CRCs in every chunk", () => {
  const png = Buffer.from(TINY_PNG, "base64");
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const types: string[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + 8 + length;
    const type = png.toString("ascii", offset + 4, offset + 8);
    expect(crc32(png.subarray(offset + 4, end)), `${type} CRC`).toBe(png.readUInt32BE(end));
    types.push(type);
    if (type === "IHDR") expect([png.readUInt32BE(offset + 8), png.readUInt32BE(offset + 12)]).toEqual([1, 1]);
    if (type === "IDAT") expect(inflateSync(png.subarray(offset + 8, end))).toHaveLength(3);
    offset = end + 4;
  }
  expect(types).toEqual(["IHDR", "IDAT", "IEND"]);
});

describe("native renderer policy", () => {
  it("uses compatible Xvfb preparation for a stock probe and render; uses the desktop directly", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    vi.stubEnv("DISPLAY", undefined);
    const binary = await script("stock drawio.cjs", `
      if (!process.env.DISPLAY) process.exit(14);
      ${versionScript("32.4.1")}
    `);
    const wrapper = await script("xvfb stand-in.cjs", `
      process.env.DISPLAY = ':123';
      const [, , bin, ...args] = process.argv.slice(2);
      if (args[0] === '--version') console.log('[Electron] headless warning 99.0.0');
      const child = require('node:child_process').spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' });
      process.exit(child.status ?? 1);
    `);
    fixtures(binary, wrapper);
    const spawn = routeSpawn((bin) => bin === "xvfb-run" ? wrapper : bin === binary ? bin : undefined);
    const output = join(dir, "rendered diagram.png");
    const args = ["-o", output, "--width", "1700", join(dir, "-spaced input.drawio")];

    expect(await resolveBinary(binary)).toMatchObject({ available: true, binary, version: "32.4.1" });
    expect(await invokeRenderer(binary, args)).toMatch(/^xvfb-run /);
    expect(await readFile(output, "base64")).toBe(TINY_PNG);
    expect(spawn.mock.calls.map(([bin, argv]) => [bin, argv])).toEqual([
      ["xvfb-run", ["-a", "--server-args=-screen 0 1280x1024x24", binary, "--version"]],
      ["xvfb-run", ["-a", "--server-args=-screen 0 1956x1956x24", binary, ...args]],
    ]);

    vi.stubEnv("DISPLAY", ":99");
    spawn.mockClear();
    expect(await resolveBinary(binary)).toMatchObject({ available: true, binary });
    expect(await invokeRenderer(binary, args)).toBe(`${binary} ${args.join(" ")}`);
    expect(spawn.mock.calls.map(([bin]) => bin)).toEqual([binary, binary]);
  });

  it("falls back to a direct command only if xvfb-run is missing", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    vi.stubEnv("DISPLAY", undefined);
    const binary = await script("custom drawio.cjs", versionScript("32.4.1"));
    const failingWrapper = await script("installed xvfb.cjs", "process.exitCode = 9;");
    fixtures(binary, failingWrapper);
    let wrapperInstalled = false;
    const spawn = routeSpawn((bin) => bin === binary ? bin : bin === "xvfb-run" && wrapperInstalled ? failingWrapper : undefined);
    expect(await resolveBinary(binary)).toMatchObject({ available: true, binary });
    expect(spawn.mock.calls.map(([bin]) => bin)).toEqual(["xvfb-run", binary]);

    wrapperInstalled = true;
    spawn.mockClear();
    await expect(invokeRenderer(binary, ["--version"])).rejects.toThrow("exited with code 9");
    expect(spawn.mock.calls.map(([bin]) => bin)).toEqual(["xvfb-run"]);
  });

  it.each([["30.0.4", false], ["30.2.4", true]] as const)("reports precise capabilities for %s without gating ordinary exports", async (version, capable) => {
    const binary = await script("drawio stand-in.cjs", versionScript(version));
    fixtures(binary);
    expect(await resolveBinary(binary)).toMatchObject({ available: true, major: 30, version, supportsMermaid: capable, supportsLayout: capable });
    const output = join(dir, "image.png");
    await invokeRenderer(binary, ["-o", output]);
    expect(await readFile(output, "base64")).toBe(TINY_PNG);
  });

  it("rejects a clipped version line and keeps trusted candidate ordering", async () => {
    const unknown = await script("configured drawio.cjs", versionScript(`99.0.0${" ".repeat(8192)}${PRIVATE}`));
    const native = await script("native drawio.cjs", versionScript("30.0.4"));
    fixtures(unknown, native);
    const spawn = routeSpawn((bin) => bin === "drawio" ? native : bin === unknown ? unknown : undefined);
    vi.stubEnv("DRAWME_DRAWIO_BINARY", unknown);
    expect(await resolveBinary()).toMatchObject({ available: true, binary: "drawio", version: "30.0.4", supportsLayout: false });
    expect(spawn.mock.calls.map(([bin]) => bin)).toEqual([unknown, "drawio"]);
    vi.stubEnv("DRAWME_DRAWIO_BINARY", "relative setting.cjs");
    spawn.mockClear();
    expect(await resolveBinary()).toMatchObject({ available: true, binary: "drawio" });
    expect(spawn.mock.calls.map(([bin]) => bin)).toEqual(["drawio"]);
  });

  it("refuses privileged Linux discovery and rendering before spawning", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    const native = await script("native drawio.cjs", versionScript("32.4.1"));
    fixtures(native);
    const spawn = routeSpawn((bin) => bin === native ? bin : undefined);
    const originalUid = process.getuid;
    process.getuid = () => 0;
    try {
      await expect(resolveBinary(native)).resolves.toMatchObject({ available: false, reason: expect.stringMatching(/unprivileged user/) });
      await expect(invokeRenderer(native, ["--version"])).rejects.toThrow("unprivileged user");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      process.getuid = originalUid;
    }
    await expect(resolveBinary(native)).resolves.toMatchObject({ available: true });
  });

  it("declines a Windows executable on Linux/WSL, with native Linux and Windows controls", async () => {
    const windows = await script("Windows drawio.exe", versionScript("32.4.1"));
    const linux = await script("linux drawio.cjs", versionScript("32.4.1"));
    fixtures(windows, linux);
    let nativeAvailable = false;
    const spawn = routeSpawn((bin) => bin === windows ? windows : bin === "drawio" && nativeAvailable ? linux : undefined);
    vi.mocked(platform).mockReturnValue("linux");
    await expect(resolveBinary(windows)).resolves.toMatchObject({ available: false, reason: expect.stringMatching(/native Linux draw\.io/) });
    await expect(invokeRenderer(windows, ["--version"])).rejects.toThrow("native Linux draw.io");
    nativeAvailable = true;
    await expect(resolveBinary(windows)).resolves.toMatchObject({ available: true, binary: "drawio" });
    expect(spawn.mock.calls.map(([bin]) => bin)).not.toContain(windows);
    vi.mocked(platform).mockReturnValue("win32");
    await expect(resolveBinary(windows)).resolves.toMatchObject({ available: true, binary: windows });
    await expect(invokeRenderer(windows, ["--version"])).resolves.toBe(`${windows} --version`);
  });
});

describe("renderer child lifecycle", () => {
  it("drains noisy streams while bounding both prefixes and redacting process failures", async () => {
    const binary = await script("noisy renderer.cjs", `
      const fs = require('node:fs');
      const [done, code, marker] = process.argv.slice(2);
      async function flood(stream) {
        for (let i = 0; i < 8; i++) {
          await new Promise(resolve => stream.write(marker + 'x'.repeat(128 * 1024), resolve));
        }
      }
      Promise.all([flood(process.stdout), flood(process.stderr)]).then(() => {
        fs.writeFileSync(done, 'drained');
        process.exitCode = Number(code);
      });
    `);
    fixtures(binary);
    const failed = join(dir, "failed.txt");
    const error: unknown = await invokeRenderer(binary, [failed, "9", PRIVATE]).catch((error: unknown) => error);
    expect(error).toMatchObject({ message: "draw.io renderer exited with code 9." });
    expect(inspect(error)).not.toContain(PRIVATE);
    expect(await readFile(failed, "utf8")).toBe("drained");
    const { stdout, stderr } = await run(binary, [join(dir, "success.txt"), "0", PRIVATE]);
    expect([Buffer.byteLength(stdout), Buffer.byteLength(stderr)]).toEqual([8192, 8192]);
  });

  it("does not spawn for a pre-aborted probe or render", async () => {
    fixtures();
    const spawn = routeSpawn(() => undefined);
    const signal = AbortSignal.abort(PRIVATE);
    await expect(resolveBinary(undefined, signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(invokeRenderer("drawio", [], signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("aborts a running probe, reaps the process and does not try another candidate", async () => {
    const pidFile = join(dir, "probe pid");
    const binary = await script("running probe.cjs", `
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    fixtures(binary);
    const spawn = routeSpawn((bin) => bin === binary ? bin : undefined);
    const controller = new AbortController();
    const aborted = expect(resolveBinary(binary, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    try {
      const pid = await vi.waitFor(async () => Number(await readFile(pidFile, "utf8")));
      controller.abort(PRIVATE);
      await aborted;
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      expect(spawn.mock.calls.map(([bin]) => bin)).toEqual([binary]);
    } finally {
      controller.abort();
      await aborted;
    }
  });

  it("times out and waits for a running child to close", async () => {
    const binary = await script("slow process.cjs", "setInterval(() => {}, 1000);");
    fixtures(binary);
    const spawn = routeSpawn((bin) => bin === binary ? bin : undefined);
    await expect(run(binary, [], 500)).rejects.toThrow("timed out");
    const child: ChildProcess = spawn.mock.results[0].value;
    expect(() => process.kill(child.pid!, 0)).toThrow(/ESRCH/);
  });

  it.skipIf(process.platform === "win32")("aborts a POSIX render group and waits for its leader to close", async () => {
    const pids = join(dir, "worker pids");
    const binary = await script("render tree.cjs", `
      if (process.argv[2] === 'worker') {
        setInterval(() => {}, 1000);
        process.send('ready');
      } else {
        const child = require('node:child_process').fork(__filename, ['worker']);
        process.on('SIGTERM', () => {});
        child.on('close', () => process.exit(0));
        child.on('message', () => require('node:fs').writeFileSync(process.argv[2], JSON.stringify([process.pid, child.pid])));
      }
    `);
    fixtures(binary);
    const controller = new AbortController();
    const aborted = expect(invokeRenderer(binary, [pids], controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    try {
      const running = await vi.waitFor(async () => JSON.parse(await readFile(pids, "utf8")) as number[]);
      controller.abort();
      await aborted;
      for (const pid of running) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      controller.abort();
      await aborted;
    }
  });
});

describe("Linux desktop opening", () => {
  it("acknowledges a detached viewer without killing it after the former 15-second expiry", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    const document = await script("-Draft document.DRAWIO", "");
    const ready = join(dir, "viewer arguments");
    const viewer = await script("document viewer.cjs", `
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify(process.argv.slice(2)));
      setInterval(() => {}, 1000);
    `);
    fixtures(viewer);
    const spawn = routeSpawn((bin) => bin === "xdg-open" ? viewer : undefined);
    const started = performance.now();
    const opened = openFile(relative(process.cwd(), document));
    const child: ChildProcess = spawn.mock.results[0].value;
    const exited = once(child, "close");
    try {
      await expect(opened).resolves.toEqual({ opener: "xdg-open" });
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(spawn).toHaveBeenCalledExactlyOnceWith("xdg-open", [document], expect.objectContaining({ detached: true, stdio: "ignore" }));
      expect(spawn.mock.calls[0][2]).not.toHaveProperty("shell", true);
      expect(await vi.waitFor(() => readFile(ready, "utf8"))).toBe(JSON.stringify([document]));
      await delay(15_100);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(process.kill(child.pid!, 0)).toBe(true);
    } finally {
      child.kill();
      await exited;
    }
  }, 25_000);

  it("reports launcher startup and immediate exit errors without returning child text", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    const document = await script("draft.svg", "");
    const failure = await script("failed opener.cjs", `console.error('${PRIVATE}'); process.exitCode = 3;`);
    fixtures(failure);
    let launcherExists = false;
    routeSpawn((bin) => launcherExists && bin === "xdg-open" ? failure : undefined);
    await expect(openFile(document)).rejects.toThrow(/xdg-open: could not start \(ENOENT\).*desktop application/);
    launcherExists = true;
    await expect(openFile(document)).rejects.toThrow(/xdg-open: exited with code 3.*desktop application/);
  });

  it("refuses directories and unsupported canonical targets before spawning", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    const spawn = routeSpawn(() => undefined);
    const directory = join(dir, "drawer.drawio");
    await mkdir(directory);
    await expect(openFile(directory)).rejects.toThrow("regular file");
    const unsupported = await script("notes.txt", "");
    await expect(openFile(unsupported)).rejects.toThrow("supported diagram or export");
    if (process.platform !== "win32") {
      const alias = join(dir, "diagram.drawio");
      await symlink(unsupported, alias);
      await expect(openFile(alias)).rejects.toThrow("supported diagram or export");
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});
