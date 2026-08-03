/**
 * End-to-end check that drives the registered tools exactly as Pi would.
 * The export cases skip automatically when the draw.io CLI is unavailable, so
 * this file is safe to run in CI without draw.io installed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import drawme from "../src/index";
import { resolveBinary } from "../src/drawio";

// --- Minimal mock of the bits of ExtensionAPI the extension touches ---
type ToolDef = { name: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; details: unknown }> };
function makeMockPi() {
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: string[] = [];
  const pi = {
    registerTool: (t: ToolDef) => tools.set(t.name, t),
    registerCommand: (name: string, opts: { handler: (a: string, c: unknown) => Promise<void> }) => commands.set(name, opts),
    sendUserMessage: (content: string) => sent.push(content),
  };
  return { pi, tools, commands, sent };
}

const SAMPLE = `<mxfile><diagram name="Page-1"><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="a" value="Start" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="b" value="End" vertex="1" parent="1"><mxGeometry x="320" y="40" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="e1" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

describe("extension registration", () => {
  it("registers all tools and commands without throwing", () => {
    const { pi, tools, commands } = makeMockPi();
    drawme(pi as never);
    expect([...tools.keys()].sort()).toEqual([
      "drawio_check",
      "drawio_explain",
      "drawio_export",
      "drawio_from_mermaid",
      "drawio_layout",
      "drawio_open",
      "drawio_shapesearch",
      "drawio_validate",
    ]);
    expect([...commands.keys()].sort()).toEqual(["drawme", "drawme-check", "drawme-export"]);
  });

  it("/drawme injects a workflow message containing the description", async () => {
    const { pi, commands, sent } = makeMockPi();
    drawme(pi as never);
    await commands.get("drawme")!.handler("a flowchart of login", {});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("a flowchart of login");
    expect(sent[0]).toContain("drawio_export");
  });

  it("drawio_validate tool reports a clean sample", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await mkdtemp(join(tmpdir(), "drawme-"));
    const file = join(dir, "s.drawio");
    await writeFile(file, SAMPLE);
    const res = await tools.get("drawio_validate")!.execute("t", { input: file }, undefined, undefined, {});
    expect(res.content[0].text).toContain("0 error(s)");
    await rm(dir, { recursive: true, force: true });
  });

  it("drawio_shapesearch tool returns official style strings", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const res = await tools.get("drawio_shapesearch")!.execute("t", { query: "rectangle" }, undefined, undefined, {});
    expect(res.content[0].text).toContain("Rectangle");
  });

  it("drawio_explain tool describes a sample as Markdown", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await mkdtemp(join(tmpdir(), "drawme-"));
    const file = join(dir, "s.drawio");
    await writeFile(file, SAMPLE);
    const res = await tools.get("drawio_explain")!.execute("t", { input: file }, undefined, undefined, {});
    expect(res.content[0].text).toContain("### Components");
    expect(res.content[0].text).toContain("### Relations");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("real draw.io export", async () => {
  const cli = await resolveBinary();
  const run = cli.available ? it : it.skip;
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "drawme-export-"));
    file = join(dir, "sample.drawio");
    await writeFile(file, SAMPLE);
  });

  run(
    "preview export produces a clean (non-embedded) PNG",
    async () => {
      const { pi, tools } = makeMockPi();
      drawme(pi as never);
      const res = await tools.get("drawio_export")!.execute("t", { input: file, mode: "preview" }, undefined, undefined, {});
      const out = join(dir, "sample.png");
      expect(existsSync(out)).toBe(true);
      const data = await readFile(out);
      expect(data.subarray(0, 4).equals(PNG_SIG)).toBe(true);
      expect(res.content[0].text).toContain("Exported");
    },
    120_000,
  );

  run(
    "final export produces an embedded PNG with a valid (repaired) IEND chunk",
    async () => {
      const { pi, tools } = makeMockPi();
      drawme(pi as never);
      await tools.get("drawio_export")!.execute("t", { input: file, mode: "final" }, undefined, undefined, {});
      const out = join(dir, "sample.drawio.png");
      expect(existsSync(out)).toBe(true);
      const data = await readFile(out);
      expect(data.subarray(0, 4).equals(PNG_SIG)).toBe(true);
      expect(data.subarray(data.length - 12).equals(IEND)).toBe(true); // repair guarantees this
    },
    120_000,
  );

  run("final SVG export is produced", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    await tools.get("drawio_export")!.execute("t", { input: file, format: "svg", mode: "final" }, undefined, undefined, {});
    expect(existsSync(join(dir, "sample.svg"))).toBe(true);
  }, 120_000);
});

describe("draw.io v30+ features (Mermaid + layout)", async () => {
  const cli = await resolveBinary();
  const v30 = cli.available && (cli.major ?? 0) >= 30;
  const run = v30 ? it : it.skip;

  run(
    "converts inline Mermaid to a .drawio",
    async () => {
      const { pi, tools } = makeMockPi();
      drawme(pi as never);
      const dir = await mkdtemp(join(tmpdir(), "drawme-mmd-"));
      const out = join(dir, "flow.drawio");
      const res = await tools
        .get("drawio_from_mermaid")!
        .execute("t", { mermaid: "flowchart LR\n A[Start] --> B[End]", output: out }, undefined, undefined, {});
      expect(existsSync(out)).toBe(true);
      expect(res.content[0].text).toContain("Converted");
      await rm(dir, { recursive: true, force: true });
    },
    120_000,
  );
});
