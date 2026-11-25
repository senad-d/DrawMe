import { link, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DOMParser, XMLSerializer, type Document, type Element } from "@xmldom/xmldom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fitCanvasFile } from "../src/fitcanvas";
import { applyLayout, convertMermaid } from "../src/import-layout";
import { DEFAULT_MAX_XML_BYTES } from "../src/xml-input";
import { installNodeRendererFixture } from "./fixtures";

const AUTHORED = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="authored" custom="keep file metadata">
  <diagram id="first" name="Dark page" custom="keep page metadata">
    <mxGraphModel page="1" pageWidth="640" pageHeight="480" pageScale="2" background="#172033" grid="0">
      <root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <UserObject id="a" label="Alpha" data-kind="authored"><mxCell vertex="1" parent="1" style="fillColor=#778899;"><mxGeometry x="10" y="10" width="100" height="50" as="geometry"/></mxCell></UserObject>
        <mxCell id="b" vertex="1" parent="1" value="Bravo"><mxGeometry x="10" y="10" width="100" height="50" as="geometry"/></mxCell>
        <mxCell id="ab" edge="1" parent="1" source="a" target="b" style="rounded=0;"><mxGeometry relative="1" as="geometry"/></mxCell>
      </root>
    </mxGraphModel>
  </diagram>
  <diagram id="second" name="Keep unchanged"><mxGraphModel page="1" background="#557700"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" vertex="1" parent="1" value="Different page"><mxGeometry x="900" y="900" width="100" height="100" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram>
</mxfile>
`;

// Like the native output, this drops finite settings and rewrites styles. Deliberately
// reorder cells and flatten the wrapper so positional matching would apply the wrong geometry.
const RENDERED = `<mxfile host="Electron"><diagram id="first" name="Renderer name">
  <mxGraphModel page="0" pageWidth="850" pageHeight="1100" grid="1">
    <root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="b" vertex="1" parent="1" value="Changed"><mxGeometry x="12" y="92" width="100" height="50" as="geometry"/></mxCell>
      <mxCell id="a" vertex="1" parent="1" style="fillColor=#000000;"><mxGeometry x="12" y="12" width="100" height="50" as="geometry"/></mxCell>
      <mxCell id="ab" edge="1" parent="1" source="a" target="b" style="rounded=1;">
        <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="62" y="77"/></Array></mxGeometry>
      </mxCell>
    </root>
  </mxGraphModel>
</diagram></mxfile>`;

let dir: string;
let restoreFixture: (() => void) | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawme page preservation "));
  vi.stubEnv("DISPLAY", ":99");
  vi.stubEnv("DRAWME_DRAWIO_BINARY", undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  restoreFixture?.();
  restoreFixture = undefined;
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

async function rendererFixture(xml = RENDERED) {
  const binary = join(dir, "drawio stand-in.cjs");
  const log = join(dir, "layout-argv.json");
  await writeFile(binary, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args[0] === '--version') console.log('32.4.1');
    else {
      fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(args));
      fs.writeFileSync(args[args.indexOf('-o') + 1], ${JSON.stringify(xml)});
    }
  `);
  restoreFixture = installNodeRendererFixture([binary]);
  return { binary, log };
}

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, "text/xml");
}

function findById(root: Document | Element, tag: string, id: string): Element {
  const found = Array.from(root.getElementsByTagName(tag)).find((child) => child.getAttribute("id") === id);
  if (!found) throw new Error(`missing ${tag} ${id}`);
  return found;
}

function position(cell: Element): (string | null)[] {
  const geometry = cell.getElementsByTagName("mxGeometry").item(0)!;
  return [geometry.getAttribute("x"), geometry.getAttribute("y")];
}

it("lays out overlapping cells by ID while preserving the authored document around their geometry", async () => {
  const { binary, log } = await rendererFixture();
  vi.spyOn(process, "cwd").mockReturnValue(dir);
  const input = "-dark draft.drawio";
  const expectedOutput = "-dark draft.layout.drawio";
  await writeFile(join(dir, input), AUTHORED);
  const result = await applyLayout({ input, preset: "verticalFlow", binary });
  expect(result).toMatchObject({ output: expectedOutput, preset: "verticalFlow", version: "32.4.1" });
  const delivered = join(dir, result.output);
  expect((await stat(delivered)).isFile()).toBe(true);
  expect(await readFile(join(dir, input), "utf8")).toBe(AUTHORED);

  const args = JSON.parse(await readFile(log, "utf8"));
  const staged = args[args.indexOf("-o") + 1];
  expect(args).toEqual(["-x", "-f", "xml", "--layout", "verticalFlow", "-o", staged, join(dir, input)]);
  expect(isAbsolute(staged)).toBe(true);
  expect(staged).not.toBe(delivered);
  await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });

  const xml = await readFile(delivered, "utf8");
  expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
  const doc = parse(xml);
  expect(doc.documentElement?.getAttribute("host")).toBe("authored");
  expect(doc.documentElement?.getAttribute("custom")).toBe("keep file metadata");
  const first = findById(doc, "diagram", "first");
  const second = findById(doc, "diagram", "second");
  const serializer = new XMLSerializer();
  expect(serializer.serializeToString(second)).toBe(serializer.serializeToString(findById(parse(AUTHORED), "diagram", "second")));
  expect(first.getAttribute("name")).toBe("Dark page");
  expect(first.getAttribute("custom")).toBe("keep page metadata");
  const model = first.getElementsByTagName("mxGraphModel").item(0)!;
  expect(["page", "pageWidth", "pageHeight", "pageScale", "background", "grid"].map((key) => model.getAttribute(key)))
    .toEqual(["1", "640", "480", "2", "#172033", "0"]);

  const wrapper = findById(first, "UserObject", "a");
  const inner = wrapper.getElementsByTagName("mxCell").item(0)!;
  expect(wrapper.getAttribute("label")).toBe("Alpha");
  expect(wrapper.getAttribute("data-kind")).toBe("authored");
  expect(inner.hasAttribute("id")).toBe(false);
  expect(inner.getAttribute("style")).toBe("fillColor=#778899;");
  expect(position(inner)).toEqual(["12", "12"]);
  const b = findById(first, "mxCell", "b");
  expect(b.getAttribute("value")).toBe("Bravo");
  expect(position(b)).toEqual(["12", "92"]);
  const edge = findById(first, "mxCell", "ab");
  expect([edge.getAttribute("source"), edge.getAttribute("target"), edge.getAttribute("style")]).toEqual(["a", "b", "rounded=0;"]);
  const waypoint = edge.getElementsByTagName("mxPoint").item(0)!;
  expect([waypoint.getAttribute("x"), waypoint.getAttribute("y")]).toEqual(["62", "77"]);
});

it("retains an intentional infinite page when laying out in place through a hard link", async () => {
  const { binary } = await rendererFixture();
  const input = join(dir, "original.drawio");
  const alias = join(dir, "linked.drawio");
  await writeFile(input, AUTHORED.replace('page="1"', 'page="0"'));
  await link(input, alias);
  const inode = (await stat(input, { bigint: true })).ino;
  const result = await applyLayout({ input, output: alias, preset: "verticalFlow", binary });
  expect(result.output).toBe(alias);
  expect((await stat(alias, { bigint: true })).ino).toBe(inode);
  expect(await readFile(alias, "utf8")).toBe(await readFile(input, "utf8"));
  const doc = parse(await readFile(input, "utf8"));
  expect(position(findById(findById(doc, "diagram", "first"), "mxCell", "b"))).toEqual(["12", "92"]);
  const fitted = await fitCanvasFile({ input, output: join(dir, "fit.drawio") });
  expect(fitted.pages[0]).toMatchObject({ status: "skipped", reason: "page canvas disabled (infinite canvas)" });
});

it.each([
  { name: "ID", xml: RENDERED.replace('id="b"', 'id="c"'), reason: "layout result is missing cell ID b" },
  { name: "topology", xml: RENDERED.replace('source="a" target="b"', 'source="b" target="a"'), reason: "changed the graph topology at cell ab" },
])("leaves the editable file untouched when the native result changes $name", async ({ xml, reason }) => {
  const { binary } = await rendererFixture(xml);
  const input = join(dir, "original.drawio");
  await writeFile(input, AUTHORED);
  await expect(applyLayout({ input, output: input, preset: "verticalFlow", binary })).rejects.toThrow(reason);
  expect(await readFile(input, "utf8")).toBe(AUTHORED);
});

it("rejects oversized layout input before running the renderer", async () => {
  const { binary, log } = await rendererFixture();
  const input = join(dir, "oversized.drawio");
  await writeFile(input, AUTHORED);
  await truncate(input, DEFAULT_MAX_XML_BYTES + 1);
  await expect(applyLayout({ input, preset: "verticalFlow", binary })).rejects.toThrow("diagram XML exceeds");
  await expect(stat(log)).rejects.toMatchObject({ code: "ENOENT" });
});

it("enables the canvas on a newly converted diagram so the normal fit step resizes it", async () => {
  const { binary, log } = await rendererFixture();
  const output = join(dir, "converted.drawio");
  const converted = await convertMermaid({ mermaid: "flowchart LR\n  A --> B", output, binary });
  expect(converted).toMatchObject({ output, version: "32.4.1" });
  expect(JSON.parse(await readFile(log, "utf8"))).not.toContain("--layout");
  const fitted = await fitCanvasFile({ input: converted.output, margin: 20 });
  expect(fitted.pages).toMatchObject([{ status: "fitted", after: { width: 140, height: 170 } }]);
  const model = parse(await readFile(output, "utf8")).getElementsByTagName("mxGraphModel").item(0)!;
  expect([model.getAttribute("page"), model.getAttribute("pageWidth"), model.getAttribute("pageHeight")]).toEqual(["1", "140", "170"]);
});
