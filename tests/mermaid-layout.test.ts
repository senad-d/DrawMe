import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { platform, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mermaidArgs, layoutArgs, applyLayout, convertMermaid, LAYOUT_PRESETS, type LayoutPreset } from "../src/import-layout";
import { resolveBinary } from "../src/renderer";
import { installNodeRendererFixture } from "./fixtures";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  platform: vi.fn(),
}));

const GRAPH = '<mxGraphModel page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
const INLINE = "flowchart LR\n  A[Inline] --> B";
const FILE = "flowchart TD\n  C[From file] --> D";
const INPUT_GUARD = "provide exactly one of `input` (a .mmd file path) or `mermaid` (nonblank inline Mermaid text)";
let dir: string;
let restoreFixture: (() => void) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawme import args "));
  vi.mocked(platform).mockReturnValue(process.platform);
  vi.stubEnv("DISPLAY", ":99");
  vi.stubEnv("DRAWME_DRAWIO_BINARY", undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  restoreFixture?.();
  restoreFixture = undefined;
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

/** Permit real Node fixtures but never probe the installed desktop as a fallback. */
function onlyFixtures(...scripts: string[]) {
  restoreFixture = installNodeRendererFixture(scripts);
  const spawn = childProcess.spawn;
  const calls = vi.spyOn(childProcess, "spawn").mockImplementation((bin, args, options) => {
    if (!Array.isArray(args)) throw new Error("expected an argv array");
    return spawn(scripts.includes(bin) ? bin : join(dir, "missing-executable"), args, options);
  });
  syncBuiltinESMExports();
  return calls;
}

async function rendererFixture(version = "30.2.4", filename = "drawio stand-in.cjs") {
  const binary = join(dir, filename);
  const log = join(dir, "argv.json");
  await writeFile(binary, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args[0] === '--version') console.log(${JSON.stringify(version)});
    else {
      const input = args.at(-1);
      const output = args[args.indexOf('-o') + 1];
      const text = fs.readFileSync(input, 'utf8');
      fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, output, text }));
      fs.writeFileSync(output, ${JSON.stringify(GRAPH)});
    }
  `);
  return { binary, log, spawn: onlyFixtures(binary) };
}

describe("mermaid / layout arg builders", () => {
  it("mermaidArgs converts to xml format", () => {
    expect(mermaidArgs("d.mmd", "d.drawio")).toEqual(["-x", "-f", "xml", "-o", "d.drawio", "d.mmd"]);
  });

  it("layoutArgs passes the preset through --layout", () => {
    expect(layoutArgs("d.drawio", "verticalTree", "d.layout.drawio")).toEqual([
      "-x",
      "-f",
      "xml",
      "--layout",
      "verticalTree",
      "-o",
      "d.layout.drawio",
      "d.drawio",
    ]);
  });

  it("exposes exactly the safe ELK presets", () => {
    expect([...LAYOUT_PRESETS]).toEqual([
      "verticalFlow",
      "horizontalFlow",
      "verticalTree",
      "horizontalTree",
      "radialTree",
      "organic",
    ]);
  });
});

describe("native import / layout guards", () => {
  it("rejects an unknown layout preset before doing any work", async () => {
    const spawn = onlyFixtures();
    await expect(applyLayout({ input: "whatever.drawio", preset: "bogus" as LayoutPreset })).rejects.toThrow(/unknown layout preset/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects missing or blank Mermaid input even with a capable renderer", async () => {
    const { binary, log, spawn } = await rendererFixture();
    expect(await resolveBinary(binary)).toMatchObject({ binary, version: "30.2.4", supportsMermaid: true });
    spawn.mockClear();
    const output = join(dir, "unused.drawio");
    await expect(convertMermaid({ binary, output })).rejects.toThrow(INPUT_GUARD);
    await expect(convertMermaid({ mermaid: " \n ", binary, output })).rejects.toThrow(INPUT_GUARD);
    expect(spawn).not.toHaveBeenCalled();
    await expect(stat(log)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects distinguishable file and inline input together without replacing the destination", async () => {
    const { binary, spawn } = await rendererFixture();
    const input = join(dir, "input.mmd");
    const output = join(dir, "existing.drawio");
    await writeFile(input, FILE);
    await writeFile(output, "prior diagram");
    await expect(convertMermaid({ input, mermaid: INLINE, binary, output })).rejects.toThrow(INPUT_GUARD);
    expect(spawn).not.toHaveBeenCalled();
    expect(await readFile(output, "utf8")).toBe("prior diagram");
  });

  it("reports a missing CLI separately when the inputs are valid", async () => {
    onlyFixtures();
    const input = join(dir, "input.drawio");
    await writeFile(input, GRAPH);
    await expect(convertMermaid({ mermaid: INLINE, output: join(dir, "converted.drawio") })).rejects.toThrow(/^draw\.io CLI not found/);
    await expect(applyLayout({ input, preset: "verticalFlow" })).rejects.toThrow(/^draw\.io CLI not found/);
  });

  it("rejects both features on early v30 before invoking either operation", async () => {
    const { binary, log, spawn } = await rendererFixture("30.0.4");
    const input = join(dir, "input.drawio");
    await writeFile(input, GRAPH);
    await expect(convertMermaid({ mermaid: INLINE, binary })).rejects.toThrow("Mermaid conversion requires draw.io 30.2.4 or later (found 30.0.4)");
    await expect(applyLayout({ input, preset: "verticalFlow", binary })).rejects.toThrow("The --layout pass requires draw.io 30.2.4 or later (found 30.0.4)");
    expect(spawn.mock.calls.map(([, args]) => args)).toEqual([["--version"], ["--version"]]);
    await expect(stat(log)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("declines Windows-only rendering on WSL before passing it a temporary operand", async () => {
    const { binary, spawn } = await rendererFixture("32.4.1", "Windows drawio.exe");
    vi.mocked(platform).mockReturnValue("linux");
    await expect(convertMermaid({ mermaid: INLINE, binary })).rejects.toThrow("Install native Linux draw.io instead");
    expect(spawn.mock.calls.map(([bin]) => bin)).not.toContain(binary);
  });

  it("rejects a directory destination rather than delivering its path", async () => {
    const { binary, log } = await rendererFixture();
    const output = join(dir, "existing.drawio");
    await mkdir(output);
    await expect(convertMermaid({ mermaid: INLINE, binary, output })).rejects.toThrow("output must name a regular file");
    await expect(stat(log)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Mermaid renderer operands", () => {
  it("converts a dash-leading file name with spaces using an absolute argv operand", async () => {
    const { binary, log } = await rendererFixture();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const input = "-mermaid input.mmd";
    const output = "-mermaid input.drawio";
    await writeFile(join(dir, input), FILE);
    const result = await convertMermaid({ input, binary });
    expect(result).toMatchObject({ output, binary, version: "30.2.4" });
    const invocation = JSON.parse(await readFile(log, "utf8"));
    expect(invocation.args).toEqual(["-x", "-f", "xml", "-o", invocation.output, join(dir, input)]);
    expect(invocation.text).toBe(FILE);
    expect(isAbsolute(invocation.output)).toBe(true);
    expect(invocation.output).not.toBe(join(dir, output));
    expect((await stat(join(dir, result.output))).isFile()).toBe(true);
    expect(await readFile(join(dir, result.output), "utf8")).toBe(GRAPH.replace('page="0"', 'page="1"'));
  });

  it("converts inline text using an absolute temporary input and removes its staging files", async () => {
    const { binary, log } = await rendererFixture();
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const result = await convertMermaid({ mermaid: INLINE, binary });
    expect(result).toMatchObject({ output: join(dir, "diagram.drawio"), binary, version: "30.2.4" });
    const invocation = JSON.parse(await readFile(log, "utf8"));
    expect(invocation.args).toEqual(["-x", "-f", "xml", "-o", invocation.output, invocation.input]);
    expect(isAbsolute(invocation.input) && isAbsolute(invocation.output)).toBe(true);
    expect(invocation.text).toBe(INLINE);
    expect(await readFile(result.output, "utf8")).toBe(GRAPH.replace('page="0"', 'page="1"'));
    await expect(stat(invocation.input)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(invocation.output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
