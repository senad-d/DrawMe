import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { XMLSerializer, type Element } from "@xmldom/xmldom";
import { describe, expect, it, onTestFinished } from "vitest";
import drawme from "../src/index";
import { resolveBinary } from "../src/renderer";
import { makeMockPi, TINY_PNG, type ResultContent } from "./fixtures";
import { countPngColors, editableModels, jpegFrame, parseXml, readPng } from "./native-artifact-fixtures";

const NATIVE_TIMEOUT = 120_000;
const MERMAID = "flowchart LR\n A[Receive order] --> B[Check stock] --> C[Ship order]";

function node(id: string, label: string, x: number, y: number, w: number, h: number, style = "", parent = "1") {
  return `<mxCell id="${id}" value="${label}" style="${style}" parent="${parent}" vertex="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
}

function page(id: string, cells: string, background = "#ffffff") {
  return `<diagram id="${id}" name="${id}"><mxGraphModel page="1" pageScale="1" pageWidth="640" pageHeight="480" background="${background}"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram>`;
}

const edge = '<mxCell id="edge" edge="1" source="start" target="end" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>';
const first = page("First", node("start", "Receive order", 80, 80, 100, 50) + node("end", "Ship order", 260, 80, 100, 50) + edge);
const second = page("Second", node("stock", "Check stock", 100, 90, 100, 60));
const diagram = (...pages: string[]) => `<mxfile>${pages.join("")}</mxfile>`;
const cells = (model: Element) => new Map(Array.from(model.getElementsByTagName("mxCell"), (cell) => [cell.getAttribute("id"), cell]));
const geometry = (cell: Element) => cell.getElementsByTagName("mxGeometry")[0];
const placement = (cell: Element) => [Number(geometry(cell).getAttribute("x")), Number(geometry(cell).getAttribute("y"))];

async function nativeSession() {
  const work = await mkdtemp(join(tmpdir(), "drawme native artifacts "));
  onTestFinished(() => rm(work, { recursive: true, force: true }));
  const cwd = await realpath(work);
  const { pi, tools, commands } = makeMockPi();
  drawme(pi as never);
  const ctx = { cwd, model: { input: ["text", "image"] } };
  return {
    ctx, commands,
    path: (filename: string) => join(cwd, filename),
    put: (filename: string, value: string | Buffer) => writeFile(join(cwd, filename), value),
    call: (name: string, params: object = {}) => tools.get(name)!.execute(name, params, undefined, undefined, ctx),
  };
}

async function regularFile(filename: string) {
  expect((await stat(filename)).isFile(), `${filename} is a delivered file`).toBe(true);
  return readFile(filename);
}

async function provePngAttachment(filename: string, content: ResultContent[]) {
  const bytes = await regularFile(filename);
  const image = content[1];
  expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
  expect(image.type === "image" && Buffer.from(image.data, "base64").equals(bytes), "the attachment matches the delivered file").toBe(true);
  return readPng(bytes);
}

function expectTerminals(edgeCell: Element, source: string, target: string) {
  expect([edgeCell.getAttribute("source"), edgeCell.getAttribute("target")]).toEqual([source, target]);
}

describe("native draw.io artifacts through the registered tools", async () => {
  const cli = await resolveBinary();
  const [major, minor, patch] = (cli.version ?? "0.0.0").split(".").map(Number);
  const pageSelection = cli.available && (major > 27 || (major === 27 && (minor > 0 || patch >= 2)));

  it.runIf(cli.available)("recovers editable cells and a connected edge from the real final PNG, never the preview", async () => {
    const session = await nativeSession();
    const input = "orders.drawio";
    const preview = session.path("orders.preview.png");
    const final = session.path("orders.drawio.png");
    await session.put(input, diagram(first));

    const review = await session.call("drawio_export", { input, mode: "preview", embed: true });
    expect(review.details).toMatchObject({ output: preview, format: "png", embed: false, imageAttached: true });
    expect(editableModels(await provePngAttachment(preview, review.content))).toEqual([]);

    const delivered = await session.call("drawio_export", { input, mode: "final" });
    expect(delivered.details).toMatchObject({ output: final, format: "png", embed: true, imageAttached: false, removedPreviews: [preview] });
    expect(delivered.content).toEqual([{ type: "text", text: expect.stringContaining(`Exported ${final}`) }]);
    const models = editableModels(readPng(await regularFile(final)));
    expect(models, "recover one editable mxGraphModel from the delivered PNG, not just an embed=true receipt").toHaveLength(1);
    const graph = cells(models[0]);
    expect([...graph.keys()].sort()).toEqual(["0", "1", "edge", "end", "start"]);
    expect(graph.get("start")?.getAttribute("value")).toBe("Receive order");
    expect(graph.get("end")?.getAttribute("value")).toBe("Ship order");
    expectTerminals(graph.get("edge")!, "start", "end");
    await expect(stat(preview)).rejects.toMatchObject({ code: "ENOENT" });
  }, NATIVE_TIMEOUT);

  it.runIf(cli.available).each([
    { width: 320, height: 800, longSide: 2000, requested: undefined },
    { width: 800, height: 320, longSide: 2000, requested: undefined },
    { width: 320, height: 800, longSide: 2576, requested: 5000 },
  ])("bounds a real $width×$height preview attachment (width=$requested) without stretching or embedding", async ({ width, height, longSide, requested }) => {
    const session = await nativeSession();
    const input = "aspect.drawio";
    await session.put(input, diagram(page("Aspect", node("box", "Aspect control", 20, 20, width, height, "strokeColor=none;fillColor=#5976aa;"))));
    const border = 40;
    const result = await session.call("drawio_export", { input, mode: "preview", embed: true, width: requested, border });
    const output = session.path("aspect.preview.png");
    expect(result.details).toMatchObject({ output, embed: false, imageAttached: true });
    const png = await provePngAttachment(output, result.content);
    expect(png.width).toBeLessThanOrEqual(longSide);
    expect(png.height).toBeLessThanOrEqual(longSide);
    expect(Math.max(png.width, png.height)).toBeGreaterThan(longSide - 10);
    expect(png.width * png.height).toBeLessThanOrEqual(6_000_000);
    expect((png.width - 2 * border) / (png.height - 2 * border)).toBeCloseTo(width / height, 2);
    expect(editableModels(png)).toEqual([]);
  }, NATIVE_TIMEOUT);

  it.runIf(pageSelection)("selects one-based pages and adds both margins after SVG width sizing", async () => {
    const session = await nativeSession();
    const input = "pages.drawio";
    await session.put(input, diagram(first, second));
    const outputs = [];
    for (const [pageIndex, border, included, excluded] of [
      [1, 0, "Receive order", "Check stock"],
      [1, 40, "Receive order", "Check stock"],
      [2, 40, "Check stock", "Receive order"],
    ] as const) {
      const output = `page ${pageIndex} border ${border}.svg`;
      const result = await session.call("drawio_export", { input, pageIndex, output, format: "svg", width: 500, border, embed: false });
      expect(result.details).toMatchObject({ output: session.path(output), format: "svg", pageIndex, imageAttached: false });
      const root = parseXml((await regularFile(session.path(output))).toString()).documentElement!;
      expect(root.localName).toBe("svg");
      expect(root.textContent).toContain(included);
      expect(root.textContent).not.toContain(excluded);
      const width = Number.parseFloat(root.getAttribute("width")!);
      expect(Math.abs(width - (500 + border * 2))).toBeLessThanOrEqual(2);
      const viewBoxWidth = Number(root.getAttribute("viewBox")?.split(/[\s,]+/)[2]);
      expect(viewBoxWidth).toBe(width);
      outputs.push(width);
    }
    expect(outputs[1] - outputs[0]).toBe(80);
  }, NATIVE_TIMEOUT);

  it.runIf(cli.available)("fits the actual final raster within the pixel budget including the border", async () => {
    const session = await nativeSession();
    const input = "large.drawio";
    await session.put(input, diagram(page("Large", node("box", "Large chart", 0, 0, 2400, 1800, "strokeColor=none;fillColor=#5976aa;"))));
    const result = await session.call("drawio_export", { input, scale: 2, border: 40, embed: false });
    const output = session.path("large.png");
    expect(result.details).toMatchObject({ output, format: "png", imageAttached: false });
    const { width, height } = readPng(await regularFile(output));
    expect(width * height).toBeLessThanOrEqual(6_000_000);
    expect(width * height).toBeGreaterThan(5_700_000);
    expect(width / height).toBeCloseTo(2480 / 1880, 2);
    expect(width).toBeLessThan(2 * 2480);
  }, NATIVE_TIMEOUT);

  it.runIf(cli.available)("delivers a noneditable JPEG matching its receipt and preserves it when editable JPEG is requested", async () => {
    const session = await nativeSession();
    const input = "orders.drawio", output = "photo.jpeg";
    await session.put(input, diagram(first));
    const jpeg = await session.call("drawio_export", { input, output, format: "jpg", width: 420 });
    expect(jpeg.details).toMatchObject({ output: session.path(output), format: "jpg", embed: false, imageAttached: false });
    const bytes = await regularFile(session.path(output));
    const frame = jpegFrame(bytes);
    expect(frame.width).toBe(420);
    expect(frame.height).toBeGreaterThan(80); // Content as well as the two 40px margins.

    const rejected = await session.call("drawio_export", { input, output, format: "jpg", embed: true });
    expect(rejected.content).toEqual([{ type: "text", text: expect.stringMatching(/^Export failed:.*JPG.*embed/i) }]);
    expect(await readFile(session.path(output))).toEqual(bytes);
  }, NATIVE_TIMEOUT);

  it.runIf(cli.available)("retains the finite PDF page media box and refuses a directory receipt", async () => {
    const session = await nativeSession();
    const input = "orders.drawio";
    await session.put(input, diagram(first));
    const result = await session.call("drawio_export", { input, format: "pdf" });
    const output = session.path("orders.pdf");
    expect(result.details).toMatchObject({ output, format: "pdf", imageAttached: false });
    const pdf = (await regularFile(output)).toString("latin1");
    expect(pdf).toMatch(/^%PDF-/);
    expect(pdf.trimEnd()).toMatch(/%%EOF$/);
    const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(pdf);
    expect(box, "one PDF page has a media box").not.toBeNull();
    const [, left, bottom, right, top] = box!.map(Number);
    expect(left).toBe(0);
    expect(bottom).toBe(0);
    // Desktop 32.4.1 prints this 640×480 page at about 0.72 points per unit; allow native print rounding.
    expect(Math.abs(right - 640 * 0.72)).toBeLessThanOrEqual(2);
    expect(Math.abs(top - 480 * 0.72)).toBeLessThanOrEqual(2);

    const directory = "existing.pdf";
    await mkdir(session.path(directory));
    const rejected = await session.call("drawio_export", { input, format: "pdf", output: directory });
    expect(rejected.content).toEqual([{ type: "text", text: expect.stringMatching(/^Export failed:.*not a regular file/) }]);
    expect(await readdir(session.path(directory))).toEqual([]);
  }, NATIVE_TIMEOUT);

  it.runIf(cli.available && cli.supportsMermaid === true)("converts the three-node Mermaid order flow and fits a finite page", async () => {
    const session = await nativeSession();
    const checked = await session.call("drawio_check");
    expect(checked.details).toMatchObject({ available: true, version: cli.version, supportsMermaid: true });
    const input = "diagram.drawio";
    const converted = await session.call("drawio_from_mermaid", { mermaid: MERMAID });
    expect(converted.details).toMatchObject({ output: session.path(input) });
    const before = await regularFile(session.path(input));
    const fitted = await session.call("drawio_fit_canvas", { input, margin: 30 });
    expect(fitted.details).toMatchObject({ changed: true, output: session.path(input) });
    const after = await regularFile(session.path(input));
    expect(after).not.toEqual(before);
    const model = parseXml(after.toString()).getElementsByTagName("mxGraphModel")[0];
    expect(model.getAttribute("page")).toBe("1");
    const graph = Array.from(model.getElementsByTagName("mxCell"));
    const nodes = graph.filter((cell) => cell.getAttribute("vertex") === "1");
    // Mermaid normally stores its effective id and label on a wrapper, not the inner mxCell.
    const ids = new Map(nodes.map((cell) => {
      const wrapper = cell.parentNode as Element;
      return [cell.getAttribute("id") ?? wrapper.getAttribute("id"), cell.getAttribute("value") ?? wrapper.getAttribute("label")];
    }));
    expect([...ids.values()].sort()).toEqual(["Check stock", "Receive order", "Ship order"]);
    const segments = graph.filter((cell) => cell.getAttribute("edge") === "1");
    expect(segments.map((cell) => `${ids.get(cell.getAttribute("source"))}→${ids.get(cell.getAttribute("target"))}`).sort()).toEqual([
      "Check stock→Ship order", "Receive order→Check stock",
    ]);
    for (const [axis, dim, canvas] of [["x", "width", "pageWidth"], ["y", "height", "pageHeight"]]) {
      const positions = nodes.map(geometry).map((g) => [Number(g.getAttribute(axis)), Number(g.getAttribute(dim))]);
      expect(Math.min(...positions.map(([p]) => p))).toBeCloseTo(30, 0);
      const farEdge = Math.max(...positions.map(([p, size]) => p + size));
      expect(Number(model.getAttribute(canvas)) - farEdge).toBeCloseTo(30, 0);
    }
    expect((await session.call("drawio_validate", { input })).details).toMatchObject({ incomplete: false, errors: [] });
  }, NATIVE_TIMEOUT);

  it.runIf(cli.available && cli.supportsLayout === true)("lays out overlapping nodes without changing topology or either page's settings", async () => {
    const session = await nativeSession();
    const input = "-dark overlap.drawio", output = "-layout result.drawio";
    const dark = page("Dark", node("start", "Receive order", 80, 80, 100, 50) + node("end", "Ship order", 80, 80, 100, 50) + edge, "#172033");
    const xml = diagram(dark, second);
    await session.put(input, xml);
    const result = await session.call("drawio_layout", { input, output, preset: "horizontalFlow" });
    expect(result.details).toMatchObject({ output: session.path(output), preset: "horizontalFlow" });
    const pages = parseXml((await regularFile(session.path(output))).toString()).getElementsByTagName("diagram");
    expect(pages).toHaveLength(2);
    const model = pages[0].getElementsByTagName("mxGraphModel")[0];
    expect(["page", "pageWidth", "pageHeight", "background"].map((key) => model.getAttribute(key))).toEqual(["1", "640", "480", "#172033"]);
    const graph = cells(model);
    expect([...graph.keys()].sort()).toEqual(["0", "1", "edge", "end", "start"]);
    expectTerminals(graph.get("edge")!, "start", "end");
    const [startX] = placement(graph.get("start")!);
    const [endX] = placement(graph.get("end")!);
    expect(endX - startX).toBeGreaterThanOrEqual(100);
    expect(new XMLSerializer().serializeToString(pages[1])).toBe(second);
    expect(await readFile(session.path(input), "utf8")).toBe(xml);
  }, NATIVE_TIMEOUT);

  it.runIf(pageSelection)("never certifies a native SVG that loses or links its local logo", async () => {
    const session = await nativeSession();
    await session.put("logo.png", Buffer.from(TINY_PNG, "base64"));
    const input = "local-image.drawio", output = "local-image.animated.svg";
    const logo = node("logo", "", 140, 90, 100, 100, `shape=image;image=${pathToFileURL(session.path("logo.png")).href};`);
    await session.put(input, diagram(page("Logo", logo)));
    const result = await session.call("drawio_animate", { input, output, steps: [{ effect: "fadeIn", cells: ["logo"] }], storyboard: false });
    const message = result.content[0];
    if (message.type === "text" && message.text.startsWith("Animate failed:")) {
      expect(message.text).toMatch(/linked image; embed the image|unresolved.*image/i);
      await expect(stat(session.path(output))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(result.details).toMatchObject({ output: session.path(output), animatedCells: 1 });
      const standalone = session.path("copied.svg");
      await copyFile(session.path(output), standalone);
      await rm(session.path("logo.png"));
      const svg = parseXml((await regularFile(standalone)).toString());
      const references = Array.from(svg.getElementsByTagName("image")).flatMap((image) => [
        image.getAttribute("href"), image.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
      ]).filter(Boolean);
      expect(references.length, "the copied SVG still has a logo image").toBeGreaterThan(0);
      for (const reference of references) expect(reference).toMatch(/^data:image\//i);
    }
  }, NATIVE_TIMEOUT);

  it.runIf(pageSelection)("renders visible storyboard colors but never hidden draft pixels, and keeps the earlier board", async () => {
    const session = await nativeSession();
    const blue = 0x105bc7, green = 0x119044, red = 0xed152f;
    const input = "story.drawio";
    const blocks = node("frame", "Start", 60, 70, 100, 75, `strokeColor=none;fillColor=#${blue.toString(16)};`) +
      node("caption", "End", 250, 70, 100, 75, `strokeColor=none;fillColor=#${green.toString(16)};`);
    const draft = node("hidden", "HIDDEN DRAFT", 130, 90, 145, 30, `strokeColor=none;fillColor=#${red.toString(16)};`, "draft");
    const withDraft = (visible: number) => `${blocks}<mxCell id="draft" parent="0" visible="${visible}"/>${draft}`;
    // The second page is a renderer/decoder positive control for the exact same draft color.
    await session.put(input, diagram(page("Hidden", withDraft(0)), page("Shown", withDraft(1))));
    const steps = [{ effect: "fadeIn", cells: ["frame"] }, { effect: "fadeIn", cells: ["caption"] }];
    const animate = (pageIndex: number, output: string) => session.call("drawio_animate", { input, output, pageIndex, steps });
    const hidden = await animate(1, "hidden.svg");
    const firstBoard = session.path("hidden.svg.page-1.board.png");
    expect(hidden.details).toMatchObject({ output: session.path("hidden.svg"), storyboard: firstBoard, storyboardFrames: 2, imageAttached: true });
    const [bluePixels, greenPixels, hiddenPixels] = countPngColors(await provePngAttachment(firstBoard, hidden.content), [blue, green, red]);
    expect(bluePixels).toBeGreaterThan(100);
    expect(greenPixels).toBeGreaterThan(100);
    expect(hiddenPixels).toBe(0);
    const before = await readFile(firstBoard);

    const shown = await animate(2, "shown.svg");
    const secondBoard = session.path("shown.svg.page-2.board.png");
    expect(shown.details).toMatchObject({ output: session.path("shown.svg"), storyboard: secondBoard, storyboardFrames: 2, imageAttached: true });
    expect(countPngColors(await provePngAttachment(secondBoard, shown.content), [red])[0]).toBeGreaterThan(100);
    expect(await readFile(firstBoard)).toEqual(before);
  }, NATIVE_TIMEOUT);

  it.runIf(pageSelection)("follows command feedback to actually export the packaged stored motion plus its storyboard", async () => {
    const session = await nativeSession();
    const input = "event-driven-orders.drawio";
    const path = session.path(input);
    await copyFile(new URL(`../example/${input}`, import.meta.url), path);
    const before = await readFile(path);
    const notices: [string, string][] = [];
    await session.commands.get("drawme-export")!.handler(`${input} animated-svg`, {
      ...session.ctx, ui: { notify: (message: string, level: string) => notices.push([message, level]) },
    });
    expect(notices).toEqual([[expect.stringMatching(/Export failed:.*\n.*stored DrawMe motion.*drawio_animate.*omit steps/), "error"]]);
    await expect(stat(session.path("event-driven-orders.svg"))).rejects.toMatchObject({ code: "ENOENT" });

    const result = await session.call("drawio_animate", { input });
    const output = session.path("event-driven-orders.animated.svg");
    const storyboard = session.path("event-driven-orders.storyboard.png");
    expect(result.details).toMatchObject({ output, storyboard, steps: 12, saved: false, imageAttached: true });
    expect((await regularFile(output)).toString()).toContain("prefers-reduced-motion");
    await provePngAttachment(storyboard, result.content);
    expect(await readFile(path)).toEqual(before);
  }, NATIVE_TIMEOUT);
});
