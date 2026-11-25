import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exportDiagram } from "../src/drawio";
import { installNodeRendererFixture, TINY_PNG } from "./fixtures";

const FIRST = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="first" value="First page" vertex="1" parent="1"><mxGeometry width="120" height="60" as="geometry"/></mxCell>
</root></mxGraphModel>`;
const SECOND = FIRST.replace("First page", "Second page");
const wrap = (model: string) => `<diagram>${model}</diagram>`;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50">';
const PNG = Buffer.from(TINY_PNG, "base64");
let dir: string;
let input: string;
let binary: string;
let log: string;
let restoreRenderer: () => void;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawme staged export "));
  input = join(dir, "-two pages.drawio");
  binary = join(dir, "fixture renderer.mjs");
  log = join(dir, "invocations");
  vi.stubEnv("DISPLAY", ":99");
  restoreRenderer = installNodeRendererFixture([binary]);
  await writeFile(input, `<mxfile>${wrap(FIRST)}${wrap(SECOND)}</mxfile>`);
});

afterEach(async () => {
  restoreRenderer();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function fixture(render: string, version = "32.4.1") {
  await writeFile(binary, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) console.log(${JSON.stringify(version)});
else {
  const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const output = option("-o");
  const input = args[args.indexOf("-o") + 2];
  ${render}
}
`);
}

async function invocations(): Promise<string[][]> {
  if (!existsSync(log)) return [];
  return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
}

const renderSvg = `writeFileSync(output, ${JSON.stringify(SVG + "</svg>")});`;
const renderPng = `writeFileSync(output, Buffer.from(${JSON.stringify(TINY_PNG)}, "base64"));`;

it.each([0, 1.9, 3])("refuses page %s before even probing and preserves the prior artifact", async (pageIndex) => {
  await fixture(renderPng);
  const output = join(dir, "prior.png");
  await writeFile(output, PNG);
  await expect(exportDiagram({ input, output, pageIndex, binary })).rejects.toThrow(/pageIndex/i);
  expect(await invocations()).toEqual([]);
  expect(await readFile(output)).toEqual(PNG);
});

it("counts no pages in an empty mxfile, even with a nested non-page diagram", async () => {
  await fixture(renderPng);
  await writeFile(input, `<mxfile><metadata>${wrap(FIRST)}</metadata></mxfile>`);
  await expect(exportDiagram({ input, pageIndex: 1, binary })).rejects.toThrow(/pageIndex/i);
  expect(await invocations()).toEqual([]);
});

it("selects the two different page contents with one-based argv and absolute file operands", async () => {
  await fixture(`const pages = [...readFileSync(input, "utf8").matchAll(/value="([^"]+)"/g)];
    const page = pages[Number(option("--page-index")) - 1][1];
    writeFileSync(output, ${JSON.stringify(SVG)} + '<text>' + page + '</text></svg>');`, "27.0.2");
  for (const [pageIndex, label] of [[1, "First page"], [2, "Second page"]] as const) {
    const output = join(dir, `page ${pageIndex}.svg`);
    const result = await exportDiagram({ input: relative(process.cwd(), input), output, format: "svg", pageIndex, binary });
    expect(result.output).toBe(output);
    expect(await readFile(output, "utf8")).toContain(`<text>${label}</text>`);
    expect((await stat(output)).isFile()).toBe(true);
    const render = (await invocations()).at(-1)!;
    const outputIndex = render.indexOf("-o") + 1;
    expect(isAbsolute(render[outputIndex])).toBe(true);
    expect(isAbsolute(render[outputIndex + 1])).toBe(true);
  }
});

it.each([FIRST, wrap(FIRST), `<mxfile><diagram>opaque-page</diagram></mxfile>`])(
  "accepts an explicit page 1 for supported single-page shape %#", async (xml) => {
    // Stock 32.4.1 does not read a standalone <diagram> without the mxfile envelope.
    await fixture(`if (readFileSync(input, "utf8").startsWith("<diagram>")) process.exit(1); ${renderSvg}`);
    await writeFile(input, xml);
    await expect(exportDiagram({ input, format: "svg", pageIndex: 1, binary })).resolves.toMatchObject({ format: "svg" });
    expect(await readFile(input, "utf8")).toBe(xml);
  },
);

it("rejects explicit selection on an older CLI but still permits unindexed exports", async () => {
  await fixture(renderSvg, "26.2.15");
  const output = join(dir, "output.svg");
  await expect(exportDiagram({ input, output, format: "svg", pageIndex: 1, binary })).rejects.toThrow("27.0.2");
  expect(await invocations()).toEqual([["--version"]]);
  expect(existsSync(output)).toBe(false);
  await expect(exportDiagram({ input, output, format: "svg", binary })).resolves.toMatchObject({ output });
  expect((await invocations()).at(-1)).not.toContain("--page-index");
});

it.each([
  { format: "png", embed: false, error: /suffix/i },
  { format: "jpg", embed: true, error: /JPG.*embed/i },
] as const)("rejects conflicting $format output with embed=$embed before probing", async ({ format, embed, error }) => {
  await fixture(renderPng);
  const output = join(dir, "picture.JPEG");
  await expect(exportDiagram({ input, output, format, embed, binary })).rejects.toThrow(error);
  expect(await invocations()).toEqual([]);
  expect(existsSync(output)).toBe(false);
});

it("rejects a directory destination before probing, even with a matching suffix", async () => {
  await fixture(renderPng);
  const output = join(dir, "exports.pdf");
  await mkdir(output);
  await expect(exportDiagram({ input, output, format: "pdf", binary })).rejects.toThrow(/regular file/i);
  expect(await invocations()).toEqual([]);
  expect(await readdir(output)).toEqual([]);
});

it("rejects over-budget/non-file XML input instead of handing it to the CLI", async () => {
  await fixture(renderPng);
  await writeFile(input, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  await expect(exportDiagram({ input, binary })).rejects.toThrow("byte limit");
  const directory = join(dir, "directory.drawio");
  await mkdir(directory);
  await expect(exportDiagram({ input: directory, binary })).rejects.toThrow(/regular file/i);
  expect(await invocations()).toEqual([]);
});

it.each([false, true])("rejects a bad IHDR CRC before publication (tail cut: %s)", async (truncate) => {
  await fixture(`const bytes = Buffer.from(${JSON.stringify(TINY_PNG)}, "base64");
    bytes[29] ^= 1;
    writeFileSync(output, ${truncate ? "bytes.subarray(0, -8)" : "bytes"});`);
  const prior = join(dir, "prior.png");
  await writeFile(prior, PNG);
  await expect(exportDiagram({ input, output: prior, binary })).rejects.toThrow("not a complete PNG");
  expect(await readFile(prior)).toEqual(PNG);
  const absent = join(dir, "absent.png");
  await expect(exportDiagram({ input, output: absent, binary })).rejects.toThrow("not a complete PNG");
  expect(existsSync(absent)).toBe(false);
});

it("refuses a CRC-valid image whose pixel stream does not cover its dimensions", async () => {
  await fixture(`const bytes = Buffer.from(${JSON.stringify(TINY_PNG)}, "base64");
    bytes.writeUInt32BE(2, 16);
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
    writeFileSync(output, bytes.subarray(0, -8));`);
  const output = join(dir, "short-data.png");
  await expect(exportDiagram({ input, output, binary })).rejects.toThrow("not a complete PNG");
  expect(existsSync(output)).toBe(false);
});

const renderSizedPng = `function chunk(type, data) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
const xml = readFileSync(input, "utf8");
const [w, h] = /width="(\\d+)" height="(\\d+)"/.exec(xml).slice(1).map(Number);
const border = Number(option("-b"));
const pixels = 2 * border;
const scale = option("--width") ? (Number(option("--width")) - pixels) / w
  : option("--height") ? (Number(option("--height")) - pixels) / h : Number(option("-s"));
const width = Math.ceil(w * scale + pixels), height = Math.ceil(h * scale + pixels);
const png = Buffer.from(${JSON.stringify(TINY_PNG)}, "base64");
const header = png.subarray(16, 29);
header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
const chunks = [png.subarray(0, 8), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(height * (1 + width * 2))))];
if (args.includes("-e")) chunks.push(chunk("tEXt", Buffer.from("mxGraphModel\\0fixture")));
writeFileSync(output, Buffer.concat([...chunks, png.subarray(-12)]));`;

it.each([[120, 480], [480, 120]])("produces an unembedded, bounded %dx%d aspect preview", async (width, height) => {
  await fixture(renderSizedPng);
  await writeFile(input, FIRST.replace('width="120" height="60"', `width="${width}" height="${height}"`));
  const preview = await exportDiagram({ input, mode: "preview", embed: true, binary });
  const bytes = await readFile(preview.output);
  const actualWidth = bytes.readUInt32BE(16), actualHeight = bytes.readUInt32BE(20);
  expect(Math.max(actualWidth, actualHeight)).toBeLessThanOrEqual(2000);
  expect(Math.max(actualWidth, actualHeight)).toBeGreaterThan(1900);
  expect((actualWidth - 80) / (actualHeight - 80)).toBeCloseTo(width / height, 2);
  expect(preview.embed).toBe(false);
  expect(bytes.includes(Buffer.from("mxGraphModel"))).toBe(false);
});

it("does not publish a PNG preview when the renderer unexpectedly embeds editable XML", async () => {
  await fixture(renderSizedPng.replace('if (args.includes("-e"))', ""));
  const output = join(dir, "preview.png");
  await expect(exportDiagram({ input, output, mode: "preview", binary })).rejects.toThrow(/preview.*editable/i);
  expect(existsSync(output)).toBe(false);
});

it("clamps explicit dimensions as well as scale to the bordered pixel and preview budgets", async () => {
  await fixture(renderSizedPng);
  await writeFile(input, FIRST.replace('width="120" height="60"', 'width="2000" height="1900"'));
  for (const mode of ["final", "preview"] as const) {
    const result = await exportDiagram({ input, mode, width: 5000, binary });
    const bytes = await readFile(result.output);
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    expect(width * height).toBeLessThanOrEqual(6_000_000);
    expect(width * height).toBeGreaterThan(5_000_000);
    if (mode === "preview") expect(Math.max(width, height)).toBeLessThanOrEqual(2576);
  }
});

it.each(["png", "jpg"] as const)("rejects an oversized staged %s even when argv requested a safe size", async (format) => {
  // Both headers claim 3000 x 3000. The PNG has a valid CRC; the JPEG carries a baseline SOF.
  await fixture(format === "png"
    ? `const bytes = Buffer.from(${JSON.stringify(TINY_PNG)}, "base64");
       bytes.writeUInt32BE(3000, 16); bytes.writeUInt32BE(3000, 20);
       bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29); writeFileSync(output, bytes);`
    : `writeFileSync(output, Buffer.from('ffd8ffc0000b080bb80bb801011100ffda0008010100003f0000ffd9', 'hex'));`);
  const output = join(dir, `oversized.${format}`);
  await expect(exportDiagram({ input, output, format, mode: "preview", binary })).rejects.toThrow(/raster.*(limit|budget)/i);
  expect(existsSync(output)).toBe(false);
});

it("aborting a waiter does not release the queue head or publish/retire its artifacts", async () => {
  await fixture(renderSvg);
  const preview = await exportDiagram({ input, mode: "preview", format: "svg", binary });
  const prior = await readFile(preview.output);
  const headOutput = join(dir, "head.svg");
  const canceledOutput = join(dir, "canceled.svg");
  const nextOutput = join(dir, "next.svg");
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const head = exportDiagram({ input, output: headOutput, format: "svg", mode: "preview", binary }, async () => {
    enter();
    await gate;
  });
  const controller = new AbortController();
  let failure: unknown;
  let canceled: Promise<unknown> | undefined;
  let next: ReturnType<typeof exportDiagram> | undefined;
  try {
    await Promise.race([entered, head]);
    canceled = exportDiagram({ input, output: canceledOutput, format: "svg", binary, signal: controller.signal }).catch((e: unknown) => { failure = e; });
    next = exportDiagram({ input, output: nextOutput, format: "svg", binary });
    controller.abort();
    await vi.waitFor(() => expect(failure).toMatchObject({ name: "AbortError" }));
    expect(await readFile(preview.output)).toEqual(prior);
    expect(existsSync(canceledOutput)).toBe(false);
    expect(existsSync(nextOutput)).toBe(false);
    expect(await invocations()).toHaveLength(4); // no probe or render passed the head
  } finally {
    release();
    await Promise.allSettled([head, canceled, next]);
  }
  expect((await next)?.removedPreviews).toEqual([headOutput]);
  expect(existsSync(canceledOutput)).toBe(false);
});

it("aborts and reaps a running renderer, preserving the prior output and preview", async () => {
  await fixture(renderSvg);
  const preview = await exportDiagram({ input, mode: "preview", format: "svg", binary });
  const priorPreview = await readFile(preview.output);
  const output = join(dir, "final.svg");
  const prior = "old final bytes";
  await writeFile(output, prior);
  const pidFile = join(dir, "pid");
  const releaseFile = join(dir, "release");
  await fixture(`${renderSvg}
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const hold = setInterval(() => { if (existsSync(${JSON.stringify(releaseFile)})) clearInterval(hold); }, 20);`);
  const controller = new AbortController();
  let failure: unknown;
  const pending = exportDiagram({ input, output, format: "svg", binary, signal: controller.signal }).catch((e: unknown) => { failure = e; });
  try {
    const pid = await vi.waitFor(async () => Number(await readFile(pidFile, "utf8")));
    controller.abort();
    await vi.waitFor(() => expect(failure).toMatchObject({ name: "AbortError" }));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readFile(output, "utf8")).toBe(prior);
    expect(await readFile(preview.output)).toEqual(priorPreview);
    expect((await readdir(dir)).some((entry) => entry.startsWith(".drawme-export-"))).toBe(false);
  } finally {
    await writeFile(releaseFile, "release");
    await pending;
  }
  await fixture(renderSvg);
  const final = await exportDiagram({ input, output, format: "svg", binary });
  expect(final.removedPreviews).toEqual([preview.output]);
});

it("lets abort win during the staged SVG finalizer", async () => {
  await fixture(renderSvg);
  const controller = new AbortController();
  const output = join(dir, "final.svg");
  await writeFile(output, "old SVG");
  await expect(exportDiagram({ input, output, format: "svg", binary, signal: controller.signal }, async (_path, signal) => {
    expect(signal).toBe(controller.signal);
    controller.abort();
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(await readFile(output, "utf8")).toBe("old SVG");
});

it("reports safe status without forwarding child diagnostics", async () => {
  await fixture(`process.stderr.write("private fixture marker".repeat(10000)); process.exitCode = 7;`);
  const failure: unknown = await exportDiagram({ input, binary }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ message: expect.stringContaining("code 7") });
  expect((failure as Error).message).not.toContain("private fixture marker");
});
