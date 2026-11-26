import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { existsSync } from "node:fs";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { afterEach, expect, it, vi } from "vitest";
import { animateDiagram } from "../src/animate";
import * as intake from "../src/diagram-files";
import type { DomEl } from "../src/dom";
import { exportDiagram } from "../src/drawio";
import { fitCanvasFile } from "../src/fitcanvas";
import { readStoredMotion, selectPage } from "../src/motion";
import { buildStoryboard } from "../src/storyboard";
import { TINY_PNG } from "./fixtures";
import { installRendererFixtureAdapter, writeRendererFixture } from "./renderer-fixture";

installRendererFixtureAdapter();

const paths: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const vertex = (id: string, parent = "1") => `<mxCell id="${id}" parent="${parent}" vertex="1"><mxGeometry x="90" y="60" width="100" height="50" as="geometry"/></mxCell>`;
const graph = (cells: string) => `<mxGraphModel page="1" pageWidth="600" pageHeight="500"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;
const diagram = `<mxfile><diagram name="A">${graph(vertex("a"))}</diagram><diagram name="B">${graph(vertex("b"))}</diagram></mxfile>`;
const steps = (id: string) => [{ effect: "fadeIn", cells: [id], duration: 200 }];

function model(xml: string, page = 1) {
  const root = new DOMParser().parseFromString(xml, "text/xml").documentElement as unknown as DomEl;
  return selectPage(root, page).model;
}

async function fixture(boardBehavior?: "pause" | "fail") {
  const dir = await mkdtemp(join(tmpdir(), "drawme transaction "));
  paths.push(dir);
  const input = join(dir, "map.svg.drawio");
  const release = join(dir, "release");
  const ready = join(dir, "board ready.json");
  await writeFile(input, diagram);
  const binary = await writeRendererFixture(dir, `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { crc32 } from 'node:zlib';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('32.4.1'); process.exit(0); }
const out = args.indexOf('-o');
const input = args[out + 2];
const output = args[out + 1];
const xml = readFileSync(input, 'utf8');
if (args[args.indexOf('-f') + 1] === 'svg') {
  const id = args[args.indexOf('--page-index') + 1] === '2' ? 'b' : 'a';
  if (!xml.includes('id="' + id + '"')) process.exit(2);
  writeFileSync(output, '<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px"><g data-cell-id="' + id + '"><rect width="80" height="40"/></g></svg>');
} else {
  const board = basename(input).startsWith('.drawme-storyboard-');
  if (board && ${boardBehavior === "fail"}) process.exit(7);
  if (board && ${boardBehavior === "pause"}) {
    writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ input, pid: process.pid }));
    while (!existsSync(${JSON.stringify(release)})) await setTimeout(10);
  }
  const png = Buffer.from('${TINY_PNG}', 'base64');
  const data = Buffer.from('Board\\0' + (xml.includes('id="f1-b"') ? 'B' : 'A'));
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write('tEXt', 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  writeFileSync(output, board ? Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]) : png);
}
`);
  return { dir, input, binary, release: () => writeFile(release, ""), ready };
}

async function runningBoard(ready: string): Promise<{ input: string; pid: number }> {
  return vi.waitFor(async () => JSON.parse(await readFile(ready, "utf8")), { timeout: 3000 });
}

it("queues the second page save behind the entire board render and preserves both pages and a following in-place fit", async () => {
  const { dir, input, binary, release, ready } = await fixture("pause");
  const firstOutput = join(dir, "first.svg");
  const secondOutput = join(dir, "second.svg");
  const controller = new AbortController();
  const first = animateDiagram({ input, binary, steps: steps("a"), output: firstOutput });
  const pending: Promise<unknown>[] = [first];
  try {
    const child = await runningBoard(ready);
    expect(dirname(child.input)).toBe(dirname(input));
    const before = await readFile(input, "utf8");
    const second = animateDiagram({ input, binary, pageIndex: 2, steps: steps("b"), output: secondOutput, storyboard: false, signal: controller.signal });
    pending.push(second);
    await vi.waitFor(() => expect(getEventListeners(controller.signal, "abort")).toHaveLength(1));
    const fit = fitCanvasFile({ input, margin: 23 });
    pending.push(fit);
    expect(await readFile(input, "utf8")).toBe(before);
    expect(existsSync(firstOutput)).toBe(false);
    await release();
    await expect(first).resolves.toMatchObject({ saved: true, page: "A", output: firstOutput });
    await expect(second).resolves.toMatchObject({ saved: true, page: "B", output: secondOutput });
    await expect(fit).resolves.toMatchObject({ changed: true });
    const updated = await readFile(input, "utf8");
    expect(JSON.parse(readStoredMotion(model(updated))!)).toMatchObject({ steps: steps("a") });
    expect(JSON.parse(readStoredMotion(model(updated, 2))!)).toMatchObject({ steps: steps("b") });
    expect(updated.match(/x="23" y="23"/g)).toHaveLength(2);
    expect(await readFile(firstOutput, "utf8")).toContain('data-cell-id="a"');
    expect(await readFile(secondOutput, "utf8")).toContain('data-cell-id="b"');
  } finally {
    await release();
    await Promise.allSettled(pending);
  }
});

it("blocks a different input from replacing an aliased animation source until release, then keeps the replacement", async () => {
  const { dir, input, binary, release, ready } = await fixture("pause");
  const alias = join(dir, "hard link.drawio");
  const replacement = join(dir, "replacement.drawio");
  const control = join(dir, "replacement control.drawio");
  await link(input, alias);
  await writeFile(replacement, graph(vertex("replacement")));
  await fitCanvasFile({ input: replacement, output: control });
  const first = animateDiagram({ input, binary, steps: steps("a") });
  let replace: Promise<unknown> | undefined;
  try {
    await runningBoard(ready);
    const before = await readFile(input);
    // Observe reservation of the real fit transaction without changing its action.
    const controller = new AbortController();
    const lock = intake.withDiagramFiles;
    vi.spyOn(intake, "withDiagramFiles").mockImplementation((keys, signal, action) =>
      lock(keys, keys.includes(alias) ? controller.signal : signal, action));
    replace = fitCanvasFile({ input: replacement, output: alias });
    await vi.waitFor(() => expect(getEventListeners(controller.signal, "abort")).toHaveLength(1));
    expect(await readFile(alias)).toEqual(before);
    await release();
    await expect(first).resolves.toMatchObject({ saved: true });
    await expect(replace).resolves.toMatchObject({ changed: true });
    expect(await readFile(input)).toEqual(await readFile(control));
    expect(await readFile(alias)).toEqual(await readFile(control));
  } finally {
    await release();
    await Promise.allSettled([first, replace]);
  }
});

it("cancels the running storyboard child without publishing either artifact or retiring the previous preview", async () => {
  const { dir, input, binary, release, ready } = await fixture("pause");
  const output = join(dir, "deliverable.animated.svg");
  const board = join(dir, "deliverable.storyboard.png");
  await writeFile(output, "prior SVG");
  await writeFile(board, "prior board");
  const preview = await exportDiagram({ input, binary, mode: "preview" });
  const priorPreview = await readFile(preview.output);
  const controller = new AbortController();
  const result = animateDiagram({ input, binary, steps: steps("a"), output, signal: controller.signal });
  // Observe the rejection immediately, even when assertions fail during teardown.
  const outcome = result.catch((error: unknown) => error);
  try {
    const child = await runningBoard(ready);
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(await readFile(output, "utf8")).toBe("prior SVG");
    expect(await readFile(board, "utf8")).toBe("prior board");
    expect(await readFile(preview.output)).toEqual(priorPreview);
    expect(existsSync(child.input)).toBe(false);
    expect(readStoredMotion(model(await readFile(input, "utf8")))).not.toBeNull();
    await release();
    const next = await animateDiagram({ input, binary, output });
    expect(next).toMatchObject({ output, storyboard: board, saved: false });
    expect(existsSync(preview.output)).toBe(false);
  } finally {
    controller.abort();
    await release();
    await outcome;
  }
});

it("keeps a valid source save on a later renderer failure without replacing the prior artifacts", async () => {
  const { dir, input, binary } = await fixture("fail");
  const output = join(dir, "final.animated.svg");
  const board = join(dir, "final.storyboard.png");
  await writeFile(output, "prior SVG");
  await writeFile(board, "prior board");
  await expect(animateDiagram({ input, binary, output, steps: steps("a") })).rejects.toThrow(/draw.io export failed:.*code 7/);
  expect(JSON.parse(readStoredMotion(model(await readFile(input, "utf8")))!)).toMatchObject({ steps: steps("a") });
  expect(await readFile(output, "utf8")).toBe("prior SVG");
  expect(await readFile(board, "utf8")).toBe("prior board");
});

it("rejects invalid new and stored hold overrides before writing and accepts a valid override", async () => {
  const { input, binary } = await fixture();
  const first = await animateDiagram({ input, binary, steps: steps("a"), storyboard: false });
  const source = await readFile(input);
  const svg = await readFile(first.output);
  for (const hold of [-1, 60_001]) {
    for (const motion of [undefined, steps("a")]) {
      await expect(animateDiagram({ input, binary, hold, steps: motion })).rejects.toThrow(/motion hold must be between/);
      expect(await readFile(input)).toEqual(source);
      expect(await readFile(first.output)).toEqual(svg);
    }
  }
  await expect(animateDiagram({ input, binary, hold: 60_000, storyboard: false })).resolves.toMatchObject({
    saved: true, durationMs: 60_200,
  });
});

it("rejects visually static motion without modifying the source or prior SVG, independent of storyboard setting", async () => {
  const { dir, input, binary } = await fixture();
  const output = join(dir, "final.svg");
  await writeFile(output, "prior SVG");
  for (const storyboard of [true, false]) {
    for (const steps of [[{ effect: "wait", duration: 200 }], [{ effect: "dim", cells: ["a"], value: 1 }]]) {
      await expect(animateDiagram({ input, binary, output, steps, storyboard })).rejects.toThrow("no effective visual motion");
    }
  }
  expect(await readFile(input, "utf8")).toBe(diagram);
  expect(await readFile(output, "utf8")).toBe("prior SVG");
  expect(existsSync(join(dir, "final.svg.storyboard-p1.png"))).toBe(false);
});

it("keeps distinct reviewed boards across pages and dotted SVG names, with the committed byte digest", async () => {
  const { dir, input, binary } = await fixture();
  const implicit = join(dir, "map.svg.animated.svg");
  const explicit = join(dir, "map.svg");
  const variants = [
    { page: 2, output: undefined, svg: implicit, board: "map.svg.animated.svg.storyboard-p2.png" },
    { page: 2, output: explicit, svg: explicit, board: "map.svg.storyboard-p2.png" },
    { page: 1, output: implicit, svg: implicit, board: "map.svg.storyboard.png" },
  ];
  const boards = new Map<string, Buffer>();
  for (const { page, output, svg, board } of variants) {
    const result = await animateDiagram({ input, binary, output, pageIndex: page, steps: steps(page === 1 ? "a" : "b") });
    const path = join(dir, board);
    expect(result).toMatchObject({ output: svg, storyboard: path });
    const bytes = await readFile(path);
    expect(result.storyboardSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    for (const [oldBoard, oldBytes] of boards) expect(await readFile(oldBoard)).toEqual(oldBytes);
    boards.set(path, bytes);
  }
  expect(boards.get(join(dir, variants[0].board))).not.toEqual(boards.get(join(dir, variants[2].board)));
});

it("keeps a persistent board when its name supersedes a tracked preview", async () => {
  const { dir, input, binary } = await fixture();
  const output = join(dir, "shared.animated.svg");
  const board = join(dir, "shared.storyboard.png");
  await exportDiagram({ input, binary, mode: "preview", output: board });
  const result = await animateDiagram({ input, binary, output, steps: steps("a") });
  expect(result.storyboard).toBe(board);
  const bytes = await readFile(board);
  expect(result.storyboardSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  await exportDiagram({ input, binary, mode: "preview" });
  await exportDiagram({ input, binary, mode: "final", embed: false });
  expect(await readFile(board)).toEqual(bytes);
});

it("omits authored-hidden layer descendants and remaps frame/caption collisions and all surviving references", () => {
  const hidden = '<mxCell id="draft-layer" parent="0" visible="0"/>' + vertex("draft", "draft-layer") + vertex("child", "draft");
  const edge = (id: string, target: string) => `<mxCell id="${id}" edge="1" parent="1" source="frame" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
  const source = graph(hidden + vertex("frame") + vertex("frame-2") + vertex("caption", "frame") + edge("edge", "caption") + edge("hidden-link", "draft"));
  const frames = [0, 1].map(time => ({ time, label: "Review", opacity: new Map([["caption", 0]]), accent: new Map<string, string>() }));
  const board = buildStoryboard(model(source), frames);
  expect(board).not.toMatch(/draft|hidden-link|f[12]-child/);
  const dom = new DOMParser().parseFromString(board, "text/xml");
  const cells = Array.from(dom.getElementsByTagName("mxCell"));
  const byId = new Map(cells.map(cell => [cell.getAttribute("id"), cell]));
  expect(byId.size).toBe(cells.length);
  for (const prefix of ["f1-", "f2-"]) {
    expect(byId.has(prefix + "frame-2")).toBe(true);
    const connector = byId.get(prefix + "edge")!;
    const sourceId = connector.getAttribute("source");
    const targetId = connector.getAttribute("target");
    expect(sourceId).not.toBe(prefix + "frame");
    expect(targetId).not.toBe(prefix + "caption");
    expect(byId.get(targetId)?.getAttribute("parent")).toBe(sourceId);
    expect(byId.get(targetId)?.getAttribute("style")).toContain("opacity=0");
    expect(byId.get(sourceId)?.getAttribute("parent")).toBe("1");
  }
});
