import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { DOMParser } from "@xmldom/xmldom";
import { expect, it, onTestFinished, vi } from "vitest";
import { animateDiagram } from "../src/animate";
import { fitCanvasFile } from "../src/fitcanvas";
import { invokeRenderer } from "../src/renderer";
import { withSourceEdits } from "../src/source-edits";
import { readDiagramXml } from "../src/xml-input";
import { installNodeRendererFixture, TINY_PNG } from "./fixtures";

vi.mock("../src/renderer", { spy: true });

const saveGate = vi.hoisted(() => ({
  paths: new Set<string>(),
  beforeSave: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    // Metadata for the two real source paths settles before the next event-loop turn.
    realpath: async (path: string) => saveGate.paths.has(path) ? realpathSync.native(path) : fs.realpath(path),
    stat: async (...args: Parameters<typeof fs.stat>) =>
      typeof args[0] === "string" && saveGate.paths.has(args[0]) && args[1]?.bigint
        ? statSync(args[0], { bigint: true }) : fs.stat(...args),
    async readFile(...args: Parameters<typeof fs.readFile>) {
      const [path, options] = args;
      // Capture the old implementation's source snapshot on entry, before the paused write is released.
      if (typeof path === "string" && saveGate.paths.has(path) && options === "utf8") {
        return readFileSync(path, "utf8");
      }
      return fs.readFile(...args);
    },
    async writeFile(...args: Parameters<typeof fs.writeFile>) {
      const [path, data, options] = args;
      if (typeof path === "string" && saveGate.paths.has(path) && typeof data === "string") {
        await saveGate.beforeSave?.();
        if (typeof options === "object") options?.signal?.throwIfAborted();
        // Do not interleave writes in the fixture: any missing spec comes from a stale read.
        writeFileSync(path, data, "utf8");
        return;
      }
      await fs.writeFile(...args);
    },
  };
});

vi.mock("../src/xml-input", async (importOriginal) => {
  const xml = await importOriginal<typeof import("../src/xml-input")>();
  return {
    ...xml,
    readDiagramXml: vi.fn(async (path: string, maxBytes?: number) =>
      saveGate.paths.has(path) ? readFileSync(path, "utf8") : xml.readDiagramXml(path, maxBytes)),
  };
});

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

const diagram = `<mxfile>${["first", "second"].map((id) => `
  <diagram name="${id}"><mxGraphModel pageWidth="200" pageHeight="100"><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="${id}" value="${id}" vertex="1" parent="1"><mxGeometry x="40" y="40" width="80" height="40" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram>`).join("")}</mxfile>`;
const steps = (id: string) => [{ effect: "fadeIn", cells: [id], duration: 200 }];

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "drawme transaction fixture "));
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  const dir = await realpath(workspace);
  const input = join(dir, "order.p2.drawio");
  const binary = join(dir, "fake drawio.mjs");
  await writeFile(input, diagram);
  await writeFile(binary, `import { readFileSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args.includes("--version")) process.stdout.write("32.4.1\\n");
else if (option("-f") === "svg") {
  const id = ["first", "second"][Number(option("--page-index")) - 1];
  writeFileSync(option("-o"), '<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px"><g data-cell-id="' + id + '"><rect width="80" height="40"/></g></svg>');
} else {
  const png = Buffer.from("${TINY_PNG}", "base64");
  const board = readFileSync(args[args.indexOf("-o") + 2], "utf8");
  // Distinguish the second page through legitimate non-editable PNG metadata.
  const tag = Buffer.from('tEXtpage\\0second');
  const chunk = Buffer.alloc(tag.length + 8);
  chunk.writeUInt32BE(tag.length - 4);
  tag.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(tag), chunk.length - 4);
  writeFileSync(option("-o"), board.includes('value="second"')
    ? Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]) : png);
}
`);
  const restoreRenderer = installNodeRendererFixture([binary]);
  vi.stubEnv("DISPLAY", ":99");
  onTestFinished(() => {
    restoreRenderer();
    vi.unstubAllEnvs();
  });
  onTestFinished(() => {
    saveGate.paths.clear();
    vi.mocked(readDiagramXml).mockClear();
    vi.mocked(invokeRenderer).mockReset();
  });
  return { dir, input, binary };
}

it.for(["same path", "hard link"])("preserves both page saves and SVGs through the %s", async (route, ctx) => {
  const { dir, input, binary } = await fixture();
  const alias = route === "hard link" ? join(dir, "linked.drawio") : input;
  if (route === "hard link") {
    try {
      await link(input, alias);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"].includes(code ?? "")) ctx.skip(`hard links unavailable (${code})`);
      throw error;
    }
  }
  const { dev, ino } = await stat(input, { bigint: true });
  saveGate.paths.add(input);
  saveGate.paths.add(alias);
  onTestFinished(() => {
    saveGate.paths.clear();
    saveGate.beforeSave = undefined;
  });
  const paused = barrier();
  const proceed = barrier();
  saveGate.beforeSave = async () => {
    saveGate.beforeSave = undefined;
    paused.release();
    await proceed.reached;
  };
  const first = animateDiagram({ input, binary, output: join(dir, "first.svg"), pageIndex: 1, steps: steps("first"), storyboard: false });
  let second: ReturnType<typeof animateDiagram>;
  try {
    await Promise.race([paused.reached, first]);
    second = animateDiagram({ input: alias, binary, output: join(dir, "second.svg"), pageIndex: 2, steps: steps("second"), storyboard: false });
    // Source metadata and reads settle this turn, so the second call either sees the old bytes or queues behind the edit.
    await nextTurn();
  } finally {
    proceed.release();
  }
  const results = await Promise.all([first, second]);
  for (const result of results) {
    expect(result.saved).toBe(true);
    expect(await readFile(result.output, "utf8")).toContain(`data-cell-id="${result.page}"`);
  }
  const xml = await readFile(input, "utf8");
  expect(await readFile(alias, "utf8")).toBe(xml);
  expect(await stat(input, { bigint: true })).toMatchObject({ dev, ino });
  expect(await stat(alias, { bigint: true })).toMatchObject({ dev, ino });
  const pages = new DOMParser().parseFromString(xml, "text/xml").getElementsByTagName("diagram");
  expect(Array.from(pages, (page) => {
    const stored = page.getElementsByTagName("UserObject")[0]?.getAttribute("drawmeMotion");
    return stored ? JSON.parse(stored).steps[0].cells[0] as string : null;
  })).toEqual(["first", "second"]);
});

it.for([-1, 60001])("rejects hold %s on stored motion without modifying the source or the SVG", async (hold) => {
  const { input, binary } = await fixture();
  const { output } = await animateDiagram({ input, binary, steps: steps("first"), storyboard: false });
  const original = await readFile(input, "utf8");
  const svg = await readFile(output, "utf8");
  const options = { input, binary, output, storyboard: false, hold };
  await expect(animateDiagram({ ...options, steps: steps("first") })).rejects.toThrow(/hold.*between 0 and 60000/);
  await expect.soft(animateDiagram(options)).rejects.toThrow(/hold.*between 0 and 60000/);
  expect.soft((await readFile(input, "utf8")) === original, "stored XML changed").toBe(true);
  expect.soft((await readFile(output, "utf8")) === svg, "existing SVG changed").toBe(true);
});

it("keeps the legacy page-one storyboard and publishes page two next to its explicit SVG", async () => {
  const { dir, input, binary } = await fixture();
  const first = await animateDiagram({ input, binary, steps: steps("first") });
  const legacy = join(dir, "order.p2.storyboard.png");
  expect(first.storyboard).toBe(legacy);
  const before = await readFile(legacy);
  expect(before.toString("base64")).toBe(TINY_PNG);
  const output = join(dir, "order.svg");
  const second = await animateDiagram({ input, binary, output, pageIndex: 2, steps: steps("second") });
  expect.soft(second.storyboard).toBe(`${output}.page-2.board.png`);
  expect((await readFile(second.storyboard!)).includes(Buffer.from("page\0second"))).toBe(true);
  expect((await readFile(legacy)).equals(before), "later storyboard overwrote the legacy board").toBe(true);
});

it("keeps same-named SVGs in different output directories paired with their own storyboard", async () => {
  const { dir, input, binary } = await fixture();
  const second = await animateDiagram({ input, binary, output: join(dir, "order.svg"), pageIndex: 2, steps: steps("second") });
  const alternate = join(dir, "other outputs");
  await mkdir(alternate);
  const alternateSvg = join(alternate, "order.svg");
  const secondCopy = await animateDiagram({ input, binary, output: alternateSvg, pageIndex: 2 });
  expect(secondCopy.storyboard).toBe(`${alternateSvg}.page-2.board.png`);
  expect(await readFile(secondCopy.storyboard!)).toEqual(await readFile(second.storyboard!));
});

it("holds the source across rendering so fit waits, while an independent edit proceeds", async () => {
  const { dir, input, binary } = await fixture();
  const other = join(dir, "unrelated.drawio");
  await writeFile(other, diagram);
  saveGate.paths.add(input);
  const entered = barrier();
  const resume = barrier();
  const { invokeRenderer: render } = await vi.importActual<typeof import("../src/renderer")>("../src/renderer");
  vi.mocked(invokeRenderer).mockImplementation(async (binary, args, signal) => {
    if (args[args.indexOf("-f") + 1] === "png") {
      entered.release();
      await resume.reached;
    }
    return render(binary, args, signal);
  });
  const motion = animateDiagram({ input, binary, steps: steps("first") });
  await Promise.race([entered.reached, motion]);
  const readCount = vi.mocked(readDiagramXml).mock.calls.filter(([path]) => path === input).length;
  const fit = fitCanvasFile({ input });
  const independent = fitCanvasFile({ input: other });
  try {
    await expect(independent).resolves.toMatchObject({ changed: true });
    expect(vi.mocked(readDiagramXml).mock.calls.filter(([path]) => path === input)).toHaveLength(readCount);
  } finally {
    resume.release();
    await Promise.allSettled([motion, fit, independent]);
  }
  expect(await motion).toMatchObject({ saved: true, storyboardFrames: 1 });
  expect(await fit).toMatchObject({ changed: true });
  expect(await readFile(input, "utf8")).toMatch(/pageWidth="160".*drawmeMotion=/s);
});

it("can cancel a queued animation edit without consuming the holder's lock or changing artifacts", async () => {
  const { dir, input, binary } = await fixture();
  const output = join(dir, "existing.svg");
  await writeFile(output, "prior SVG");
  saveGate.paths.add(input);
  saveGate.paths.add(output);
  const entered = barrier();
  const resume = barrier();
  const holder = withSourceEdits([input], async () => {
    entered.release();
    await resume.reached;
  });
  await Promise.race([entered.reached, holder]);
  const controller = new AbortController();
  const reason = new Error("cancel edit waiter");
  const animation = animateDiagram({ input, binary, output, steps: steps("first"), storyboard: false, signal: controller.signal });
  try {
    await nextTurn();
    controller.abort(reason);
    await expect(animation).rejects.toBe(reason);
    expect(readDiagramXml).not.toHaveBeenCalled();
    expect(await readFile(input, "utf8")).toBe(diagram);
    expect(await readFile(output, "utf8")).toBe("prior SVG");
  } finally {
    resume.release();
    await Promise.allSettled([holder, animation]);
  }
  await expect(animateDiagram({ input, binary, output, steps: steps("first"), storyboard: false })).resolves.toMatchObject({ saved: true });
});

it.for(["svg", "png"])("forwards cancellation to the in-flight %s renderer and preserves its previous file", async (format) => {
  const { input, binary } = await fixture();
  const first = await animateDiagram({ input, binary, steps: steps("first") });
  const destination = format === "svg" ? first.output : first.storyboard!;
  const previous = await readFile(destination);
  const { invokeRenderer: render } = await vi.importActual<typeof import("../src/renderer")>("../src/renderer");
  const entered = barrier();
  const resume = barrier();
  const controller = new AbortController();
  const reason = new Error(`cancel ${format} renderer`);
  vi.mocked(invokeRenderer).mockImplementation(async (executable, args, signal) => {
    if (args[args.indexOf("-f") + 1] !== format) return render(executable, args, signal);
    expect(signal).toBe(controller.signal);
    const canceled = new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    entered.release();
    return await Promise.race([canceled, resume.reached.then(() => { throw new Error("renderer not canceled"); })]);
  });
  const animation = animateDiagram({ input, binary, signal: controller.signal });
  try {
    await Promise.race([entered.reached, animation]);
    const rejected = expect(animation).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(await readFile(destination)).toEqual(previous);
  } finally {
    resume.release();
    await Promise.allSettled([animation]);
  }
});

it("leaves artifacts unchanged for ineffective motion whether or not a storyboard was requested", async () => {
  const { input, binary } = await fixture();
  const original = await animateDiagram({ input, binary, steps: steps("first") });
  const previous = await Promise.all([input, original.output, original.storyboard!].map((path) => readFile(path)));
  for (const storyboard of [false, true]) {
    await expect(animateDiagram({ input, binary, storyboard, steps: [{ effect: "wait", duration: 300 }] }))
      .rejects.toThrow(/no effective visual motion/i);
    expect(await Promise.all([input, original.output, original.storyboard!].map((path) => readFile(path)))).toEqual(previous);
  }
});

it("does not let an override mask invalid stored motion", async () => {
  const { input, binary } = await fixture();
  const { output } = await animateDiagram({ input, binary, steps: steps("first"), storyboard: false });
  const stored = (await readFile(input, "utf8")).replace("drawmeMotion=\"{", "drawmeMotion=\"{&quot;hold&quot;:-1,");
  await writeFile(input, stored);
  const previousSvg = await readFile(output);
  await expect(animateDiagram({ input, binary, hold: 0, storyboard: false })).rejects.toThrow(/hold.*between 0 and 60000/);
  expect(await readFile(input, "utf8")).toBe(stored);
  expect(await readFile(output)).toEqual(previousSvg);
});

it("accepts both hold boundaries and reuses a valid unchanged spec without resaving", async () => {
  const { input, binary } = await fixture();
  const opts = { input, binary, loop: true, storyboard: false };
  await expect(animateDiagram({ ...opts, steps: steps("first"), hold: 0 })).resolves.toMatchObject({ saved: true, durationMs: 200 });
  await expect(animateDiagram({ ...opts, hold: 60000 })).resolves.toMatchObject({ saved: true, durationMs: 60200 });
  const before = await readFile(input);
  await expect(animateDiagram({ input, binary, storyboard: false })).resolves.toMatchObject({ saved: false, durationMs: 60200 });
  expect(await readFile(input)).toEqual(before);
});
