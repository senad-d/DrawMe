import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animateDiagram } from "../src/animate";
import { exportDiagram, run } from "../src/drawio";
import drawme from "../src/index";
import { makeMockPi, TINY_PNG } from "./fixtures";
import { installRendererFixtureAdapter, writeRendererFixture } from "./renderer-fixture";

const source = `<?xml version="1.0"?>
<mxfile><diagram name="Motion"><mxGraphModel pageWidth="200" pageHeight="100"><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" vertex="1" parent="1"><mxGeometry x="40" y="40" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>
`;
const steps = [{ effect: "fadeIn", cells: ["a"], duration: 200 }];
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px"><g data-cell-id="a"><rect width="80" height="40"/></g></svg>';

installRendererFixtureAdapter();

const tempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "drawme animation-"));
  tempDirs.push(dir);
  return dir;
}

async function fixture(diagram = source, renderedSvg = SVG) {
  const dir = await fixtureDir();
  const input = join(dir, "motion.drawio");
  const log = join(dir, "renderer invocations.jsonl");
  await writeFile(input, diagram);
  const binary = await writeRendererFixture(dir, `
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ node: process.execPath, args }) + "\\n");
if (args.includes("--version")) process.stdout.write("31.0.0\\n");
else {
  const svg = args[args.indexOf("-f") + 1] === "svg";
  writeFileSync(args[args.indexOf("-o") + 1], svg
    ? ${JSON.stringify(renderedSvg)}
    : Buffer.from("${TINY_PNG}", "base64"));
}
`);
  return { dir, input, binary, log };
}

it("passes literal arguments through Node for registered renderers only, including under Xvfb", async () => {
  const dir = await fixtureDir();
  const script = `process.stdout.write(JSON.stringify({ node: process.execPath, args: process.argv.slice(2) }));`;
  const binary = await writeRendererFixture(dir, script, "registered renderer.mjs");
  const ordinary = join(dir, "ordinary script.mjs");
  await writeFile(ordinary, script);
  const args = ["two words", "", 'quote" and $amp&', binary];
  const stdout = JSON.stringify({ node: process.execPath, args });
  await expect(run(binary, args)).resolves.toMatchObject({ stdout });
  await expect(run("xvfb-run", ["-a", "--server-args=-screen 0 1280x1024x24", binary, ...args]))
    .resolves.toMatchObject({ stdout });
  await expect(run(ordinary, args)).rejects.toThrow();
  await expect(run(process.execPath, [ordinary, ...args])).resolves.toMatchObject({ stdout });
});

describe("animateDiagram", () => {
  it("stores motion, exports verified SVG and storyboard, and reuses stored steps", async () => {
    const { input, binary, log } = await fixture();
    const result = await animateDiagram({ input, binary, steps, loop: false });
    expect(result).toMatchObject({ saved: true, page: "Motion", steps: 1, loop: false, sequenceMs: 200, animatedCells: 1 });
    expect(result.storyboardFrames).toBe(1);
    expect(existsSync(result.storyboard!)).toBe(true);
    expect(await readFile(result.storyboard!)).toEqual(Buffer.from(TINY_PNG, "base64"));
    const rendered = await readFile(result.output, "utf8");
    expect(rendered).toContain('data-drawme-animation="motion"');
    expect(rendered).toContain('<rect width="80" height="40"');
    const calls = (await readFile(log, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual(expect.arrayContaining([
      { node: process.execPath, args: ["--version"] },
      { node: process.execPath, args: expect.arrayContaining(["-f", "svg"]) },
      { node: process.execPath, args: expect.arrayContaining(["-f", "png"]) },
    ]));

    const stored = await readFile(input, "utf8");
    expect(stored).toContain("drawmeMotion=");
    expect(stored).toMatch(/^<\?xml version="1.0"\?>/);
    expect(stored.endsWith("\n")).toBe(true);
    const reused = await animateDiagram({ input, binary, storyboard: false });
    expect(reused.saved).toBe(false);
    expect(reused.storyboard).toBeUndefined();
    expect(await readFile(input, "utf8")).toBe(stored);
    const overridden = await animateDiagram({ input, binary, loop: true, hold: 100, storyboard: false });
    expect(overridden).toMatchObject({ saved: true, loop: true, durationMs: 300 });
  });

  it("rejects missing, invalid, or absent motion without changing the source", async () => {
    const { dir, input, binary } = await fixture();
    await expect(animateDiagram({ input: join(dir, "missing.drawio") })).rejects.toThrow("input file not found");
    await expect(animateDiagram({ input, binary, storyboard: false })).rejects.toThrow("no stored motion");
    await expect(animateDiagram({ input, binary, steps: [] })).rejects.toThrow("non-empty steps");
    await expect(animateDiagram({ input, binary, steps: [{ effect: "fadeIn", cells: ["missing"] }] })).rejects.toThrow("missing cell");
    expect(await readFile(input, "utf8")).toBe(source);
  });

  it("rejects malformed stored JSON and conflicting native animation", async () => {
    const { input, binary } = await fixture();
    await writeFile(input, source.replace('<mxCell id="0"/>', '<UserObject id="0" drawmeMotion="broken"><mxCell/></UserObject>'));
    await expect(animateDiagram({ input, binary })).rejects.toThrow("malformed JSON");
    const animation = JSON.stringify({ steps: [{ show: { cells: ["a"] } }] }).replaceAll('"', "&quot;");
    await writeFile(input, source.replace('<mxCell id="0"/>', `<UserObject id="0" animation="${animation}"><mxCell/></UserObject>`));
    await expect(animateDiagram({ input, binary, steps })).rejects.toThrow("already has a native");
  });

  const svgWithoutTarget = SVG.replace('data-cell-id="a"', 'data-cell-id="other"');

  it("leaves no SVG when motion injection fails and the destination is new", async () => {
    const { dir, input, binary } = await fixture(source, svgWithoutTarget);
    const output = join(dir, "invalid.svg");
    await expect(animateDiagram({ input, binary, steps, output, storyboard: false })).rejects.toThrow("animated SVG verification failed");
    expect(existsSync(output)).toBe(false);
  });

  it("preserves the previous final and preview if motion injection cannot find its cell", async () => {
    const { input, binary } = await fixture(source, svgWithoutTarget);
    const final = await exportDiagram({ input, binary, format: "svg" });
    const preview = await exportDiagram({ input, binary, mode: "preview" });
    const finalBytes = await readFile(final.output);
    const previewBytes = await readFile(preview.output);
    const output = final.output;
    await expect(animateDiagram({ input, binary, steps, output, storyboard: false })).rejects.toThrow("animated SVG verification failed");
    expect(await readFile(output)).toEqual(finalBytes);
    expect(await readFile(preview.output)).toEqual(previewBytes);
  });
});

describe("drawio_animate connector flow", () => {
  const { pi, tools } = makeMockPi();
  drawme(pi as never);
  const tool = tools.get("drawio_animate")!;

  const flowSource = source.replace("</root>", `
<mxCell id="b" vertex="1" parent="1"><mxGeometry x="160" y="40" width="30" height="40" as="geometry"/></mxCell>
<mxCell id="edge" edge="1" parent="1" source="a" target="b" style="flowAnimation=1;"><mxGeometry relative="1" as="geometry"/></mxCell>
</root>`);
  const connector = '<g data-cell-id="edge"><path d="M120 60 L160 60" fill="none" stroke="black"/></g>';
  const animatedConnector = connector.replace("/>", ' stroke-dasharray="5 5" style="animation: flow 500ms linear infinite;"/>');
  const flowKeyframes = '<style>@keyframes flow { to { stroke-dashoffset: -10; } }</style>';
  const twoFlowSource = flowSource.replace("</root>", `
<mxCell id="return-edge" edge="1" parent="1" source="b" target="a" style="flowAnimation=1;"><mxGeometry relative="1" as="geometry"/></mxCell>
</root>`);
  const returnConnector = animatedConnector.replace('data-cell-id="edge"', 'data-cell-id="return-edge"');
  const staticError = "draw.io did not preserve flow animation for connector(s): edge";

  it.each([
    ["absent", flowSource, "", "SVG is missing animated connector group(s): edge"],
    ["static", flowSource, connector, staticError],
    ["static beside a working flow", twoFlowSource, `${flowKeyframes}${connector}${returnConnector}`, staticError],
  ])("fails verification and removes the SVG when the rendered connector is %s", async (_state, diagram, edgeSvg, error) => {
    const { dir, input, binary } = await fixture(diagram, SVG.replace("</svg>", `${edgeSvg}</svg>`));
    const output = join(dir, "motion.svg");
    vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
    const result = await tool.execute("t", { input, output, steps, storyboard: false });
    expect(result.content).toEqual([{ type: "text", text: `Animate failed: animated SVG verification failed: ${error}` }]);
    expect(existsSync(output)).toBe(false);
  });

  it("reports and preserves a rendered connector flow", async () => {
    const rendered = SVG.replace("</svg>", `${flowKeyframes}${animatedConnector}</svg>`);
    const { dir, input, binary } = await fixture(flowSource, rendered);
    const output = join(dir, "motion.svg");
    vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
    const result = await tool.execute("t", { input, output, steps, storyboard: false });
    expect(result.details).toMatchObject({ connectorFlows: 1, output });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Animation verified:") });
    expect(await readFile(output, "utf8")).toContain(animatedConnector);
  });
});
