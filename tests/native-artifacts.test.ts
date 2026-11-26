import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync, inflateSync } from "node:zlib";
import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";
import { afterEach, describe, expect, it, vi } from "vitest";
import drawme from "../src/index";
import { resolveBinary } from "../src/renderer";
import { makeMockPi, TINY_PNG, type ResultContent } from "./fixtures";
import { installRendererFixtureAdapter, writeRendererFixture } from "./renderer-fixture";

const NATIVE_TIMEOUT = 120_000;
const MAX_REVIEW_SIDE = 2000;
const MAX_RASTER_PIXELS = 6_000_000;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const EMBEDDED_LOGO = `data:image/png;base64,${TINY_PNG}`;
const XLINK = "http://www.w3.org/1999/xlink";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const model = (cells: string, attrs = 'page="1" pageWidth="800" pageHeight="600"') =>
  `<mxGraphModel ${attrs}><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const page = (name: string, graph: string) => `<diagram id="${name}" name="${name}">${graph}</diagram>`;
const document = (...pages: string[]) => `<mxfile compressed="false">${pages.join("")}</mxfile>`;
const node = (id: string, label: string, x: number, y: number, width: number, height: number, style = "strokeColor=none;", parent = "1") =>
  `<mxCell id="${id}" value="${label}" parent="${parent}" vertex="1" style="${style}"><mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/></mxCell>`;
const link = (id: string, from: string, to: string) => `<mxCell id="${id}" parent="1" edge="1" source="${from}" target="${to}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
const smallGraph = model(node("first-id", "Apricot Beacon", 80, 70, 160, 80));
const otherPage = page("second", model(node("second-id", "Cobalt Compass", 88, 76, 180, 90), 'page="1" pageWidth="1110" pageHeight="680" background="#ddeeff"'));

async function fixture(xml: string) {
  const dir = await mkdtemp(join(tmpdir(), "drawme-native-artifacts-"));
  dirs.push(dir);
  const { pi, tools } = makeMockPi();
  drawme(pi as never);
  const input = "map.drawio";
  await writeFile(join(dir, input), xml);
  const call = (tool: string, params: object) => tools.get(tool)!.execute("native-test", params, undefined, undefined, {
    cwd: dir, model: { input: ["text", "image"] },
  });
  return { dir, input, path: (name: string) => join(dir, name), call };
}

type Result = { content: ResultContent[]; details: unknown };
function text(result: Result) {
  return result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}
function succeeded(result: Result, message: RegExp) {
  expect(text(result)).toMatch(message);
  expect(result.details).not.toHaveProperty("error");
}

function parseXml(xml: string) {
  return new DOMParser().parseFromString(xml, "text/xml");
}
function nodes(root: Element, tag: string) {
  return Array.from(root.getElementsByTagName(tag));
}
function wrapper(cell: Element) {
  const parent = cell.parentNode;
  return parent?.nodeType === 1 && (parent as Element).tagName !== "root" ? parent as Element : undefined;
}
function cells(root: Element) {
  return new Map(nodes(root, "mxCell").map((cell) => [cell.getAttribute("id") ?? wrapper(cell)?.getAttribute("id"), cell]));
}
function label(cell: Element) {
  return wrapper(cell)?.getAttribute("label") ?? cell.getAttribute("value");
}

/** Read on-disk PNG chunks independently of DrawMe's verifier. */
function png(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    expect(end).toBeLessThanOrEqual(bytes.length);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    chunks.push({ type, data: bytes.subarray(offset + 8, end - 4) });
    offset = end;
    if (type === "IEND") break;
  }
  expect(offset).toBe(bytes.length);
  expect(chunks.at(-1)?.type).toBe("IEND");
  expect(chunks[0]?.type).toBe("IHDR");
  const header = chunks[0].data;
  return { chunks, header, width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

function editablePayloads({ chunks }: ReturnType<typeof png>): string[] {
  return chunks.flatMap(({ type, data }) => {
    if (!["tEXt", "zTXt", "iTXt"].includes(type)) return [];
    const keyEnd = data.indexOf(0);
    if (keyEnd < 0 || !["mxGraphModel", "mxfile"].includes(data.toString("latin1", 0, keyEnd))) return [];
    let body = data.subarray(keyEnd + 1);
    if (type === "zTXt") {
      expect(body[0]).toBe(0);
      body = inflateSync(body.subarray(1));
    } else if (type === "iTXt") {
      const languageEnd = body.indexOf(0, 2);
      const nameEnd = body.indexOf(0, languageEnd + 1);
      expect(languageEnd).toBeGreaterThanOrEqual(2);
      expect(nameEnd).toBeGreaterThan(languageEnd);
      body = body[0] === 1 ? inflateSync(body.subarray(nameEnd + 1)) : body.subarray(nameEnd + 1);
    }
    const encoded = body.toString("utf8").trim();
    return [encoded.startsWith("<") ? encoded : decodeURIComponent(encoded)];
  });
}

function recoveredGraph(xml: string) {
  const root = parseXml(xml).documentElement!;
  if (root.tagName === "mxGraphModel") return root;
  const diagram = root.tagName === "diagram" ? root : nodes(root, "diagram")[0];
  expect(diagram, "embedded file must contain a diagram").toBeDefined();
  const [uncompressed] = nodes(diagram, "mxGraphModel");
  return uncompressed ?? parseXml(decodeURIComponent(inflateRawSync(Buffer.from(diagram.textContent!.trim(), "base64")).toString("utf8"))).documentElement!;
}

async function attachedPng(result: Result, path: string) {
  expect(result.details).toMatchObject({ imageAttached: true });
  const image = result.content.find((block) => block.type === "image");
  expect(image?.mimeType).toBe("image/png");
  const bytes = Buffer.from(image!.data, "base64");
  expect(bytes.equals(await readFile(path)), "attachment must be the published PNG bytes").toBe(true);
  return bytes;
}

function reviewRaster(bytes: Buffer) {
  const image = png(bytes);
  expect(Math.max(image.width, image.height)).toBeLessThanOrEqual(MAX_REVIEW_SIDE);
  expect(image.width * image.height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
  expect(editablePayloads(image)).toEqual([]);
  return image;
}

function paeth(left: number, up: number, upperLeft: number) {
  const p = left + up - upperLeft;
  const dl = Math.abs(p - left), du = Math.abs(p - up), dul = Math.abs(p - upperLeft);
  return dl <= du && dl <= dul ? left : du <= dul ? up : upperLeft;
}

/** Scan reconstructed RGB(A) scanlines, not compressed bytes or fixture XML. */
function pixelCounts({ chunks, header, width, height }: ReturnType<typeof png>, colors: number[]) {
  const depth = header[8], type = header[9];
  expect(depth).toBe(8);
  expect([2, 6]).toContain(type);
  expect(header[12], "stock desktop output must be noninterlaced for this scan").toBe(0);
  const stride = type === 6 ? 4 : 3;
  const rowSize = width * stride + 1;
  const raster = inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data)), {
    maxOutputLength: rowSize * height,
  });
  expect(raster.length).toBe(rowSize * height);
  const counts = new Map(colors.map((color) => [color, 0]));
  for (let row = 0; row < height; row++) {
    const start = row * rowSize;
    const filter = raster[start];
    if (filter > 4) throw new Error(`unknown PNG scanline filter ${filter}`);
    for (let col = 0; col < width * stride; col++) {
      const pos = start + col + 1;
      const left = col >= stride ? raster[pos - stride] : 0;
      const up = row ? raster[pos - rowSize] : 0;
      const upperLeft = row && col >= stride ? raster[pos - rowSize - stride] : 0;
      if (filter === 1) raster[pos] += left;
      else if (filter === 2) raster[pos] += up;
      else if (filter === 3) raster[pos] += (left + up) >>> 1;
      else if (filter === 4) raster[pos] += paeth(left, up, upperLeft);
    }
    for (let col = 0; col < width; col++) {
      const pixel = start + col * stride + 1;
      if (stride === 4 && raster[pixel + 3] !== 255) continue;
      const color = raster.readUIntBE(pixel, 3);
      const previous = counts.get(color);
      if (previous !== undefined) counts.set(color, previous + 1);
    }
  }
  return colors.map((color) => counts.get(color)!);
}

function standaloneLogoRefs(svg: string) {
  const root = parseXml(svg).documentElement!;
  return [...nodes(root, "image"), ...nodes(root, "img")].flatMap((image) => [
    image.getAttribute("href"), image.getAttributeNS(XLINK, "href"), image.getAttribute("src"),
  ].filter(Boolean) as string[]);
}

const motionSteps = (id: string) => [{ effect: "highlight", cells: [id], duration: 400 }];

it("registers width, not height, for public export dimensions", () => {
  const { pi, tools } = makeMockPi();
  drawme(pi as never);
  const schema = tools.get("drawio_export")!.parameters.properties;
  expect(schema).toHaveProperty("width.type", "number");
  expect(schema).not.toHaveProperty("height");
});

describe("stock draw.io artifact contracts", async () => {
  const cli = await resolveBinary();
  const native = it.runIf(cli.available);

  native("recovers the expected editable graph and cell labels from a final native PNG", async () => {
    const graph = model(node("receive", "Apricot Beacon", 80, 70, 160, 80) +
      node("ship", "Cobalt Compass", 320, 70, 160, 80) + link("pipeline", "receive", "ship"));
    const f = await fixture(document(page("editable", graph)));
    const result = await f.call("drawio_export", { input: f.input, mode: "final" });
    succeeded(result, /^Exported /);
    const output = f.path("map.drawio.png");
    expect(result.details).toMatchObject({ output, format: "png", embed: true });
    expect((await stat(output)).isFile()).toBe(true);
    const payloads = editablePayloads(png(await readFile(output)));
    expect(payloads, "the renderer must actually embed editable XML in the final PNG").toHaveLength(1);
    const recovered = cells(recoveredGraph(payloads[0]));
    expect(recovered.get("receive")?.getAttribute("value")).toBe("Apricot Beacon");
    expect(recovered.get("ship")?.getAttribute("value")).toBe("Cobalt Compass");
    expect(recovered.get("pipeline")?.getAttribute("source")).toBe("receive");
    expect(recovered.get("pipeline")?.getAttribute("target")).toBe("ship");
  }, NATIVE_TIMEOUT);

  native.each([
    { name: "default portrait", width: 200, height: 800, options: {}, longSide: 2000 },
    { name: "default landscape", width: 800, height: 200, options: {}, longSide: 2000 },
    { name: "oversized explicit width with embedding requested", width: 240, height: 720, options: { width: 2600, embed: true }, longSide: 2000 },
    { name: "explicit width within budget", width: 800, height: 200, options: { width: 920 }, longSide: 920 },
  ])("attaches bounded unembedded PNG bytes for $name", async ({ width, height, options, longSide }) => {
    const f = await fixture(document(page("ratio", model(node("figure", "Ratio", 45, 50, width, height)))));
    const result = await f.call("drawio_export", { input: f.input, mode: "preview", border: 40, ...options });
    succeeded(result, /^Exported /);
    const output = f.path("map.preview.png");
    expect(result.details).toMatchObject({ output, format: "png", embed: false });
    const bytes = await attachedPng(result, output);
    expect(result.details).toMatchObject({ previewReceipt: {
      source: await realpath(f.path(f.input)), pageIndex: 1, sha256: createHash("sha256").update(bytes).digest("hex"),
    } });
    const actual = reviewRaster(bytes);
    expect(Math.abs(Math.max(actual.width, actual.height) - longSide)).toBeLessThanOrEqual(4);
    const scaledBy = (Math.max(actual.width, actual.height) - 80) / Math.max(width, height);
    expect(Math.abs(Math.min(actual.width, actual.height) - (Math.min(width, height) * scaledBy + 80))).toBeLessThanOrEqual(4);
    expect(actual.width > actual.height).toBe(width > height);
  }, NATIVE_TIMEOUT);

  native("caps a large final PNG below the uncapped scale request in actual pixels", async () => {
    const f = await fixture(document(page("large", model(node("large", "Large graph", 30, 30, 1800, 1500)))));
    const result = await f.call("drawio_export", { input: f.input, output: "large.png", scale: 2, embed: false, border: 0 });
    succeeded(result, /^Exported /);
    const { width, height } = png(await readFile(f.path("large.png")));
    expect(width).toBeLessThan(3600);
    expect(height).toBeLessThan(3000);
    expect(width * height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    expect(width * height).toBeGreaterThan(5_700_000);
    expect(Math.abs(width / height - 1800 / 1500)).toBeLessThan(0.005);
  }, NATIVE_TIMEOUT);

  native("publishes JPEG bytes under the JPEG alias and never claims they are editable or attached", async () => {
    const f = await fixture(document(page("jpeg", smallGraph)));
    const request = { input: f.input, output: "picture.jpeg", format: "jpg", width: 500 };
    const result = await f.call("drawio_export", request);
    succeeded(result, /^Exported /);
    const output = f.path(request.output);
    expect(result.details).toMatchObject({ output, format: "jpg", embed: false, imageAttached: false });
    expect(result.content.every((block) => block.type === "text")).toBe(true);
    const original = await readFile(output);
    expect(original.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(original.subarray(-2).toString("hex")).toBe("ffd9");
    const editable = await f.call("drawio_export", { ...request, embed: true });
    expect(text(editable)).toMatch(/^Export failed:.*JPG cannot embed/i);
    expect((await readFile(output)).equals(original)).toBe(true);
  }, NATIVE_TIMEOUT);

  native("renders the selected SVG page and adds padding outside the requested width", async () => {
    const f = await fixture(document(page("first", smallGraph), otherPage));
    const exportPage = async (output: string, pageIndex: number, border: number) => {
      const result = await f.call("drawio_export", { input: f.input, output, format: "svg", embed: false, width: 500, pageIndex, border });
      succeeded(result, /^Exported /);
      expect(result.details).toMatchObject({ output: f.path(output), format: "svg" });
      return parseXml(await readFile(f.path(output), "utf8")).documentElement!;
    };
    const zero = await exportPage("bare.svg", 1, 0);
    const padded = await exportPage("padded.svg", 1, 40);
    const second = await exportPage("second.svg", 2, 0);
    for (const root of [zero, padded]) {
      expect(root.localName).toBe("svg");
      expect(root.textContent).toContain("Apricot Beacon");
      expect(root.textContent).not.toContain("Cobalt Compass");
    }
    expect(second.textContent).toContain("Cobalt Compass");
    expect(second.textContent).not.toContain("Apricot Beacon");
    const width = (root: Element) => Number.parseFloat(root.getAttribute("width") ?? "");
    const viewSize = (root: Element) => root.getAttribute("viewBox")!.split(/\s+/).map(Number).slice(2);
    expect(Math.abs(width(zero) - 500)).toBeLessThanOrEqual(1);
    expect(width(padded) - width(zero)).toBeCloseTo(80);
    const [w, h] = viewSize(zero);
    expect(viewSize(padded)).toEqual([w + 80, h + 80]);
  }, NATIVE_TIMEOUT);

  native("publishes an extensionless PDF file with the authored print page MediaBox", async () => {
    const f = await fixture(document(page("print", smallGraph)));
    const output = f.path("report");
    const result = await f.call("drawio_export", { input: f.input, output: "report", format: "pdf", border: 0 });
    succeeded(result, /^Exported /);
    expect(result.details).toMatchObject({ output, format: "pdf" });
    expect((await stat(output)).isFile()).toBe(true);
    const pdf = await readFile(output, "latin1");
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    const boxes = [...pdf.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)];
    expect(boxes).toHaveLength(1);
    const [x0, y0, x1, y1] = boxes[0][1].trim().split(/\s+/).map(Number);
    // draw.io print page units are 1/100 inch, while PDF points are 1/72 inch.
    expect(Math.abs(x1 - x0 - 800 * 72 / 100)).toBeLessThanOrEqual(2);
    expect(Math.abs(y1 - y0 - 600 * 72 / 100)).toBeLessThanOrEqual(2);
  }, NATIVE_TIMEOUT);

  native("refuses invalid pages, conflicting suffixes and directory destinations without altering files", async () => {
    const source = document(page("first", smallGraph), otherPage);
    const f = await fixture(source);
    const previous = "previous artifact must survive";
    await mkdir(f.path("directory"));
    await Promise.all(["page.svg", "mismatch.jpeg", join("directory", "keep.pdf")].map((path) => writeFile(f.path(path), previous)));
    for (const pageIndex of [0, 1.9, 3]) {
      const result = await f.call("drawio_export", { input: f.input, output: "page.svg", format: "svg", pageIndex });
      const diagnostic = pageIndex === 3 ? /^Export failed:.*page.*out of range/i : /^Export failed:.*page.*positive integer/i;
      expect(text(result)).toMatch(diagnostic);
      expect(await readFile(f.path("page.svg"), "utf8")).toBe(previous);
    }
    const conflict = await f.call("drawio_export", { input: f.input, output: "mismatch.jpeg", format: "png" });
    expect(text(conflict)).toMatch(/^Export failed:.*suffix.*PNG/i);
    expect(await readFile(f.path("mismatch.jpeg"), "utf8")).toBe(previous);
    const directory = await f.call("drawio_export", { input: f.input, output: "directory", format: "pdf" });
    expect(text(directory)).toMatch(/^Export failed:.*destination.*not a regular file/i);
    expect(await readdir(f.path("directory"))).toEqual(["keep.pdf"]);
    expect(await readFile(f.path(join("directory", "keep.pdf")), "utf8")).toBe(previous);
    expect(await readFile(f.path(f.input), "utf8")).toBe(source);
  }, NATIVE_TIMEOUT);

  it.runIf(cli.available && Boolean(cli.supportsLayout))("lays out overlapping vertices but keeps settings, terminals and the other page", async () => {
    const authoredSettings = 'page="1" pageWidth="640" pageHeight="480" pageScale="1" background="#18243A"';
    const graph = model(node("start", "Receive", 50, 50, 150, 80) + node("end", "Publish", 60, 55, 150, 80) + link("route", "start", "end"), authoredSettings);
    const source = document(page("first", graph), otherPage);
    const f = await fixture(source);
    const result = await f.call("drawio_layout", { input: f.input, preset: "horizontalFlow" });
    succeeded(result, /^Laid out /);
    const output = f.path("map.layout.drawio");
    expect(result.details).toMatchObject({ output, preset: "horizontalFlow" });
    expect(await readFile(f.path(f.input), "utf8")).toBe(source);
    const [first, second] = nodes(parseXml(await readFile(output, "utf8")).documentElement!, "diagram");
    expect(new XMLSerializer().serializeToString(second)).toBe(otherPage);
    const [laidOut] = nodes(first, "mxGraphModel");
    for (const [key, value] of Object.entries({ page: "1", pageWidth: "640", pageHeight: "480", pageScale: "1", background: "#18243A" })) {
      expect(laidOut.getAttribute(key), key).toBe(value);
    }
    const placed = cells(laidOut);
    expect([...placed.keys()].sort()).toEqual(["0", "1", "end", "route", "start"]);
    expect(placed.get("route")?.getAttribute("source")).toBe("start");
    expect(placed.get("route")?.getAttribute("target")).toBe("end");
    expect(placed.get("start")?.getAttribute("value")).toBe("Receive");
    expect(placed.get("end")?.getAttribute("value")).toBe("Publish");
    const [start] = nodes(placed.get("start")!, "mxGeometry");
    const [end] = nodes(placed.get("end")!, "mxGeometry");
    expect(Number(end.getAttribute("x")) - Number(start.getAttribute("x"))).toBeGreaterThanOrEqual(150);
  }, NATIVE_TIMEOUT);

  it.runIf(cli.available && Boolean(cli.supportsMermaid))("converts, fits, validates, previews and exports a finite Mermaid diagram", async () => {
    const f = await fixture(document(page("source", smallGraph)));
    const input = "import.drawio";
    const result = await f.call("drawio_from_mermaid", { mermaid: "flowchart LR\n  A[Native Start] --> B[Native Finish]", output: input });
    succeeded(result, /^Converted Mermaid/);
    expect(result.details).toMatchObject({ output: f.path(input) });
    const graph = () => readFile(f.path(input), "utf8").then((xml) => nodes(parseXml(xml).documentElement!, "mxGraphModel")[0]);
    expect((await graph()).getAttribute("page")).toBe("1");
    const fit = await f.call("drawio_fit_canvas", { input, margin: 40 });
    expect(fit.details).toMatchObject({ changed: true, output: f.path(input) });
    const fitted = await graph();
    const imported = cells(fitted);
    const edge = [...imported.values()].find((cell) => cell.getAttribute("edge") === "1")!;
    const from = imported.get(edge.getAttribute("source"))!;
    const to = imported.get(edge.getAttribute("target"))!;
    expect(label(from)).toBe("Native Start");
    expect(label(to)).toBe("Native Finish");
    expect(fitted.getAttribute("page")).toBe("1");
    for (const [axis, size, extent] of [["x", "width", "pageWidth"], ["y", "height", "pageHeight"]]) {
      const rects = [from, to].map((cell) => nodes(cell, "mxGeometry")[0]);
      const low = Math.min(...rects.map((rect) => Number(rect.getAttribute(axis))));
      const high = Math.max(...rects.map((rect) => Number(rect.getAttribute(axis)) + Number(rect.getAttribute(size))));
      expect(low).toBeCloseTo(40);
      expect(Number(fitted.getAttribute(extent)) - high).toBeCloseTo(40, 0);
    }
    const validated = await f.call("drawio_validate", { input });
    expect(validated.details).toMatchObject({ errors: [] });
    const preview = await f.call("drawio_export", { input, mode: "preview" });
    succeeded(preview, /^Exported /);
    reviewRaster(await attachedPng(preview, f.path("import.preview.png")));
    const final = await f.call("drawio_export", { input, format: "svg", embed: false });
    succeeded(final, /^Exported /);
    expect(parseXml(await readFile(f.path("import.svg"), "utf8")).documentElement!.textContent).toContain("Native Finish");
  }, NATIVE_TIMEOUT);

  native("renders only visible storyboard pixels and retains separate page boards and attachments", async () => {
    const visibleStyle = "fillColor=#22c55e;strokeColor=none;";
    const hiddenStyle = "fillColor=#ff00aa;strokeColor=none;";
    const first = model(node("active", "Visible draft control", 80, 65, 180, 580, visibleStyle) +
      '<mxCell id="draft-layer" parent="0" visible="0"/>' +
      node("draft", "Hidden draft", 300, 120, 160, 350, hiddenStyle, "draft-layer"));
    const secondPage = page("pink-control", model(node("pink", "Visible pink control", 88, 76, 180, 90, hiddenStyle)));
    const f = await fixture(document(page("board", first), secondPage));
    const animate = (pageIndex: number, output: string, id: string) => f.call("drawio_animate", {
      input: f.input, pageIndex, output, steps: motionSteps(id),
    });
    const one = await animate(1, "one.animated.svg", "active");
    succeeded(one, /^Animated .*\nAnimation verified:/);
    const boardOne = f.path("one.storyboard.png");
    expect(one.details).toMatchObject({ storyboard: boardOne, storyboardFrames: 1 });
    const original = await attachedPng(one, boardOne);
    const [green, pink] = pixelCounts(reviewRaster(original), [0x22c55e, 0xff00aa]);
    expect(green, "visible control fill must actually be rendered").toBeGreaterThan(100);
    expect(pink, "effectively hidden layer must not contribute draft pixels").toBe(0);
    const two = await animate(2, "two.cut.svg", "pink");
    succeeded(two, /^Animated .*\nAnimation verified:/);
    const boardTwo = f.path("two.cut.svg.storyboard-p2.png");
    expect(two.details).toMatchObject({ storyboard: boardTwo, storyboardFrames: 1 });
    const second = await attachedPng(two, boardTwo);
    const [visiblePink] = pixelCounts(reviewRaster(second), [0xff00aa]);
    expect(visiblePink, "the draft color must be detectable when visible").toBeGreaterThan(100);
    expect(second.equals(original), "second board must be a distinct render").toBe(false);
    expect((await readFile(boardOne)).equals(original), "second render must not overwrite the first board").toBe(true);
  }, NATIVE_TIMEOUT);

  native("reuses stored motion with a local logo only if the native SVG is standalone", async () => {
    // draw.io supports non-HTML image shapes; put the actual local operand in the style.
    const f = await fixture(document(page("logo", smallGraph)));
    const logo = f.path("logo.png");
    await writeFile(logo, Buffer.from(TINY_PNG, "base64"));
    const spec = JSON.stringify({ steps: motionSteps("first-id") }).replaceAll('"', "&quot;");
    const authored = (reference: string) => document(page("logo", model(node("first-id", "Logo target", 90, 100, 90, 90,
      `shape=image;image=${reference};aspect=fixed;`)).replace('<mxCell id="0"/>', `<mxCell id="0" drawmeMotion="${spec}"/>`)));
    // Positive native image control: silently dropping the whole logo isn't an acceptable success.
    await writeFile(f.path(f.input), authored(EMBEDDED_LOGO.replace(";base64", "")));
    const preview = await f.call("drawio_animate", { input: f.input, output: "inline.svg", storyboard: false });
    succeeded(preview, /^Animated .*\nAnimation verified:/);
    const inline = standaloneLogoRefs(await readFile(f.path("inline.svg"), "utf8"));
    expect(inline.length, "embedded control logo must survive the native renderer").toBeGreaterThan(0);
    for (const ref of inline) expect(ref).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/i);

    await writeFile(f.path(f.input), authored(pathToFileURL(logo).href));
    const output = f.path("local.svg");
    const result = await f.call("drawio_animate", { input: f.input, output: "local.svg", storyboard: false });
    if (text(result).startsWith("Animate failed:")) {
      expect(text(result)).toMatch(/unresolved image resource.*embed images as data URLs/i);
      expect(text(result)).not.toContain("Animation verified:");
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      succeeded(result, /^Animated .*\nAnimation verified:/);
      await rm(logo);
      const refs = standaloneLogoRefs(await readFile(output, "utf8"));
      expect(refs.length, "a standalone success must not discard the local logo").toBeGreaterThan(0);
      for (const ref of refs) expect(ref).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/i);
    }
  }, NATIVE_TIMEOUT);
});

const linuxRoot = process.platform === "linux" && (process.getuid?.() === 0 || process.geteuid?.() === 0);
describe.skipIf(linuxRoot)("responsive XHTML candidates at the staged animated SVG boundary", () => {
  installRendererFixtureAdapter();

  it("retains embedded srcset candidates but refuses a local candidate without replacing the prior SVG", async () => {
    const f = await fixture(document(page("responsive", smallGraph)));
    await writeFile(f.path("logo.png"), Buffer.from(TINY_PNG, "base64"));
    const svg = (candidate: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px"><g data-cell-id="first-id">
      <rect width="160" height="80"/><foreignObject width="64" height="64"><picture xmlns="http://www.w3.org/1999/xhtml">
      <img src="${EMBEDDED_LOGO}" srcset="${EMBEDDED_LOGO} 1x, ${candidate} 2x"/>
      </picture></foreignObject></g></svg>`;
    const binary = await writeRendererFixture(f.dir, `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('32.4.1');
else {
  const out = args.indexOf('-o');
  const linked = args[out + 2].endsWith('linked.drawio');
  writeFileSync(args[out + 1], linked ? ${JSON.stringify(svg("./logo.png"))} : ${JSON.stringify(svg(EMBEDDED_LOGO))});
}`);
    vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
    const request = { input: f.input, output: "responsive.svg", storyboard: false, steps: motionSteps("first-id") };
    const good = await f.call("drawio_animate", request);
    succeeded(good, /^Animated .*\nAnimation verified:/);
    expect(good.details).toMatchObject({ binary, output: f.path(request.output) });
    const original = await readFile(f.path(request.output), "utf8");
    const [img] = nodes(parseXml(original).documentElement!, "img");
    expect(img.getAttribute("srcset")).toBe(`${EMBEDDED_LOGO} 1x, ${EMBEDDED_LOGO} 2x`);
    await writeFile(f.path("linked.drawio"), document(page("responsive", smallGraph)));
    const bad = await f.call("drawio_animate", { ...request, input: "linked.drawio" });
    expect(text(bad)).toMatch(/^Animate failed:.*unresolved image resource.*embed images as data URLs/i);
    expect(text(bad)).not.toContain("Animation verified:");
    expect(await readFile(f.path(request.output), "utf8")).toBe(original);
  }, NATIVE_TIMEOUT);
});
