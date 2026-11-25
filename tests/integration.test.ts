/**
 * End-to-end check that drives the registered tools exactly as Pi would.
 * The export cases skip automatically when the draw.io CLI is unavailable, so
 * this file is safe to run in CI without draw.io installed.
 */
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from "vitest";
import { lstat, mkdtemp, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import drawme from "../src/index";
import { resolveBinary } from "../src/drawio";
import { resolveBinary as resolveRendererBinary } from "../src/renderer";
import { AUTOMATIC_CORRECTION_LIMIT } from "../src/workflow";
import { installNodeRendererFixture, makeMockPi, TINY_PNG, type ResultContent } from "./fixtures";

function textOf(content: ResultContent): string {
  return content.type === "text" ? content.text : "";
}

const SAMPLE = `<mxfile><diagram name="Page-1"><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="a" value="Start" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="b" value="End" vertex="1" parent="1"><mxGeometry x="320" y="40" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="e1" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="240" y="70"/></Array></mxGeometry></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

const FIXTURE_VERSION = "30.2.4";
/** Stand-in draw.io CLI that exits successfully without rendering. */
const FAKE_DRAWIO_NO_OUTPUT = `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) process.stdout.write("${FIXTURE_VERSION}\\n");
`;

/** Stand-in draw.io CLI that writes an artifact to the -o path. */
const FAKE_DRAWIO = `${FAKE_DRAWIO_NO_OUTPUT}else if (args[args.indexOf("-f") + 1] === "svg") writeFileSync(args[args.indexOf("-o") + 1], '<svg xmlns="http://www.w3.org/2000/svg" width="100px" height="50px" viewBox="0 0 100 50"/>');
else writeFileSync(args[args.indexOf("-o") + 1], Buffer.from("${TINY_PNG}", "base64"));
`;

const VISION_CTX = { model: { input: ["text", "image"] } };
const TEXT_ONLY_CTX = { model: { input: ["text"] } };

async function testDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}

async function previewFixture() {
  const dir = await testDir("drawme preview fixture ");
  const input = join(dir, "sample diagram.drawio");
  const binary = join(dir, "fake drawio.mjs");
  const noOutputBinary = join(dir, "no output.mjs");
  await writeFile(input, SAMPLE);
  await writeFile(binary, FAKE_DRAWIO);
  await writeFile(noOutputBinary, FAKE_DRAWIO_NO_OUTPUT);
  const restoreRenderer = installNodeRendererFixture([binary, noOutputBinary]);
  onTestFinished(() => {
    restoreRenderer();
    vi.unstubAllEnvs();
  });
  // Fake renderers run directly even on headless Linux; the adapter handles nonroot identity.
  vi.stubEnv("DISPLAY", ":99");
  vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
  return { dir, input, binary, noOutputBinary };
}

function previewEntry(id: string, parentId: string | null, result: { content: ResultContent[]; details: unknown }) {
  return {
    type: "message" as const,
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      ...result,
      role: "toolResult" as const,
      toolCallId: id,
      toolName: "drawio_export",
      isError: false,
      timestamp: Date.now(),
    },
  };
}

describe("extension registration", () => {
  it("registers all tools and commands without throwing", () => {
    const { pi, tools, commands } = makeMockPi();
    drawme(pi as never);
    expect([...tools.keys()].sort()).toEqual([
      "drawio_animate",
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
    expect(workflow).toContain("re-pin an exit or entry to the suggested facing side");
    expect(workflow).toContain("predicted route-through observations as focused preview-review hints");
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
    // Motion requests use verified standalone SVG plus an accessible static fallback.
    expect(workflow).toContain("plan an animated SVG");
    expect(workflow).toContain("persistent connector flow");
    expect(workflow).toContain("portable page sequence");
    expect(workflow).toContain("the PNG preview is intentionally static");
    expect(workflow).toContain("`animated: true`");
    expect(workflow).toContain("`Animation verified`");
    expect(workflow).toContain("static PNG fallback");
    expect(workflow).toContain("`drawio_animate`");
    expect(workflow).toContain("storyboard frame by frame");
    // A style preset is chosen up front and its reference is pre-loaded.
    expect(workflow).toContain("Pick one style preset");
    expect(workflow).toContain("## Reference: style presets");
    expect(workflow).toContain("## Light (default)");
    expect(workflow).toContain("Never choose Dark or Multi-color on your own");
    expect(workflow).toContain(`allow at most ${AUTOMATIC_CORRECTION_LIMIT} correction retries`);
    // Fully autonomous: no human gate anywhere in the flow.
    expect(workflow).toContain("fully autonomous");
    expect(workflow).toContain("never pause to ask for approval");
    expect(workflow).not.toMatch(/approval before|explicit user approval|wait for approval/i);
    expect(workflow).toContain("<name>.review-fit.png");
    expect(workflow).toContain("<name>.review-layout.png");
    expect(workflow).toContain("<name>.review-connectors.png");
    expect(workflow).toContain("<name>.review.png");
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

  it("attaches previews in the active conversation, retires tracked files, and keeps finals and failures text-only", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const { dir, input, binary } = await previewFixture();
    const exportTool = tools.get("drawio_export")!;
    const firstOutput = join(dir, "sample.review-canvas.png");
    const latestOutput = join(dir, "sample.review-nodes.png");
    const finalOutput = join(dir, "sample.svg");
    const branch: ReturnType<typeof previewEntry>[] = [];
    const ctx = { ...VISION_CTX, sessionManager: { getBranch: () => branch } };

    const first = await exportTool.execute("first", { input, mode: "preview", output: firstOutput }, undefined, undefined, ctx);
    expect(first.content).toHaveLength(2);
    expect(first.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
    expect(first.details).toMatchObject({ binary, version: FIXTURE_VERSION, output: firstOutput, imageAttached: true });
    expect(await readFile(firstOutput, "base64")).toBe(TINY_PNG);
    expect(textOf(first.content[0])).toContain("Preview image attached below");
    expect(textOf(first.content[0])).toContain("Critique it against the current review pass's checklist");
    branch.push(previewEntry("first", null, first));

    const latest = await exportTool.execute("latest", { input, mode: "preview", output: latestOutput }, undefined, undefined, ctx);
    expect(latest.content).toHaveLength(2);
    expect(latest.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
    expect(latest.details).toMatchObject({ output: latestOutput, imageAttached: true, removedPreviews: [firstOutput] });
    expect(textOf(latest.content[0])).toMatch(/not.fixed.*regressed/i);
    expect(existsSync(firstOutput)).toBe(false);
    expect(await readFile(latestOutput, "base64")).toBe(TINY_PNG);
    branch.push(previewEntry("latest", "first", latest));

    // Re-exporting the same path still has prior attached images, but removes no files.
    const samePath = await exportTool.execute("repeat", { input, mode: "preview", output: latestOutput }, undefined, undefined, ctx);
    expect(samePath.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
    expect(samePath.details).toMatchObject({ output: latestOutput, imageAttached: true, replacedPreview: true, removedPreviews: [] });
    expect(textOf(samePath.content[0])).toMatch(/not.fixed.*regressed/i);
    expect(await readFile(latestOutput, "base64")).toBe(TINY_PNG);

    const final = await exportTool.execute("final", { input, format: "svg", mode: "final", output: finalOutput }, undefined, undefined, ctx);
    expect(final.content).toEqual([{ type: "text", text: expect.stringContaining(`Exported ${finalOutput}`) }]);
    expect(final.details).toMatchObject({ output: finalOutput, imageAttached: false, removedPreviews: [latestOutput] });
    expect(await readFile(finalOutput, "utf8")).toContain("<svg");
    expect(existsSync(latestOutput)).toBe(false);

    const failure = await exportTool.execute("failure", { input: join(dir, "missing.drawio"), mode: "preview" }, undefined, undefined, ctx);
    expect(failure.content).toEqual([{ type: "text", text: expect.stringContaining("Export failed: input file not found") }]);
  });

  it("reports no new preview without attaching or deleting the previous image at the same path", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const { dir, input, noOutputBinary } = await previewFixture();
    const exportTool = tools.get("drawio_export")!;
    const output = join(dir, "sample.review.png");
    const params = { input, output, mode: "preview" };
    const first = await exportTool.execute("t", params, undefined, undefined, VISION_CTX);
    expect(first.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
    expect(first.details).toMatchObject({ output, imageAttached: true });

    vi.stubEnv("DRAWME_DRAWIO_BINARY", noOutputBinary);
    const retry = await exportTool.execute("t", params, undefined, undefined, VISION_CTX);
    expect(retry.content).toEqual([
      { type: "text", text: expect.stringContaining(`the output was not created: ${output}`) },
    ]);
    expect(await readFile(output, "base64")).toBe(TINY_PNG);
  });

  it("honors known model capabilities and reports whether a preview was actually attached", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const { dir, input } = await previewFixture();
    const exportTool = tools.get("drawio_export")!;
    const output = join(dir, "sample.review.png");
    const params = { input, mode: "preview", output };

    const textOnly = await exportTool.execute("t", params, undefined, undefined, TEXT_ONLY_CTX);
    expect(textOnly.content).toHaveLength(1);
    expect(textOf(textOnly.content[0])).toContain("Preview image NOT attached");
    expect(textOf(textOnly.content[0])).toContain("cannot view images");
    expect(textOnly.details).toMatchObject({ imageAttached: false });
    expect(await readFile(output, "base64")).toBe(TINY_PNG);

    const vision = await exportTool.execute("t", params, undefined, undefined, VISION_CTX);
    expect(vision.content).toHaveLength(2);
    expect(vision.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
    expect(textOf(vision.content[0])).toContain("Preview image attached below");
    expect(vision.details).toMatchObject({ imageAttached: true });

    const unknownModel = await exportTool.execute("t", params, undefined, undefined, {});
    expect(unknownModel.details).toMatchObject({
      output,
      imageAttached: unknownModel.content.some((block) => block.type === "image"),
    });
  });

  it("drawio_validate tool reports a clean sample", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await testDir("drawme validate ");
    const file = join(dir, "s.drawio");
    await writeFile(file, SAMPLE);
    const res = await tools.get("drawio_validate")!.execute("t", { input: file }, undefined, undefined, {});
    const text = textOf(res.content[0]);
    expect(text).toContain("Errors (0):");
    expect(text).toContain("Actionable warnings (0):");
    expect(text).toContain("Informational observations (1):");
    expect(text).toContain("Readability score: 0");
    expect(text).toContain("anchors=0");
    expect(text).toContain("0 error(s), 0 unresolved warning(s)");
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
    const dir = await testDir("drawme explain ");
    const file = join(dir, "s.drawio");
    await writeFile(file, SAMPLE);
    const res = await tools.get("drawio_explain")!.execute("t", { input: file }, undefined, undefined, {});
    expect(textOf(res.content[0])).toContain("### Components");
    expect(textOf(res.content[0])).toContain("### Relations");
  });

  it("reports tool failures and empty search results as text", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const missing = join(tmpdir(), "drawme-file-that-does-not-exist.drawio");

    const check = await tools.get("drawio_check")!.execute("t", {}, undefined, undefined, {});
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

    const animated = await tools.get("drawio_animate")!.execute("t", { input: missing }, undefined, undefined, {});
    expect(textOf(animated.content[0])).toContain("Animate failed: input file not found");

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
  let animatedFile: string;
  let sequenceFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "drawme-export-"));
    file = join(dir, "sample.drawio");
    animatedFile = join(dir, "animated.drawio");
    sequenceFile = join(dir, "sequence.drawio");
    await writeFile(file, SAMPLE);
    await writeFile(
      animatedFile,
      SAMPLE.replace(
        '<mxCell id="e1" edge="1"',
        '<mxCell id="e1" style="flowAnimation=1;flowAnimationDuration=750;flowAnimationDirection=reverse;" edge="1"',
      ),
    );
    const animation = JSON.stringify({
      animation: {
        loop: true,
        steps: [
          { opacity: { cells: ["a", "b", "e1"], value: 0 } },
          { fadeIn: { cells: ["a"], delay: 250 } },
          { fadeIn: { cells: ["e1"], delay: 250 } },
          { fadeIn: { cells: ["b"], delay: 250 } },
        ],
      },
    }).replaceAll('"', "&quot;");
    await writeFile(
      sequenceFile,
      SAMPLE.replace(
        '<mxCell id="0"/>',
        `<UserObject label="" id="0" animation="${animation}"><mxCell/></UserObject>`,
      ),
    );
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  run(
    "preview export produces a clean (non-embedded) PNG",
    async () => {
      const { pi, tools } = makeMockPi();
      drawme(pi as never);
      const res = await tools.get("drawio_export")!.execute("t", { input: file, mode: "preview" }, undefined, undefined, VISION_CTX);
      const out = join(dir, "sample.preview.png");
      expect(existsSync(out)).toBe(true);
      const data = await readFile(out);
      expect(data.subarray(0, 4).equals(PNG_SIG)).toBe(true);
      expect(textOf(res.content[0])).toContain("Exported");
      const image = res.content.find((block) => block.type === "image");
      expect(image).toMatchObject({ type: "image", mimeType: "image/png", data: data.toString("base64") });
      expect(res.details).toMatchObject({ output: out, imageAttached: true });
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

  run("a preview requesting embedding cannot replace or retire the native final PNG", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const work = await mkdtemp(join(tmpdir(), "drawme-native-ownership-"));
    try {
      const input = join(work, "sample.drawio");
      await writeFile(input, SAMPLE);
      const exportTool = tools.get("drawio_export")!;
      const finalPng = join(work, "sample.drawio.png");
      const previewPng = join(work, "sample.preview.png");
      // draw.io stores embedded diagrams in a zTXt chunk with this keyword.
      const embeddedDiagram = Buffer.from("zTXtmxGraphModel\0");

      await exportTool.execute("t", { input, mode: "final" }, undefined, undefined, {});
      const original = await readFile(finalPng);
      expect(original.includes(embeddedDiagram)).toBe(true);

      const preview = await exportTool.execute("t", { input, mode: "preview", embed: true }, undefined, undefined, VISION_CTX);
      expect(preview.details).toMatchObject({ output: previewPng, embed: false });
      const previewBytes = await readFile(previewPng);
      expect(previewBytes.includes(embeddedDiagram)).toBe(false);
      expect(await readFile(finalPng)).toEqual(original);

      const final = await exportTool.execute("t", { input, format: "svg", mode: "final" }, undefined, undefined, {});
      expect(final.details).toMatchObject({ removedPreviews: [previewPng] });
      expect(existsSync(previewPng)).toBe(false);
      expect(await readFile(finalPng)).toEqual(original);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);

  run("an explicit output symlink still updates an existing final artifact", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const work = await mkdtemp(join(tmpdir(), "drawme-native-linked-output-"));
    try {
      const input = join(work, "sample.drawio");
      const requested = join(work, "linked.png");
      const target = join(work, "target.png");
      const previous = Buffer.from(TINY_PNG, "base64");
      await writeFile(input, SAMPLE);
      await writeFile(target, previous);
      await symlink(target, requested);

      const result = await tools.get("drawio_export")!
        .execute("t", { input, output: requested, mode: "final", embed: false }, undefined, undefined, {});
      expect(textOf(result.content[0])).toContain(`Exported ${requested}`);
      expect.soft((await lstat(requested)).isSymbolicLink(), "explicit destination lost its symlink").toBe(true);
      const published = await readFile(target);
      expect(published.subarray(0, 4)).toEqual(PNG_SIG);
      expect(published.length, "linked artifact was not refreshed").toBeGreaterThan(previous.length);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);

  run("final SVG export is produced", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    await tools.get("drawio_export")!.execute("t", { input: file, format: "svg", mode: "final" }, undefined, undefined, {});
    expect(existsSync(join(dir, "sample.svg"))).toBe(true);
  }, 120_000);

  run("animated SVG export compiles and verifies a page sequence", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const result = await tools
      .get("drawio_export")!
      .execute("t", { input: sequenceFile, animated: true, mode: "final" }, undefined, undefined, {});
    const svg = await readFile(join(dir, "sequence.svg"), "utf8");
    expect(textOf(result.content[0])).toContain("Animation verified: 0 connector flow(s), 4 page step(s)");
    expect(result.details).toMatchObject({
      animated: true,
      animation: { sequenceCompiled: true, sequenceDurationMs: 750, verified: true },
    });
    expect(svg).toContain("data-drawme-animation=\"opacity-timeline\"");
    expect(svg).toContain("prefers-reduced-motion: reduce");
  }, 120_000);

  run("animated SVG export preserves and verifies connector flow", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const result = await tools
      .get("drawio_export")!
      .execute("t", { input: animatedFile, animated: true, mode: "final" }, undefined, undefined, {});
    expect(existsSync(join(dir, "animated.svg"))).toBe(true);
    expect(textOf(result.content[0])).toContain("Animation verified: 1 connector flow(s)");
    expect(result.details).toMatchObject({
      animated: true,
      animation: { connectorFlows: 1, sequenceCompiled: false, verified: true },
    });
    expect(await readFile(join(dir, "animated.svg"), "utf8")).toMatch(/animation:\s*750ms/);
  }, 120_000);
});

describe("native draw.io Mermaid import", async () => {
  const cli = await resolveRendererBinary();

  it.runIf(cli.available && cli.supportsMermaid === true)(
    "converts inline Mermaid to a .drawio",
    async () => {
      const { pi, tools } = makeMockPi();
      drawme(pi as never);
      const dir = await testDir("drawme Mermaid import ");
      const out = join(dir, "flow.drawio");
      const res = await tools
        .get("drawio_from_mermaid")!
        .execute("t", { mermaid: "flowchart LR\n A[Start] --> B[End]", output: out }, undefined, undefined, {});
      expect(existsSync(out)).toBe(true);
      expect(textOf(res.content[0])).toContain("Converted");
      expect(res.details).toMatchObject({ output: out });
    },
    120_000,
  );
});
