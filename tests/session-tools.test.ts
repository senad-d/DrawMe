import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { exportDiagram, openFile } from "../src/drawio";
import drawme from "../src/index";
import { DEFAULT_MAX_XML_BYTES } from "../src/xml-input";
import { installNodeRendererFixture, makeMockPi, TINY_PNG, type ResultContent } from "./fixtures";

vi.mock("../src/drawio", { spy: true });

const source = `<mxfile><diagram name="Sheet"><mxGraphModel page="1" pageWidth="800" pageHeight="600"><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="a" vertex="1" parent="1"><mxGeometry x="100" y="100" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;
const vision = { model: { input: ["text", "image"] } };

function tools() {
  const fixture = makeMockPi();
  drawme(fixture.pi as never);
  return fixture.tools;
}

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "drawme session fixture "));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}

async function previewFixture() {
  const dir = await workspace();
  const input = join(dir, "diagram.drawio");
  const binary = join(dir, "drawio.mjs");
  await writeFile(input, source);
  await writeFile(binary, `import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args.includes("--version")) process.stdout.write("32.4.1\\n");
else if (option("-f") === "xml") {
  const input = readFileSync(args[args.indexOf("-o") + 2], "utf8");
  const xml = args.includes("--layout") ? input.replace('x="100"', 'x="350"')
    : ${JSON.stringify(source)}.replace('name="Sheet"', 'name="' + (input.includes("inline") ? "Inline" : "From file") + '"');
  writeFileSync(option("-o"), xml);
}
else writeFileSync(option("-o"), option("-f") === "svg"
  ? '<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px"><g data-cell-id="a"><rect width="80" height="40"/></g></svg>'
  : Buffer.from("${TINY_PNG}", "base64"));
`);
  const restore = installNodeRendererFixture([binary]);
  vi.stubEnv("DISPLAY", ":99");
  vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
  onTestFinished(() => {
    restore();
    vi.unstubAllEnvs();
  });
  return { dir, input };
}

it("validates and fits the session diagram, not the same relative name in the host cwd", async () => {
  const dir = await workspace();
  const host = join(dir, "host");
  const session = join(dir, "session");
  await Promise.all([mkdir(host), mkdir(session)]);
  const input = "same.drawio";
  const hostSource = source.replace("</root>", '<mxCell id="e" edge="1" parent="1" source="a" target="missing"><mxGeometry relative="1" as="geometry"/></mxCell></root>');
  await Promise.all([writeFile(join(host, input), hostSource), writeFile(join(session, input), source)]);
  const registered = tools();
  const ctx = { cwd: session };
  const originalCwd = process.cwd();
  process.chdir(host);
  try {
    const validated = await registered.get("drawio_validate")!.execute("validate", { input }, undefined, undefined, ctx);
    expect.soft(validated.details).toMatchObject({ errors: [] });
    const fitted = await registered.get("drawio_fit_canvas")!.execute("fit", { input }, undefined, undefined, ctx);
    expect.soft(fitted.details).toMatchObject({ output: join(session, input), changed: true });
    expect.soft(await readFile(join(host, input), "utf8")).toBe(hostSource);
    expect(await readFile(join(session, input), "utf8")).toContain('pageWidth="160"');
  } finally {
    process.chdir(originalCwd);
  }
});

it.for(["drawio_export", "drawio_animate"])("does not publish an SVG when %s is called with an aborted signal", async (name) => {
  const { dir, input } = await previewFixture();
  const output = join(dir, "aborted.svg");
  const params = name === "drawio_animate"
    ? { input, output, storyboard: false, steps: [{ effect: "fadeIn", cells: ["a"] }] }
    : { input, output, format: "svg" };
  const result = await tools().get(name)!.execute("aborted", params, AbortSignal.abort(), undefined, vision);
  const prefix = name === "drawio_animate" ? "Animate" : "Export";
  expect.soft(result.content).toEqual([{ type: "text", text: expect.stringMatching(new RegExp(`^${prefix} failed:`)) }]);
  await expect.soft(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(input, "utf8")).toBe(source);
});

it("does not ask a vision model to compare against an earlier text-only preview", async () => {
  const { dir, input } = await previewFixture();
  const exportTool = tools().get("drawio_export")!;
  const params = { input, mode: "preview", output: join(dir, "review.png") };
  const first = await exportTool.execute("first", params, undefined, undefined, { model: { input: ["text"] } });
  expect(first.details).toMatchObject({ imageAttached: false });
  expect(first.content.map((block) => block.type)).toEqual(["text"]);
  const branch = [{ type: "message", id: "1", parentId: null, timestamp: new Date().toISOString(), message: {
    ...first, role: "toolResult", toolCallId: "first", toolName: "drawio_export", isError: false, timestamp: Date.now(),
  } }];
  const ctx = { ...vision, sessionManager: { getBranch: () => branch } };
  const next = await exportTool.execute("second", params, undefined, undefined, ctx);
  expect(next.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
  expect(next.content[0]).toMatchObject({ type: "text", text: expect.not.stringMatching(/previous preview.*visible|not.fixed.*regressed/i) });
});

it("does not attach a preview when the model's image capability is unknown", async () => {
  const { input } = await previewFixture();
  const result = await tools().get("drawio_export")!.execute("preview", { input, mode: "preview" }, undefined, undefined, {});
  expect.soft(result.details).toMatchObject({ imageAttached: false });
  expect(result.content.map((block) => block.type)).toEqual(["text"]);
});

it("returns a text-only failure if the published preview cannot be read as a file", async () => {
  const { dir, input } = await previewFixture();
  const output = join(dir, "review.png");
  const actual = await vi.importActual<typeof import("../src/drawio")>("../src/drawio");
  vi.mocked(exportDiagram).mockImplementationOnce(async (...args) => {
    const rendered = await actual.exportDiagram(...args);
    // Model the file being replaced between successful publication and the attachment read.
    await rm(output);
    await mkdir(output);
    return rendered;
  });
  const result = tools().get("drawio_export")!.execute("preview", { input, mode: "preview", output }, undefined, undefined, vision);
  await expect(result).resolves.toMatchObject({
    content: [{ type: "text", text: expect.stringMatching(/^Export failed:/) }],
  });
});

function historyEntry(id: string, result: { content: ResultContent[]; details: unknown }) {
  return { type: "message", id, message: {
    ...result, role: "toolResult", toolCallId: id, toolName: "drawio_export", isError: false,
  } };
}

it("uses a real branch attachment for comparison, independently of the preview's filename", async () => {
  const { dir, input } = await previewFixture();
  const exportTool = tools().get("drawio_export")!;
  const first = await exportTool.execute("first", { input, mode: "preview" }, undefined, undefined, vision);
  expect(first.details).toMatchObject({ source: input, pageIndex: 1, imageAttached: true });
  expect(first.content[1]).toEqual({ type: "image", data: TINY_PNG, mimeType: "image/png" });
  const ctx = { ...vision, cwd: dir, sessionManager: { getBranch: () => [historyEntry("first", first)] } };
  const second = await exportTool.execute("second", { input: "diagram.drawio", mode: "preview", output: "retry.png" }, undefined, undefined, ctx);
  expect(second.details).toMatchObject({ source: input, pageIndex: 1, output: join(dir, "retry.png"), imageAttached: true });
  expect(second.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/fixed, not fixed, or regressed/) });
});

it("does not compare to attached PNGs outside the requested page or active conversation", async () => {
  const { dir, input } = await previewFixture();
  await writeFile(input, source.replace("</mxfile>", `${source.slice("<mxfile>".length, -"</mxfile>".length)}</mxfile>`));
  const exportTool = tools().get("drawio_export")!;
  const call = (id: string, pageIndex: number, ctx: unknown) =>
    exportTool.execute(id, { input, mode: "preview", output: join(dir, "review.png"), pageIndex }, undefined, undefined, ctx);
  const initial = await call("initial", 1, vision);
  const prior = historyEntry("initial", initial);
  expect(initial.content[1]?.type).toBe("image");
  const otherPage = await call("page-two", 2, { ...vision, sessionManager: { getBranch: () => [prior] } });
  const otherBranch = await call("branch-two", 1, { ...vision, sessionManager: { getBranch: () => [], getEntries: () => [prior] } });
  const removedImage = { ...prior.message, content: initial.content.slice(0, 1) };
  const contextEdited = await call("edited", 1, { ...vision, sessionManager: {
    getBranch: () => [prior], buildSessionProjection: () => ({ messages: [removedImage] }),
  } });
  for (const result of [otherPage, otherBranch, contextEdited]) {
    expect(result.content[1]?.type).toBe("image");
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Critique it") });
  }
});

it("reports preview retirement on a text-only final and resets comparison in that conversation", async () => {
  const { dir, input } = await previewFixture();
  const exportTool = tools().get("drawio_export")!;
  const rendered = await exportTool.execute("preview", { input, mode: "preview" }, undefined, undefined, vision);
  const preview = join(dir, "diagram.preview.png");
  expect(rendered.details).toMatchObject({ output: preview, imageAttached: true });
  const final = await exportTool.execute("final", { input, format: "png", mode: "final" }, undefined, undefined, vision);
  expect(final.content.map((block) => block.type)).toEqual(["text"]);
  expect(final.details).toMatchObject({ imageAttached: false, removedPreviews: [preview] });
  await expect(access(preview)).rejects.toMatchObject({ code: "ENOENT" });
  const ctx = { ...vision, sessionManager: { getBranch: () => [historyEntry("preview", rendered), historyEntry("final", final)] } };
  const next = await exportTool.execute("new", { input, mode: "preview" }, undefined, undefined, ctx);
  expect(next.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Critique it") });
});

it("anchors native import and layout destinations in the session directory", async () => {
  const { dir, input } = await previewFixture();
  await writeFile(join(dir, "order.mmd"), "graph LR; file --> end");
  const registered = tools();
  const ctx = { cwd: dir };
  const convert = registered.get("drawio_from_mermaid")!;
  const inline = await convert.execute("inline", { mermaid: "graph LR; inline --> end" }, undefined, undefined, ctx);
  expect(inline.details).toMatchObject({ output: input });
  expect(await readFile(input, "utf8")).toContain('name="Inline"');
  const file = await convert.execute("file", { input: "order.mmd" }, undefined, undefined, ctx);
  expect(file.details).toMatchObject({ output: join(dir, "order.drawio") });
  expect(await readFile(join(dir, "order.drawio"), "utf8")).toContain('name="From file"');
  const layout = await registered.get("drawio_layout")!.execute("layout", { input: "order.drawio", preset: "horizontalFlow" }, undefined, undefined, ctx);
  expect(layout.details).toMatchObject({ output: join(dir, "order.layout.drawio") });
  expect(await readFile(join(dir, "order.layout.drawio"), "utf8")).toContain('x="350"');
});

it("anchors animate, explain and open operands without changing absolute spellings", async () => {
  const { dir, input } = await previewFixture();
  const registered = tools();
  const ctx = { cwd: dir };
  const animated = await registered.get("drawio_animate")!.execute("animate", {
    input: "diagram.drawio", output: "movement.svg", steps: [{ effect: "fadeIn", cells: ["a"] }], storyboard: false,
  }, undefined, undefined, ctx);
  expect(animated.details).toMatchObject({ output: join(dir, "movement.svg"), source: input, saved: true });
  const explain = await registered.get("drawio_explain")!.execute("explain", { input: "diagram.drawio" }, undefined, undefined, ctx);
  expect(explain.details).toMatchObject({ markdown: expect.stringContaining("(unlabeled a)") });
  vi.mocked(openFile).mockResolvedValueOnce({ opener: "fixture" }).mockResolvedValueOnce({ opener: "fixture" });
  const opener = registered.get("drawio_open")!;
  await opener.execute("relative", { path: "movement.svg" }, undefined, undefined, ctx);
  const spelling = `${dir}${sep}.${sep}movement.svg`;
  await opener.execute("absolute", { path: spelling }, undefined, undefined, ctx);
  expect(vi.mocked(openFile).mock.calls.slice(-2)).toEqual([[join(dir, "movement.svg")], [spelling]]);
});

it("preserves filesystem resolution across a symlinked parent and does not erase a trailing separator", async () => {
  const { dir } = await previewFixture();
  const nested = join(dir, "other", "nested");
  await mkdir(nested, { recursive: true });
  const session = join(dir, "session");
  await mkdir(session);
  await symlink(nested, join(session, "linked"), "junction");
  await writeFile(join(dir, "other", "model.drawio"), source.replace('id="a"', 'id="a" value="Actual"'));
  await writeFile(join(session, "model.drawio"), source.replace('id="a"', 'id="a" value="Wrong"'));
  const registered = tools();
  const ctx = { cwd: session };
  const spelling = `linked${sep}..${sep}model.drawio`;
  vi.mocked(openFile).mockResolvedValueOnce({ opener: "fixture" });
  await registered.get("drawio_open")!.execute("open", { path: spelling }, undefined, undefined, ctx);
  expect(vi.mocked(openFile)).toHaveBeenLastCalledWith(`${session}${sep}${spelling}`);
  if (process.platform !== "win32") {
    const explain = await registered.get("drawio_explain")!.execute("explain", { input: spelling }, undefined, undefined, ctx);
    expect(explain.details).toMatchObject({ markdown: expect.stringContaining("Actual") });
  }
  const exportTool = registered.get("drawio_export")!;
  const output = `rejected.svg${sep}`;
  const invalid = await exportTool.execute("invalid", { input: "model.drawio", output, format: "svg" }, undefined, undefined, ctx);
  expect(invalid.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^Export failed:/) });
  await expect(access(join(session, "rejected.svg"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("labels budget-limited validation results incomplete instead of displaying a clean score", async () => {
  const dir = await workspace();
  const path = join(dir, "large.drawio");
  await writeFile(path, source);
  await truncate(path, DEFAULT_MAX_XML_BYTES + 1);
  const result = await tools().get("drawio_validate")!.execute("validate", { input: "large.drawio" }, undefined, undefined, { cwd: dir });
  expect(result.details).toMatchObject({ incomplete: true, errors: [expect.stringContaining("byte limit")] });
  expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/Validation incomplete:.*Partial readability score:/s) });
});

it("publishes the integer page and search constraints without exposing internal dimensions or signals", () => {
  const registered = tools();
  const exportSchema = registered.get("drawio_export")!.parameters.properties;
  expect(exportSchema).toMatchObject({ width: { type: "number" }, pageIndex: { type: "integer", minimum: 1 } });
  expect(exportSchema).not.toHaveProperty("height");
  expect(exportSchema).not.toHaveProperty("signal");
  expect(registered.get("drawio_animate")!.parameters.properties).toMatchObject({ pageIndex: { type: "integer", minimum: 1 } });
  expect(registered.get("drawio_animate")!.parameters.properties).not.toHaveProperty("signal");
  expect(registered.get("drawio_shapesearch")!.parameters.properties).toMatchObject({ limit: { type: "integer", minimum: 0 } });
});
