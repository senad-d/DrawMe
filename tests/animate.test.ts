import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { animateDiagram } from "../src/animate";
import drawme from "../src/index";

const source = `<?xml version="1.0"?>
<mxfile><diagram name="Motion"><mxGraphModel pageWidth="200" pageHeight="100"><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" vertex="1" parent="1"><mxGeometry x="40" y="40" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>
`;
const steps = [{ effect: "fadeIn", cells: ["a"], duration: 200 }];
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px"><g data-cell-id="a"><rect width="80" height="40"/></g></svg>';

async function fixture(diagram = source, renderedSvg = SVG): Promise<{ dir: string; input: string; binary: string }> {
  const dir = await mkdtemp(join(tmpdir(), "drawme-animate-"));
  const input = join(dir, "motion.drawio");
  const binary = join(dir, "fake-drawio.mjs");
  await writeFile(input, diagram);
  await writeFile(binary, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) process.stdout.write("31.0.0\\n");
else {
  const svg = args[args.indexOf("-f") + 1] === "svg";
  writeFileSync(args[args.indexOf("-o") + 1], svg
    ? ${JSON.stringify(renderedSvg)}
    : "storyboard image");
}
`);
  await chmod(binary, 0o755);
  return { dir, input, binary };
}

describe("animateDiagram", () => {
  it("stores motion, exports verified SVG and storyboard, and reuses stored steps", async () => {
    const { dir, input, binary } = await fixture();
    try {
      const result = await animateDiagram({ input, binary, steps, loop: false });
      expect(result).toMatchObject({ saved: true, page: "Motion", steps: 1, loop: false, sequenceMs: 200, animatedCells: 1 });
      expect(result.storyboardFrames).toBe(1);
      expect(existsSync(result.storyboard!)).toBe(true);
      expect(await readFile(result.output, "utf8")).toContain('data-drawme-animation="motion"');
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects missing, invalid, or absent motion without changing the source", async () => {
    const { dir, input, binary } = await fixture();
    try {
      await expect(animateDiagram({ input: join(dir, "missing.drawio") })).rejects.toThrow("input file not found");
      await expect(animateDiagram({ input, binary, storyboard: false })).rejects.toThrow("no stored motion");
      await expect(animateDiagram({ input, binary, steps: [] })).rejects.toThrow("non-empty steps");
      await expect(animateDiagram({ input, binary, steps: [{ effect: "fadeIn", cells: ["missing"] }] })).rejects.toThrow("missing cell");
      expect(await readFile(input, "utf8")).toBe(source);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed stored JSON and conflicting native animation", async () => {
    const { dir, input, binary } = await fixture();
    try {
      await writeFile(input, source.replace('<mxCell id="0"/>', '<UserObject id="0" drawmeMotion="broken"><mxCell/></UserObject>'));
      await expect(animateDiagram({ input, binary })).rejects.toThrow("malformed JSON");
      const animation = JSON.stringify({ steps: [{ show: { cells: ["a"] } }] }).replaceAll('"', "&quot;");
      await writeFile(input, source.replace('<mxCell id="0"/>', `<UserObject id="0" animation="${animation}"><mxCell/></UserObject>`));
      await expect(animateDiagram({ input, binary, steps })).rejects.toThrow("already has a native");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes a misleading SVG when motion injection cannot find its cell", async () => {
    const { dir, input, binary } = await fixture(source, SVG.replace('data-cell-id="a"', 'data-cell-id="other"'));
    try {
      const output = join(dir, "invalid.svg");
      await expect(animateDiagram({ input, binary, steps, output, storyboard: false })).rejects.toThrow("animated SVG verification failed");
      expect(existsSync(output)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("drawio_animate connector flow", () => {
  const registerTool = vi.fn<ExtensionAPI["registerTool"]>();
  drawme({ registerTool, registerCommand: vi.fn() } as unknown as ExtensionAPI);
  const tool = registerTool.mock.calls.find(([definition]) => definition.name === "drawio_animate")![0];
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
    try {
      const output = join(dir, "motion.svg");
      const result = await tool.execute("t", { input, output, binary, steps, storyboard: false }, undefined, undefined, {} as never);
      expect(result.content).toEqual([{ type: "text", text: `Animate failed: animated SVG verification failed: ${error}` }]);
      expect(existsSync(output)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports and preserves a rendered connector flow", async () => {
    const rendered = SVG.replace("</svg>", `${flowKeyframes}${animatedConnector}</svg>`);
    const { dir, input, binary } = await fixture(flowSource, rendered);
    try {
      const output = join(dir, "motion.svg");
      const result = await tool.execute("t", { input, output, binary, steps, storyboard: false }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ connectorFlows: 1, output });
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Animation verified:") });
      expect(await readFile(output, "utf8")).toContain(animatedConnector);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
