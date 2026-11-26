import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { crc32 } from "node:zlib";
import { buildSessionProjection, type SessionEntry, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import * as animation from "../src/animate";
import * as drawio from "../src/drawio";
import * as fitCanvas from "../src/fitcanvas";
import drawme from "../src/index";
import { inspectPng } from "../src/png";
import * as validation from "../src/validate";
import { makeMockPi, type ResultContent, TINY_PNG } from "./fixtures";
import { installRendererFixtureAdapter, writeRendererFixture } from "./renderer-fixture";

installRendererFixtureAdapter();

const paths: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "drawme session "));
  paths.push(dir);
  return dir;
}

function registered() {
  const mock = makeMockPi();
  drawme(mock.pi as never);
  return mock;
}

const png = Buffer.from(TINY_PNG, "base64");
const digest = createHash("sha256").update(png).digest("hex");
const text = (result: { content: ResultContent[] }) => result.content[0].type === "text" ? result.content[0].text : "";
const document = (name: string) => `<mxfile><diagram name="${name}"><mxGraphModel page="1" pageWidth="400" pageHeight="300"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="${name}" vertex="1" parent="1"><mxGeometry x="80" y="90" width="100" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
const artifact = (output: string): drawio.ExportResult => ({
  output, mode: "preview", format: "png", embed: false, animated: false,
  binary: "fixture", version: "32.4.1", repaired: false, replacedPreview: true,
  removedPreviews: [], previewCleanupWarnings: [], command: "fixture", previewSha256: digest,
});

function editablePng(): Buffer {
  const contents = Buffer.from(`mxfile\0${document("Editable")}`);
  const data = Buffer.alloc(contents.length + 12);
  data.writeUInt32BE(contents.length);
  data.write("tEXt", 4);
  contents.copy(data, 8);
  data.writeUInt32BE(crc32(data.subarray(4, -4)), data.length - 4);
  return Buffer.concat([png.subarray(0, -12), data, png.subarray(-12)]);
}

it("reads, fits and explains the session copy when process and session directories have the same filename", async () => {
  const dir = await workspace();
  const cwd = join(dir, "session");
  const host = join(dir, "host");
  await Promise.all([mkdir(cwd), mkdir(host)]);
  const name = "same.drawio";
  await writeFile(join(host, name), "not an XML diagram");
  await writeFile(join(cwd, name), document("Session"));
  const { tools } = registered();
  const previous = process.cwd();
  try {
    process.chdir(host);
    const ctx = { cwd };
    const lint = tools.get("drawio_validate")!;
    expect(text(await lint.execute("v", { input: name }, undefined, undefined, ctx))).toContain("Errors (0):");
    expect(text(await lint.execute("v", { input: join(host, name) }, undefined, undefined, ctx))).not.toContain("Errors (0):");
    const explanation = await tools.get("drawio_explain")!.execute("e", { input: name }, undefined, undefined, ctx);
    expect(text(explanation)).toContain("Session");
    const fit = await tools.get("drawio_fit_canvas")!.execute("f", { input: name, margin: 25 }, undefined, undefined, ctx);
    expect(fit.details).toMatchObject({ output: join(cwd, name), changed: true });
    expect(await readFile(join(cwd, name), "utf8")).toContain('x="25" y="25"');
    expect(await readFile(join(host, name), "utf8")).toBe("not an XML diagram");
  } finally {
    process.chdir(previous);
  }
});

it("anchors current-drive rooted Windows fit operands to the session drive or share without changing qualified paths", async () => {
  const fit = vi.spyOn(fitCanvas, "fitCanvasFile").mockResolvedValue({
    input: "fixture", output: "fixture", margin: 40, changed: false, pages: [],
  });
  const tool = registered().tools.get("drawio_fit_canvas")!;
  // Simulate Win32 path rules with separate process and session drives, even on POSIX.
  vi.stubGlobal("process", Object.create(process, {
    platform: { value: "win32" }, cwd: { value: () => String.raw`C:\host` },
  }));
  try {
    const cwd = String.raw`D:\sessions\drawing`;
    await tool.execute("fit", { input: "/input.drawio", output: String.raw`\out.drawio` }, undefined, undefined, { cwd });
    expect(fit).toHaveBeenLastCalledWith({ input: String.raw`D:\input.drawio`, output: String.raw`D:\out.drawio`, margin: undefined });

    const input = "C:/host/./input.drawio";
    const output = String.raw`\\files\share\explicit.drawio`;
    await tool.execute("fit", { input, output }, undefined, undefined, { cwd });
    expect(fit).toHaveBeenLastCalledWith({ input, output, margin: undefined });

    const share = String.raw`\\files\share\sessions`;
    await tool.execute("fit", { input: String.raw`\input.drawio`, output: "/directory/" }, undefined, undefined, { cwd: share });
    expect(fit).toHaveBeenLastCalledWith({ input: String.raw`\\files\share\input.drawio`, output: "\\\\files\\share\\directory\\", margin: undefined });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("anchors native tool operands and forwards only declared fields and the trusted session defaults", async () => {
  const cwd = await workspace();
  const { tools } = registered();
  const ctx = { cwd };
  const signal = new AbortController().signal;
  const input = join(cwd, "-input file.drawio");
  const output = join(cwd, "out.svg");
  const exp = vi.spyOn(drawio, "exportDiagram").mockResolvedValue({ ...artifact(output), format: "svg", mode: "final" });
  const animate = vi.spyOn(animation, "animateDiagram").mockResolvedValue({
    source: input, saved: true, page: "A", output, steps: 1, loop: false, sequenceMs: 1, durationMs: 1,
    animatedCells: 1, drawnConnectors: 0, travellingDots: 0, connectorFlows: 0, binary: "fixture",
  });
  const convert = vi.spyOn(drawio, "convertMermaid").mockResolvedValue({ output, binary: "fixture", command: "fixture" });
  const layout = vi.spyOn(drawio, "applyLayout").mockResolvedValue({ output, preset: "organic", binary: "fixture", command: "fixture" });
  const open = vi.spyOn(drawio, "openFile").mockResolvedValue({ opener: "fixture" });
  const hidden = { binary: "not-trusted", signal: {}, cwd: "elsewhere", height: 5, reviewRaster: true };
  const execute = (name: string, params: object) => tools.get(name)!.execute("id", { ...params, ...hidden }, signal, undefined, ctx);
  await execute("drawio_export", { input: "-input file.drawio", output: "out.svg/", width: 500 });
  expect(exp.mock.calls[0][0]).toMatchObject({ input, output: output + sep, width: 500, signal });
  await execute("drawio_animate", { input, output: "out.svg", storyboard: false });
  expect(animate.mock.calls[0][0]).toMatchObject({ input, output, signal, storyboard: false });
  await execute("drawio_from_mermaid", { mermaid: "flowchart LR; A-->B" });
  expect(convert.mock.calls[0][0]).toMatchObject({ mermaid: "flowchart LR; A-->B", cwd, input: undefined, output: undefined });
  await execute("drawio_from_mermaid", { input: "-source.mmd", output: "imported.drawio" });
  expect(convert.mock.calls[1][0]).toMatchObject({ input: join(cwd, "-source.mmd"), output: join(cwd, "imported.drawio") });
  await execute("drawio_layout", { input: "-input file.drawio", output, preset: "organic" });
  expect(layout.mock.calls[0][0]).toEqual({ input, output, preset: "organic" });
  await execute("drawio_open", { path: "out.svg" });
  expect(open).toHaveBeenCalledWith(output);
  for (const opts of [exp.mock.calls[0][0], animate.mock.calls[0][0], convert.mock.calls[0][0]]) {
    expect(opts).not.toHaveProperty("binary");
    expect(opts).not.toHaveProperty("height");
    expect(opts).not.toHaveProperty("reviewRaster");
  }
});

it("publishes explicit and implicit outputs inside the session, including inline Mermaid", async () => {
  const cwd = await workspace();
  const source = join(cwd, "source.drawio");
  const xml = document("Session graph");
  await writeFile(source, xml);
  const binary = await writeRendererFixture(cwd, `
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('32.4.1'); process.exit(0); }
const out = args.indexOf('-o');
const input = args[out + 2];
const format = args[args.indexOf('-f') + 1];
if (format === 'xml') {
  if (!readFileSync(input, 'utf8').includes('flowchart')) process.exit(2);
  writeFileSync(args[out + 1], ${JSON.stringify(xml)});
} else {
  if (input !== ${JSON.stringify(source)}) process.exit(3);
  writeFileSync(args[out + 1], Buffer.from('${TINY_PNG}', 'base64'));
}
`);
  vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
  const { tools } = registered();
  const run = (tool: string, params: object) => tools.get(tool)!.execute("id", params, undefined, undefined, { cwd });
  const implicit = await run("drawio_export", { input: "source.drawio", mode: "preview" });
  expect(implicit.details).toMatchObject({ output: join(cwd, "source.preview.png"), binary });
  const final = await run("drawio_export", { input: source, output: "explicit.png", embed: false });
  expect(final.details).toMatchObject({ output: join(cwd, "explicit.png"), binary, removedPreviews: [join(cwd, "source.preview.png")] });
  expect(await readFile(join(cwd, "explicit.png"))).toEqual(png);
  const converted = await run("drawio_from_mermaid", { mermaid: "flowchart LR; A-->B" });
  expect(converted.details).toMatchObject({ output: join(cwd, "diagram.drawio"), binary });
  expect(await readFile(join(cwd, "diagram.drawio"), "utf8")).toContain("Session graph");
});

async function previewFixture() {
  const cwd = await workspace();
  const input = join(cwd, "source.drawio");
  const output = join(cwd, "review.png");
  await writeFile(input, document("Review"));
  await writeFile(output, png);
  vi.spyOn(drawio, "exportDiagram").mockResolvedValue(artifact(output));
  const { tools } = registered();
  const preview = (model?: { input: string[] }, sessionManager?: { buildSessionProjection: () => unknown }, pageIndex?: number) =>
    tools.get("drawio_export")!.execute("preview", { input: "source.drawio", mode: "preview", pageIndex }, undefined, undefined, { cwd, model, sessionManager });
  return { input, output, preview };
}

const vision = { input: ["text", "image"] };

function storedResult(result: { content: ResultContent[]; details: unknown }): SessionMessageEntry {
  return { type: "message", id: "previous", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: {
    role: "toolResult", toolName: "drawio_export", toolCallId: "old call", content: result.content,
    isError: false, timestamp: 1, details: result.details as never,
  } };
}

const projected = (...entries: SessionEntry[]) => ({ buildSessionProjection: () => buildSessionProjection(entries) });

it("only attaches to explicit vision models and receipts name the canonical source and exact attached bytes", async () => {
  const { input, preview } = await previewFixture();
  const textOnly = await preview({ input: ["text"] });
  expect(text(textOnly)).toContain("Preview image NOT attached");
  expect(textOnly).toMatchObject({ content: [{ type: "text" }], details: { imageAttached: false } });
  expect(textOnly.details).not.toHaveProperty("previewReceipt");

  const first = await preview(vision, projected(storedResult(textOnly)));
  expect(text(first)).toContain("Critique it against the current review pass");
  expect(first.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
  expect(first.details).toMatchObject({ imageAttached: true, previewReceipt: { source: await realpath(input), pageIndex: 1, sha256: digest } });

  const unknown = await preview(undefined, projected(storedResult(first)));
  expect(unknown.content).toHaveLength(1);
  expect(unknown.details).toMatchObject({ imageAttached: false });
  expect(unknown.details).not.toHaveProperty("previewReceipt");
});

it("compares only when the paired projection still contains the image Pi stored for that call and page", async () => {
  const { preview } = await previewFixture();
  const first = await preview(vision);
  const entry = storedResult(first);
  // Projection sees this Pi-stored JPEG representation, not the exported PNG.
  const storedJpeg = { type: "image" as const, mimeType: "image/jpeg", data: Buffer.from("Pi resized diagram A").toString("base64") };
  const otherJpeg = { ...storedJpeg, data: Buffer.from("different diagram B").toString("base64") };
  if (entry.message.role !== "toolResult") throw new Error("expected a stored tool result");
  entry.message.content = [storedJpeg];
  const replace = (replacement: Extract<SessionEntry, { type: "context_edit" }>["replacement"]) => projected(entry, {
    type: "context_edit", id: "edit", parentId: entry.id, targetId: entry.id, timestamp: entry.timestamp, replacement,
  });
  const sameJpeg = await preview(vision, replace({ content: [{ ...storedJpeg }] }));
  expect(text(sameJpeg)).toContain("fixed, not fixed, or regressed");
  const compacted = projected(entry, { type: "message", id: "newer", parentId: entry.id, timestamp: entry.timestamp,
    message: { role: "user", content: "Next review", timestamp: 3 } }, {
    type: "compaction", id: "summary", parentId: "newer", timestamp: entry.timestamp,
    firstKeptEntryId: "newer", summary: "Prior review completed", tokensBefore: 100,
  });
  for (const history of [replace({ content: [otherJpeg] }), compacted, replace(null), replace({ content: "text only" }),
    { buildSessionProjection: () => { throw new Error("projection unavailable"); } }]) {
    expect(text(await preview(vision, history))).toContain("Critique it against the current review pass");
  }
  expect(text(await preview(vision, projected(entry), 2))).toContain("Critique it against the current review pass");
});

it("resolves a text-only export failure when the output is unreadable or substituted with an editable PNG", async () => {
  const { output, preview } = await previewFixture();
  const replacement = editablePng();
  expect(inspectPng(replacement, true).hasEditableDiagram).toBe(true);
  await writeFile(output, replacement);
  const mismatch = await preview(vision);
  expect(text(mismatch)).toMatch(/^Export failed: .*changed/);
  expect(mismatch.content).toHaveLength(1);
  expect(mismatch.details).not.toHaveProperty("previewReceipt");
  await rm(output);
  await mkdir(output);
  const directory = await preview(vision);
  expect(text(directory)).toMatch(/^Export failed: .*regular file/);
  expect(directory.content).toHaveLength(1);
  expect(directory.details).not.toHaveProperty("previewReceipt");
});

it("attaches only the committed storyboard bytes without creating a preview receipt or removing a changed board", async () => {
  const cwd = await workspace();
  const input = join(cwd, "source.drawio");
  const storyboard = join(cwd, "storyboard.png");
  const output = join(cwd, "source.animated.svg");
  const result: animation.AnimateResult = {
    source: input, output, storyboard, storyboardSha256: digest, storyboardFrames: 1, storyboardFramesTotal: 1,
    page: "A", steps: 1, loop: false, sequenceMs: 200, durationMs: 200, saved: true,
    animatedCells: 1, drawnConnectors: 0, travellingDots: 0, connectorFlows: 0, binary: "fixture",
  };
  const render = vi.spyOn(animation, "animateDiagram").mockResolvedValue(result);
  await writeFile(storyboard, png);
  const { tools } = registered();
  const run = () => tools.get("drawio_animate")!.execute("board", { input: "source.drawio" }, undefined, undefined, { cwd, model: vision });
  const okay = await run();
  expect(text(okay)).toContain("Storyboard attached below");
  expect(okay.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
  expect(okay.details).toMatchObject({ imageAttached: true });
  expect(okay.details).not.toHaveProperty("previewReceipt");

  const assertUnverified = async () => {
    const failed = await run();
    expect(text(failed)).toContain(`Animated ${output}`);
    expect(text(failed)).toContain("Storyboard NOT attached: the exported image could not be verified");
    expect(failed.content).toHaveLength(1);
    expect(failed.details).toMatchObject({ storyboard, imageAttached: false });
    expect(failed.details).not.toHaveProperty("previewReceipt");
  };
  const replacement = editablePng();
  await writeFile(storyboard, replacement);
  await assertUnverified();
  expect(await readFile(storyboard)).toEqual(replacement);
  await rm(storyboard);
  await assertUnverified();
  await writeFile(storyboard, png);
  render.mockResolvedValue({ ...result, storyboardSha256: undefined });
  await assertUnverified();
});

it("exposes only public width, positive integer pages and a nonnegative search limit, with text failures for invalid runtime values", async () => {
  const dir = await workspace();
  await writeFile(join(dir, "page.drawio"), document("One"));
  const { tools } = registered();
  expect(tools.get("drawio_export")!.parameters.properties).toHaveProperty("width");
  expect(tools.get("drawio_export")!.parameters.properties).not.toHaveProperty("height");
  const run = (tool: string, params: object) => tools.get(tool)!.execute("id", params, undefined, undefined, { cwd: dir });
  for (const [tool, prefix] of [["drawio_export", "Export failed:"], ["drawio_animate", "Animate failed:"]]) {
    expect(tools.get(tool)!.parameters.properties).toHaveProperty("pageIndex", expect.objectContaining({ type: "integer", minimum: 1 }));
    expect(text(await run(tool, { input: "page.drawio", pageIndex: 1.5 }))).toMatch(new RegExp(`^${prefix}.*positive`));
  }
  expect(tools.get("drawio_shapesearch")!.parameters.properties).toHaveProperty("limit", expect.objectContaining({ type: "integer", minimum: 0 }));
  expect(text(await run("drawio_shapesearch", { query: "ec2", limit: -1 }))).toMatch(/^Shape search failed:/);
  expect((await run("drawio_shapesearch", { query: "ec2", limit: 0 })).details).toEqual({ matches: [] });
});

it("marks incomplete validation explicitly blocking rather than relying only on its finding count", async () => {
  vi.spyOn(validation, "validateFile").mockResolvedValue({
    errors: ["validation work limit (20) exceeded"], warnings: [], observations: [], incomplete: true,
    score: { total: 0, through: 0, crossings: 0, overlaps: 0, anchors: 0 },
  });
  const result = await registered().tools.get("drawio_validate")!.execute("id", { input: "test.drawio" });
  expect(text(result)).toContain("Validation incomplete: treat this as blocking");
  expect(result.details).toMatchObject({ incomplete: true });
});

it("queues one complete workflow as a follow-up while busy and submits one while idle; blank sends none", async () => {
  const { pi, commands } = makeMockPi();
  vi.spyOn(drawio, "resolveBinary").mockResolvedValue({ available: false });
  const send = vi.fn();
  let busy = true;
  drawme({ ...pi, sendUserMessage: (content: string, options?: { deliverAs: string }) => {
    if (busy && options?.deliverAs !== "followUp") throw new Error("delivery is required while streaming");
    send(content, options);
  } } as never);
  const ctx = { ui: { notify: vi.fn() } };
  const command = commands.get("drawme")!;
  await command.handler("Draw a busy workflow", ctx);
  busy = false;
  await command.handler("Draw an idle workflow", ctx);
  await command.handler(" \t ", ctx);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenNthCalledWith(1, expect.stringContaining("Draw a busy workflow"), { deliverAs: "followUp" });
  expect(send).toHaveBeenNthCalledWith(2, expect.stringContaining("Draw an idle workflow"), { deliverAs: "followUp" });
  const prompt = send.mock.calls[0][0];
  for (const prefix of ["Export", "Animate", "Layout", "Mermaid conversion", "Fit canvas", "Explain", "Open", "Shape search"]) {
    expect(prompt).toContain(`${prefix} failed:`);
  }
  expect(prompt).toContain("Tracking is process-local and lost after restart");
  expect(prompt).toContain("An unchecked auto-route is a warning, not a detected crossing");
  expect(prompt).toContain("12 visual batches");
  expect(prompt).not.toContain("only the latest review image remains");
});

it("reports Mermaid and layout capabilities independently with safe unavailable/version fallbacks", async () => {
  const find = vi.spyOn(drawio, "resolveBinary");
  const { commands } = registered();
  const notify = vi.fn();
  const ctx = { ui: { notify } };
  const check = commands.get("drawme-check")!;
  find.mockResolvedValueOnce({ available: true, binary: "fixture", version: "30.2.4", supportsMermaid: true, supportsLayout: true });
  await check.handler("", ctx);
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/30\.2\.4 — fixture\nMermaid import: supported; ELK layout \(--layout\): supported/), "info");
  find.mockResolvedValueOnce({ available: true, binary: "fixture", version: "30.0.4", supportsMermaid: false, supportsLayout: true });
  await check.handler("", ctx);
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/Mermaid import: unsupported; ELK layout \(--layout\): supported/), "info");
  find.mockResolvedValueOnce({ available: false, reason: "Run as an unprivileged user.", supportsMermaid: true, supportsLayout: true });
  await check.handler("", ctx);
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/unprivileged user\.\nMermaid import: unsupported; ELK layout \(--layout\): unsupported/), "error");
});

it("distinguishes stored DrawMe motion in one-shot help and errors, and retains the native verified route", async () => {
  const cwd = await workspace();
  await copyFile(new URL("../example/event-driven-orders.drawio", import.meta.url), join(cwd, "stored.drawio"));
  await writeFile(join(cwd, "native.drawio"), document("Native"));
  const native = vi.spyOn(drawio, "exportDiagram").mockResolvedValue({
    ...artifact(join(cwd, "native.svg")), format: "svg", mode: "final", animated: true,
    animation: { page: "Native", connectorFlows: 1, sequenceSteps: 0, sequenceDurationMs: 0, sequenceCompiled: false, verified: true },
  });
  const { commands } = registered();
  const notify = vi.fn();
  const ctx = { cwd, ui: { notify } };
  const command = commands.get("drawme-export")!;
  await command.handler("", ctx);
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/native draw\.io .*connector flow.*drawio_animate.*omit steps/), "info");
  await command.handler("stored.drawio animated-svg", ctx);
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/^Export failed: .*stored DrawMe motion.*drawio_animate.*stored\.drawio.*omit steps/), "error");
  expect(native).not.toHaveBeenCalled();
  await command.handler("native.drawio animated-svg", ctx);
  expect(native).toHaveBeenCalledWith({ input: join(cwd, "native.drawio"), format: "svg", mode: "final", animated: true });
  expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("animation verified"), "info");
});
