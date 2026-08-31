/**
 * End-to-end check that drives the registered tools exactly as Pi would.
 * The export cases skip automatically when the draw.io CLI is unavailable, so
 * this file is safe to run in CI without draw.io installed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { chmod, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import drawme from "../src/index";
import { resolveBinary } from "../src/drawio";
import { AUTOMATIC_CORRECTION_LIMIT } from "../src/workflow";

// --- Minimal mock of the bits of ExtensionAPI the extension touches ---
type ResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolDef = { name: string; execute: (...a: unknown[]) => Promise<{ content: ResultContent[]; details: unknown }> };

function textOf(content: ResultContent): string {
  return content.type === "text" ? content.text : "";
}
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
  <mxCell id="e1" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="240" y="70"/></Array></mxGeometry></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/** Stand-in draw.io CLI: reports v30 and writes a tiny PNG to the -o path. */
const FAKE_DRAWIO = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) process.stdout.write("30.0.0\\n");
else writeFileSync(args[args.indexOf("-o") + 1], Buffer.from("iVBORw0KGgo=", "base64"));
`;

const VISION_CTX = { model: { input: ["text", "image"] } };
const TEXT_ONLY_CTX = { model: { input: ["text"] } };

describe("extension registration", () => {
  it("registers all tools and commands without throwing", () => {
    const { pi, tools, commands } = makeMockPi();
    drawme(pi as never);
    expect([...tools.keys()].sort()).toEqual([
      "drawio_check",
      "drawio_explain",
      "drawio_export",
      "drawio_fit_canvas",
      "drawio_from_mermaid",
      "drawio_layout",
      "drawio_open",
      "drawio_shapesearch",
      "drawio_validate",
    ]);
    expect([...commands.keys()].sort()).toEqual(["drawme", "drawme-check", "drawme-export"]);
  });

  it("/drawme injects the gated multi-pass, fully autonomous workflow", async () => {
    const { pi, commands, sent } = makeMockPi();
    drawme(pi as never);
    await commands.get("drawme")!.handler("a flowchart of login", {});
    expect(sent).toHaveLength(1);

    const workflow = sent[0];
    expect(workflow).toContain("a flowchart of login");
    const passes = [
      "Pass 1 — fit and sizing",
      "Pass 2 — element placement",
      "Pass 3 — connections",
      "Pass 4 — typography, semantics, and regression",
    ];
    for (let i = 0; i < passes.length - 1; i++) {
      expect(workflow.indexOf(passes[i])).toBeGreaterThan(-1);
      expect(workflow.indexOf(passes[i])).toBeLessThan(workflow.indexOf(passes[i + 1]));
    }
    // Each pass answers its questions explicitly and gates the next one.
    expect(workflow).toContain("does the diagram fit its page, and does the canvas or any element need resizing?");
    expect(workflow).toContain("is every element positioned correctly, and is there a visibly better arrangement?");
    expect(workflow).toContain("anchored to the middle of the element side it faces wherever possible?");
    expect(workflow).toContain("Do not start the next pass until every finding of the current one is verified");
    expect(workflow).toContain("every pass must be complete before final export");
    expect(workflow).toContain("structured critique");
    // The critique is a defect hunt that narrows problems to cells and verifies fixes visually.
    expect(workflow).toContain("Read every label word for word");
    expect(workflow).toContain("Trace every edge from source to target");
    expect(workflow).toContain("numbered ledger");
    expect(workflow).toContain("what is visibly wrong and where in the image");
    expect(workflow).toContain("**fixed**");
    expect(workflow).toContain("**not fixed**");
    expect(workflow).toContain("**regressed**");
    expect(workflow).toContain("Never mark a finding fixed because the XML changed");
    // Multi-page files are reviewed and exported page by page.
    expect(workflow).toContain("for a multi-page file, export one preview per page with `pageIndex`");
    expect(workflow).toContain("export each page with `pageIndex` and a distinct `output`");
    expect(workflow).toContain("states whether the preview image is attached");
    expect(workflow).toContain("Image attached");
    expect(workflow).toContain("Image NOT attached");
    expect(workflow).toContain("cannot view images");
    expect(workflow).toContain("rendered inspection was skipped");
    expect(workflow).toContain("call `drawio_validate` immediately after authoring and after every later XML edit");
    // Canvas fitting: page dimensions follow content, never the reverse.
    expect(workflow).toContain("drawio_fit_canvas");
    expect(workflow).toContain("do NOT fix page dimensions up front");
    expect(workflow).toContain("never shrink or squeeze elements");
    expect(workflow).toContain(`allow at most ${AUTOMATIC_CORRECTION_LIMIT} correction retries`);
    // Fully autonomous: no human gate anywhere in the flow.
    expect(workflow).toContain("fully autonomous");
    expect(workflow).toContain("never pause to ask for approval");
    expect(workflow).not.toMatch(/approval before|explicit user approval|wait for approval/i);
    expect(workflow).toContain("<name>.review-fit.png");
    expect(workflow).toContain("<name>.review-layout.png");
    expect(workflow).toContain("<name>.review-connectors.png");
    expect(workflow).toContain("<name>.review.png");
    expect(workflow).toContain("only the latest review image remains");
    // Second-person instructions only: nothing in the message may talk about agents,
    // and the workflow must be self-contained (no mandatory reference read).
    expect(workflow).not.toMatch(/agent/i);
    expect(workflow).not.toContain("Before starting, read");
    expect(workflow).toContain("report failures as a text result");
    // The CLI check result and topic references are embedded — no upfront tool calls or reads.
    expect(workflow).toContain("CLI status (already checked");
    expect(workflow).toContain("# Packaged references (pre-loaded — do not re-read these files)");
    expect(workflow).toContain("## Reference: diagram types (pre-loaded from");
    expect(workflow).toContain("## Reference: XML authoring (pre-loaded from");
    // Only troubleshooting stays on-demand.
    expect(workflow).toContain("troubleshooting.md` (the one reference kept on-demand)");
    expect(workflow).not.toContain("first read");
  });

  it("attaches only the latest successful preview file but keeps final and failure results text-only", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await mkdtemp(join(tmpdir(), "drawme-image-result-"));
    try {
      const input = join(dir, "sample.drawio");
      const firstOutput = join(dir, "sample.review-canvas.png");
      const latestOutput = join(dir, "sample.review-nodes.png");
      const binary = join(dir, "fake-drawio.mjs");
      await writeFile(input, SAMPLE);
      await writeFile(binary, FAKE_DRAWIO);
      await chmod(binary, 0o755);

      const first = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output: firstOutput, binary }, undefined, undefined, VISION_CTX);
      expect(first.content).toHaveLength(2);
      expect(first.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
      expect(textOf(first.content[0])).toContain("Preview image attached below");
      expect(textOf(first.content[0])).toContain("Critique it against the current review pass's checklist");

      const latest = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output: latestOutput, binary }, undefined, undefined, VISION_CTX);
      expect(latest.content).toHaveLength(2);
      expect(latest.content[0]).toMatchObject({ type: "text" });
      expect(latest.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
      expect(textOf(latest.content[0])).toContain(`Removed preview artifact(s): ${firstOutput}`);
      // A replacement preview demands a before/after verdict instead of a fresh critique.
      expect(textOf(latest.content[0])).toContain("It replaces the previous preview");
      expect(textOf(latest.content[0])).toContain("fixed, not fixed, or regressed");
      expect(existsSync(firstOutput)).toBe(false);
      expect(existsSync(latestOutput)).toBe(true);

      // Re-exporting over the same path removes nothing from disk but is still a replacement:
      // the verdict nudge must not fall back to the first-critique text.
      const samePath = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output: latestOutput, binary }, undefined, undefined, VISION_CTX);
      expect(textOf(samePath.content[0])).not.toContain("Removed preview artifact(s)");
      expect(textOf(samePath.content[0])).toContain("It replaces the previous preview");
      expect(samePath.details).toMatchObject({ replacedPreview: true });

      const final = await tools
        .get("drawio_export")!
        .execute("t", { input, format: "svg", mode: "final", output: join(dir, "sample.svg"), binary });
      expect(final.content).toHaveLength(1);
      expect(final.content[0]).toMatchObject({ type: "text" });
      expect(existsSync(latestOutput)).toBe(false);

      const failure = await tools
        .get("drawio_export")!
        .execute("t", { input: join(dir, "missing.drawio"), mode: "preview", binary });
      expect(failure.content).toHaveLength(1);
      expect(failure.content[0]).toMatchObject({ type: "text" });
      expect(failure.content.some((block) => block.type === "image")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attaches the preview image only when the current model can view images", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await mkdtemp(join(tmpdir(), "drawme-vision-"));
    try {
      const input = join(dir, "sample.drawio");
      const output = join(dir, "sample.review.png");
      const binary = join(dir, "fake-drawio.mjs");
      await writeFile(input, SAMPLE);
      await writeFile(binary, FAKE_DRAWIO);
      await chmod(binary, 0o755);

      const textOnly = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output, binary }, undefined, undefined, TEXT_ONLY_CTX);
      expect(textOnly.content).toHaveLength(1);
      expect(textOf(textOnly.content[0])).toContain("Preview image NOT attached");
      expect(textOf(textOnly.content[0])).toContain("cannot view images");
      expect(textOnly.details).toMatchObject({ imageAttached: false });
      expect(existsSync(output)).toBe(true); // the file stays on disk for the user

      const vision = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output, binary }, undefined, undefined, VISION_CTX);
      expect(vision.content).toHaveLength(2);
      expect(vision.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" });
      expect(textOf(vision.content[0])).toContain("Preview image attached below");
      expect(vision.details).toMatchObject({ imageAttached: true });

      // Unknown model fails open (image attached), matching Pi's built-in read tool.
      const unknownModel = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output, binary }, undefined, undefined, {});
      expect(unknownModel.content).toHaveLength(2);
      expect(unknownModel.details).toMatchObject({ imageAttached: true });

      // Final exports stay text-only even for vision models.
      const final = await tools
        .get("drawio_export")!
        .execute("t", { input, format: "svg", mode: "final", output: join(dir, "sample.svg"), binary }, undefined, undefined, VISION_CTX);
      expect(final.content).toHaveLength(1);
      expect(final.details).toMatchObject({ imageAttached: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drawio_validate tool reports a clean sample", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await mkdtemp(join(tmpdir(), "drawme-"));
    const file = join(dir, "s.drawio");
    await writeFile(file, SAMPLE);
    const res = await tools.get("drawio_validate")!.execute("t", { input: file }, undefined, undefined, {});
    const text = textOf(res.content[0]);
    expect(text).toContain("Errors (0):");
    expect(text).toContain("Actionable warnings (0):");
    expect(text).toContain("Informational observations (1):");
    expect(text).toContain("Readability score: 0");
    expect(text).toContain("0 error(s), 0 unresolved warning(s)");
    await rm(dir, { recursive: true, force: true });
  });

  it("drawio_shapesearch tool returns official style strings", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const res = await tools.get("drawio_shapesearch")!.execute("t", { query: "rectangle", limit: 1 }, undefined, undefined, {});
    expect(textOf(res.content[0])).toContain("Rectangle");
  });

  it("drawio_explain tool describes a sample as Markdown", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await mkdtemp(join(tmpdir(), "drawme-"));
    const file = join(dir, "s.drawio");
    await writeFile(file, SAMPLE);
    const res = await tools.get("drawio_explain")!.execute("t", { input: file }, undefined, undefined, {});
    expect(textOf(res.content[0])).toContain("### Components");
    expect(textOf(res.content[0])).toContain("### Relations");
    await rm(dir, { recursive: true, force: true });
  });

  it("reports tool failures and empty search results as text", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const missing = join(tmpdir(), "drawme-file-that-does-not-exist.drawio");

    const check = await tools.get("drawio_check")!.execute("t", { binary: missing }, undefined, undefined, {});
    expect(textOf(check.content[0])).toContain("draw.io");

    const exported = await tools.get("drawio_export")!.execute("t", { input: missing }, undefined, undefined, {});
    expect(textOf(exported.content[0])).toContain("Export failed: input file not found");
    expect(exported.content.some((block) => block.type === "image")).toBe(false);

    const converted = await tools.get("drawio_from_mermaid")!.execute("t", {}, undefined, undefined, {});
    expect(textOf(converted.content[0])).toContain("Mermaid conversion failed:");

    const laidOut = await tools
      .get("drawio_layout")!
      .execute("t", { input: missing, preset: "invalid" }, undefined, undefined, {});
    expect(textOf(laidOut.content[0])).toContain("Layout failed: unknown layout preset");

    const fitted = await tools.get("drawio_fit_canvas")!.execute("t", { input: missing }, undefined, undefined, {});
    expect(textOf(fitted.content[0])).toContain("Fit canvas failed:");

    const shapes = await tools.get("drawio_shapesearch")!.execute("t", { query: "no-such-shape-xyz" }, undefined, undefined, {});
    expect(textOf(shapes.content[0])).toContain("No shapes matched");

    const explained = await tools.get("drawio_explain")!.execute("t", { input: missing }, undefined, undefined, {});
    expect(textOf(explained.content[0])).toContain("Explain failed:");

    const opened = await tools.get("drawio_open")!.execute("t", { path: missing }, undefined, undefined, {});
    expect(textOf(opened.content[0])).toContain("Open failed: file not found");
  });

  it("handles command usage and failure notifications", async () => {
    const { pi, commands } = makeMockPi();
    drawme(pi as never);
    const notifications: { message: string; level: string }[] = [];
    const ctx = {
      ui: {
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    };

    await commands.get("drawme")!.handler("   ", ctx);
    await commands.get("drawme-check")!.handler("", ctx);
    await commands.get("drawme-export")!.handler("", ctx);
    await commands.get("drawme-export")!.handler(join(tmpdir(), "missing.drawio"), ctx);

    expect(notifications.some((n) => n.message.startsWith("Usage: /drawme ") && n.level === "info")).toBe(true);
    expect(notifications.some((n) => n.message.startsWith("draw.io "))).toBe(true);
    expect(notifications.some((n) => n.message.startsWith("Usage: /drawme-export "))).toBe(true);
    expect(notifications.some((n) => n.message.startsWith("Export failed:") && n.level === "error")).toBe(true);
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
      expect(textOf(res.content[0])).toContain("Exported");
      const image = res.content.find((block) => block.type === "image");
      expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: data.toString("base64") });
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
      expect(textOf(res.content[0])).toContain("Converted");
      await rm(dir, { recursive: true, force: true });
    },
    120_000,
  );
});
