import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { withDiagramFiles } from "../src/diagram-files";
import { mermaidArgs, layoutArgs, applyLayout, convertMermaid, LAYOUT_PRESETS } from "../src/editable-import";
import { fitCanvasFile } from "../src/fitcanvas";
import { installRendererFixtureAdapter, writeRendererFixture } from "./renderer-fixture";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, existsSync: vi.fn(fs.existsSync) };
});
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, platform: vi.fn(os.platform) };
});

installRendererFixtureAdapter();
let dir: string;
let trace: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawme editable import-"));
  trace = join(dir, "argv.ndjson");
  vi.stubEnv("DRAWME_DRAWIO_BINARY", undefined);
  vi.stubEnv("PATH", dir);
  for (const uid of ["getuid", "geteuid"] as const) {
    if (process[uid]) vi.spyOn(process, uid).mockReturnValue(1001);
  }
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(existsSync).mockReset();
  vi.mocked(platform).mockReset();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const MODEL = `<mxGraphModel page="1" pageWidth="640" pageHeight="480" pageScale="0.8" background="#18243A"><root>
  <mxCell id="0" custom="motion"/><mxCell id="1" parent="0"/>
  <UserObject id="a" label="Authored label" extra="keep"><mxCell parent="1" vertex="1" style="fillColor=#aabbcc;"><mxGeometry x="0" y="0" width="100" height="50" as="geometry"/></mxCell></UserObject>
  <mxCell id="b" parent="1" vertex="1" value="Another vertex"><mxGeometry x="0" y="0" width="100" height="50" as="geometry"/></mxCell>
  <mxCell id="e" edge="1" parent="1" source="a" target="b" value="authored edge" style="strokeColor=#112233;"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
const INFINITE_MODEL = MODEL.replace('page="1"', 'page="0"');
const SECOND_PAGE = `<diagram id="two" name="Other page">${INFINITE_MODEL}</diagram>`;
const AUTHORED = `<mxfile host="original"><diagram id="one" name="Authored page">${MODEL}</diagram>${SECOND_PAGE}</mxfile>`;
const NATIVE = `<mxfile host="Electron"><diagram id="renderer"><mxGraphModel page="0" pageWidth="850" pageHeight="1100"><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="b" vertex="1" parent="1"><mxGeometry x="142" y="12" width="100" height="50" as="geometry"/></mxCell>
  <object id="a" label="Renderer label"><mxCell vertex="1" parent="1"><mxGeometry x="12" y="12" width="100" height="50" as="geometry"/></mxCell></object>
  <mxCell id="e" edge="1" parent="1" source="a" target="b" style="strokeColor=#000000;"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="127" y="37"/></Array></mxGeometry></mxCell>
</root></mxGraphModel></diagram></mxfile>`;
const FILE_MERMAID = "flowchart LR\nA[File input] --> B[End]\n";
const INLINE_MERMAID = "flowchart TD\nA[Inline input] --> B[End]\n";

async function fixture(output: string | null = NATIVE, version = "30.2.4", name?: string): Promise<string> {
  return writeRendererFixture(dir, `
    import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    const probe = args[0] === "--version";
    const input = probe ? null : args.at(-1);
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, source: input && readFileSync(input, "utf8") }) + "\\n");
    if (probe) console.log(${JSON.stringify(version)});
    else {
      const output = ${JSON.stringify(output)};
      const path = args[args.indexOf("-o") + 1];
      if (output === "directory") mkdirSync(path);
      else if (output !== null) writeFileSync(path, output);
    }
  `, name);
}

async function renders(): Promise<{ args: string[]; source: string }[]> {
  const log = await readFile(trace, "utf8");
  return log.trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.args[0] !== "--version");
}

async function source(name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe("mermaid / layout arg builders", () => {
  it("mermaidArgs converts to xml format", () => {
    expect(mermaidArgs("d.mmd", "d.drawio")).toEqual(["-x", "-f", "xml", "-o", "d.drawio", "d.mmd"]);
  });

  it("layoutArgs passes the preset through --layout", () => {
    expect(layoutArgs("d.drawio", "verticalTree", "d.layout.drawio")).toEqual([
      "-x", "-f", "xml", "--layout", "verticalTree", "-o", "d.layout.drawio", "d.drawio",
    ]);
  });

  it("exposes exactly the safe ELK presets", () => {
    expect([...LAYOUT_PRESETS]).toEqual([
      "verticalFlow", "horizontalFlow", "verticalTree", "horizontalTree", "radialTree", "organic",
    ]);
  });
});

describe("editable import guards", () => {
  it("rejects an unknown preset before doing any work", async () => {
    await expect(applyLayout({ input: "whatever.drawio", preset: "bogus" as any })).rejects.toThrow(/unknown layout preset/);
  });

  it.each(["neither", "both"])("rejects %s meaningful Mermaid sources before conversion", async (which) => {
    const binary = await fixture();
    const input = which === "both" ? await source("file.mmd", FILE_MERMAID) : "  ";
    const mermaid = which === "both" ? INLINE_MERMAID : "\n ";
    const output = join(dir, "out.drawio");
    await expect(convertMermaid({ input, mermaid, output, binary })).rejects.toThrow(/provide exactly one of `input`.*`mermaid`/);
    await expect(readFile(trace)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a missing file separately with a capable fixture available", async () => {
    const binary = await fixture();
    await expect(convertMermaid({ input: join(dir, "missing-dir", "missing.mmd"), binary })).rejects.toThrow(/input file not found:.*missing\.mmd/);
    await expect(applyLayout({ input: join(dir, "missing.drawio"), preset: "organic", binary })).rejects.toThrow(/input file not found:.*missing\.drawio/);
  });

  it("reports a missing CLI with valid input", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    await expect(convertMermaid({ mermaid: INLINE_MERMAID, output: join(dir, "out.drawio") })).rejects.toThrow(/CLI not found/);
  });

  it("rejects early 30.x for both features without running conversion or layout", async () => {
    const binary = await fixture(NATIVE, "30.0.4");
    const output = join(dir, "out.drawio");
    const input = await source("authored.drawio", AUTHORED);
    const message = /needs draw\.io v30\.2\.4.*30\.0\.4/;
    await expect(convertMermaid({ mermaid: INLINE_MERMAID, output, binary })).rejects.toThrow(message);
    await expect(applyLayout({ input, preset: "organic", output, binary })).rejects.toThrow(message);
    expect(await renders()).toEqual([]);
  });

  it("refuses a Windows CLI on Linux for inline and mounted-file input without starting it", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    const binary = await fixture(NATIVE, "30.2.4", "draw.io.exe");
    const mounted = join(dir, "mnt", "c");
    await mkdir(mounted, { recursive: true });
    const input = await source(join("mnt", "c", "file.mmd"), FILE_MERMAID);
    const output = join(dir, "out.drawio");
    await expect(convertMermaid({ mermaid: INLINE_MERMAID, output, binary })).rejects.toThrow(/WSL.*native Linux/);
    await expect(convertMermaid({ input, output, binary })).rejects.toThrow(/WSL.*native Linux/);
    await expect(readFile(trace)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("passes a dash-prefixed, spaced Mermaid path as one absolute file operand", async () => {
  const binary = await fixture();
  const input = await source("-file chart.mmd", FILE_MERMAID);
  const output = join(dir, "-my diagram.drawio");
  const relativeInput = relative(process.cwd(), input);
  const result = await convertMermaid({ input: relativeInput, mermaid: " ", output, binary });
  expect(result).toMatchObject({ output, binary, version: "30.2.4" });
  const [{ args, source: seen }] = await renders();
  const staged = args[args.indexOf("-o") + 1];
  const operand = process.platform === "win32" ? input : `${process.cwd()}/${relativeInput}`;
  expect(args).toEqual(mermaidArgs(operand, staged));
  expect(isAbsolute(staged)).toBe(true);
  expect(staged).not.toBe(output);
  expect(seen).toBe(FILE_MERMAID);
});

it("converts inline Mermaid using private absolute operands and a fit-ready session default", async () => {
  const binary = await fixture();
  const result = await convertMermaid({ input: " ", mermaid: INLINE_MERMAID, binary, cwd: dir });
  expect(result.output).toBe(join(dir, "diagram.drawio"));
  const [{ args, source: seen }] = await renders();
  const input = args.at(-1)!;
  const staged = args[args.indexOf("-o") + 1];
  expect(isAbsolute(input)).toBe(true);
  expect(isAbsolute(staged)).toBe(true);
  expect(seen).toBe(INLINE_MERMAID);
  await expect(readFile(input)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(result.output, "utf8")).toContain('<mxGraphModel page="1"');
  const fit = await fitCanvasFile({ input: result.output });
  expect(fit.pages[0]).toMatchObject({ status: "fitted", after: { width: 310, height: 130 } });
});

it("lays out first-page geometry by effective ID without rewriting authored graph data or the next page", async () => {
  const binary = await fixture();
  const input = await source("-authored layout.drawio", AUTHORED);
  const output = join(dir, "-laid out.drawio");
  await expect(applyLayout({ input: relative(process.cwd(), input), output, preset: "horizontalFlow", binary }))
    .resolves.toMatchObject({ output, preset: "horizontalFlow", binary, version: "30.2.4" });
  const [{ args, source: sent }] = await renders();
  const scratch = args.at(-1)!;
  const staged = args[args.indexOf("-o") + 1];
  expect(args).toEqual(layoutArgs(scratch, "horizontalFlow", staged));
  expect(isAbsolute(scratch)).toBe(true);
  expect(basename(scratch)).toBe(basename(input));
  expect(isAbsolute(staged)).toBe(true);
  expect(staged).not.toBe(output);
  expect(sent).not.toContain("Other page");
  await expect(readFile(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(input, "utf8")).resolves.toBe(AUTHORED);

  const xml = await readFile(output, "utf8");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const pages = doc.getElementsByTagName("diagram");
  const first = new XMLSerializer().serializeToString(pages.item(0)!);
  const second = new XMLSerializer().serializeToString(pages.item(1)!);
  expect(doc.documentElement?.getAttribute("host")).toBe("original");
  expect(first).toContain('id="one" name="Authored page"');
  expect(first).toContain('<mxGraphModel page="1" pageWidth="640" pageHeight="480" pageScale="0.8" background="#18243A">');
  expect(first).toContain('<mxCell id="0" custom="motion"/>');
  expect(first).toMatch(/<UserObject id="a" label="Authored label" extra="keep"><mxCell parent="1" vertex="1" style="fillColor=#aabbcc;"><mxGeometry x="12" y="12"/);
  expect(first).toMatch(/<mxCell id="b"[^>]*><mxGeometry x="142" y="12"/);
  expect(first).toContain('source="a" target="b" value="authored edge" style="strokeColor=#112233;"');
  expect(first).toContain('<Array as="points"><mxPoint x="127" y="37"/></Array>');
  expect(second).toBe(SECOND_PAGE);
  const fit = await fitCanvasFile({ input: output });
  expect(fit.pages[1]).toMatchObject({ status: "skipped", reason: expect.stringContaining("infinite canvas") });
});

it.skipIf(process.platform === "win32")("writes implicit editable outputs beside the physical inputs across a directory symlink", async () => {
  const binary = await fixture();
  const actual = join(dir, "actual");
  const child = join(actual, "child");
  await mkdir(child, { recursive: true });
  await symlink(child, join(dir, "through"), "dir");
  await writeFile(join(actual, "source.mmd"), FILE_MERMAID);
  await writeFile(join(actual, "authored.drawio"), AUTHORED);
  await source("source.mmd", INLINE_MERMAID);
  await source("authored.drawio", AUTHORED.replace("Authored label", "Decoy label"));
  const outputs = ["source.drawio", "authored.layout.drawio", "diagram.drawio"];
  for (const name of outputs) await source(name, "keep me");

  const viaLink = `${dir}/through/..`;
  await convertMermaid({ input: `${relative(process.cwd(), dir)}/through/../source.mmd`, binary });
  await applyLayout({ input: `${viaLink}/authored.drawio`, preset: "horizontalFlow", binary });
  await convertMermaid({ mermaid: INLINE_MERMAID, cwd: viaLink, binary });

  expect((await renders())[0].source).toBe(FILE_MERMAID);
  expect(await readFile(join(actual, "source.drawio"), "utf8")).toContain('<mxGraphModel page="1"');
  expect(await readFile(join(actual, "authored.layout.drawio"), "utf8")).toContain("Authored label");
  expect(await readFile(join(actual, "diagram.drawio"), "utf8")).toContain('<mxGraphModel page="1"');
  for (const name of outputs) await expect(readFile(join(dir, name), "utf8")).resolves.toBe("keep me");
});

it("preserves compatibility with a compressed first page without touching other pages", async () => {
  const binary = await fixture();
  const packed = deflateRawSync(encodeURIComponent(MODEL)).toString("base64");
  const input = await source("compressed.drawio", `<mxfile compressed="true"><diagram id="one">${packed}</diagram><diagram id="two">${packed}</diagram></mxfile>`);
  const { output } = await applyLayout({ input, preset: "horizontalFlow", binary });
  expect(output).toBe(join(dir, "compressed.layout.drawio"));
  const doc = new DOMParser().parseFromString(await readFile(output, "utf8"), "text/xml");
  const pages = doc.getElementsByTagName("diagram");
  const laidOut = decodeURIComponent(inflateRawSync(Buffer.from(pages.item(0)!.textContent!, "base64")).toString());
  expect(laidOut).toContain('<mxGraphModel page="1"');
  expect(laidOut).toContain('<mxGeometry x="142" y="12"');
  expect(pages.item(1)!.textContent).toBe(packed);
});

it.each([
  ["missing", null],
  ["directory", "directory"],
  ["not a graph", "<not-a-diagram/>"],
  ["malformed XML", NATIVE.replace('id="renderer"', "id=renderer")],
])("leaves prior editable bytes alone when conversion output is invalid (%s)", async (_kind, native) => {
  const binary = await fixture(native);
  const output = await source("previous.drawio", AUTHORED);
  await expect(convertMermaid({ mermaid: INLINE_MERMAID, output, binary })).rejects.toThrow(/conversion .*output/);
  await expect(readFile(output, "utf8")).resolves.toBe(AUTHORED);
  const [{ args }] = await renders();
  await expect(readFile(dirname(args.at(-1)!))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects layout output computed for different terminals without changing the in-place input", async () => {
  const binary = await fixture(NATIVE.replace('target="b"', 'target="a"'));
  const input = await source("in-place.drawio", MODEL);
  await expect(applyLayout({ input, output: input, preset: "horizontalFlow", binary }))
    .rejects.toThrow(/layout output does not match the input graph/);
  await expect(readFile(input, "utf8")).resolves.toBe(MODEL);
  const [{ args }] = await renders();
  await expect(readFile(dirname(args.at(-1)!))).rejects.toMatchObject({ code: "ENOENT" });
});

it("serializes editable conversion to an explicit hard-link destination without breaking the link", async () => {
  const binary = await fixture();
  const sourceFile = await source("original.drawio", AUTHORED);
  const alias = join(dir, "alias.drawio");
  await link(sourceFile, alias);
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const owner = withDiagramFiles([sourceFile], undefined, async () => {
    entered();
    await held;
    await writeFile(sourceFile, "owner edit");
  });
  await ready;
  const conversion = convertMermaid({ mermaid: INLINE_MERMAID, output: alias, binary });
  const settled = Promise.allSettled([owner, conversion]);
  try {
    // An unrelated conversion can proceed while the hard-linked name is leased.
    const independent = join(dir, "independent.drawio");
    await convertMermaid({ mermaid: FILE_MERMAID, output: independent, binary });
    expect((await renders()).map(run => run.source)).toEqual([FILE_MERMAID]);
    await expect(readFile(alias, "utf8")).resolves.toBe(AUTHORED);
  } finally {
    release();
    await settled;
  }
  await expect(conversion).resolves.toMatchObject({ output: alias });
  const published = await readFile(alias, "utf8");
  expect(published).toContain('<mxGraphModel page="1"');
  await expect(readFile(sourceFile, "utf8")).resolves.toBe(published);
});
