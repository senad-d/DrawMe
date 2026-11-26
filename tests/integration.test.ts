/**
 * End-to-end check that drives the registered tools exactly as Pi would.
 * The export cases skip automatically when the draw.io CLI is unavailable, so
 * this file is safe to run in CI without draw.io installed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { copyFile, lstat, mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import drawme from "../src/index";
import { resolveBinary } from "../src/drawio";
import { AUTOMATIC_CORRECTION_LIMIT } from "../src/workflow";
import { makeMockPi, TINY_PNG, type ResultContent } from "./fixtures";
import { installRendererFixtureAdapter, writeRendererFixture } from "./renderer-fixture";

installRendererFixtureAdapter();

const nativeCli = await resolveBinary();
const workspaces: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "drawme integration "));
  workspaces.push(dir);
  return dir;
}

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

async function useRenderer(dir: string, noOutput = false) {
  // The controlled Node child is not Electron; do not simulate this in the native group.
  if (process.platform === "linux") {
    for (const api of ["getuid", "geteuid"] as const) {
      if (process[api]?.() === 0) vi.spyOn(process, api).mockReturnValue(1001);
    }
  }
  const argvLog = join(dir, `${noOutput ? "no output" : "render"} argv.ndjson`);
  const binary = await writeRendererFixture(dir, `
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) process.stdout.write("30.0.4\\n");
else if (!${noOutput}) {
  const output = args[args.indexOf("-o") + 1];
  if (args[args.indexOf("-f") + 1] === "svg") {
    writeFileSync(output, '<svg xmlns="http://www.w3.org/2000/svg" width="100px" height="50px" viewBox="0 0 100 50"/>');
  } else writeFileSync(output, Buffer.from("${TINY_PNG}", "base64"));
}
`);
  vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
  return { binary, argv: async () => (await readFile(argvLog, "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
}

const VISION_CTX = { model: { input: ["text", "image"] } };
const TEXT_ONLY_CTX = { model: { input: ["text"] } };

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
    await useRenderer(await workspace());
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
    expect(workflow).toContain("Tracking is process-local and lost after restart");
    expect(workflow).toContain("disk retirement does not remove an attached conversation image");
    expect(workflow).toContain("Only compare with a prior same-page image if the preview result says that image is still visible");
    expect(workflow).not.toContain("only the latest review image remains");
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
    const dir = await mkdtemp(join(tmpdir(), "drawme image result "));
    try {
      const input = join(dir, "sample file.drawio");
      const firstOutput = join(dir, "sample.review-canvas.png");
      const latestOutput = join(dir, "sample.review-nodes.png");
      await writeFile(input, SAMPLE);
      const { binary, argv } = await useRenderer(dir);

      const first = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output: firstOutput }, undefined, undefined, VISION_CTX);
      expect(first.content).toHaveLength(2);
      expect(first.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
      expect(textOf(first.content[0])).toContain("Preview image attached below");
      expect(textOf(first.content[0])).toContain("Critique it against the current review pass's checklist");
      expect(first.details).toMatchObject({ binary, version: "30.0.4" });
      expect(await argv()).toMatchObject([["--version"], expect.arrayContaining([input, "-o", "-f", "png"])]);

      const latest = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output: latestOutput }, undefined, undefined, VISION_CTX);
      expect(latest.content).toHaveLength(2);
      expect(latest.content[0]).toMatchObject({ type: "text" });
      expect(latest.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
      expect(textOf(latest.content[0])).toContain(`Removed preview artifact(s): ${firstOutput}`);
      // Disk replacement does not put a prior attachment in Pi's model context.
      expect(textOf(latest.content[0])).toContain("Critique it against the current review pass's checklist");
      expect(textOf(latest.content[0])).not.toContain("fixed, not fixed, or regressed");
      expect(existsSync(firstOutput)).toBe(false);
      expect(existsSync(latestOutput)).toBe(true);

      // Re-exporting over the same path removes nothing from disk and does not prove visibility either.
      const samePath = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output: latestOutput }, undefined, undefined, VISION_CTX);
      expect(textOf(samePath.content[0])).not.toContain("Removed preview artifact(s)");
      expect(textOf(samePath.content[0])).toContain("Critique it against the current review pass's checklist");
      expect(samePath.details).toMatchObject({ replacedPreview: true });

      const final = await tools
        .get("drawio_export")!
        .execute("t", { input, format: "svg", mode: "final", output: join(dir, "sample.svg") });
      expect(final.content).toHaveLength(1);
      expect(final.content[0]).toMatchObject({ type: "text" });
      expect(existsSync(latestOutput)).toBe(false);

      const failure = await tools
        .get("drawio_export")!
        .execute("t", { input: join(dir, "missing.drawio"), mode: "preview" });
      expect(failure.content).toHaveLength(1);
      expect(failure.content[0]).toMatchObject({ type: "text" });
      expect(failure.content.some((block) => block.type === "image")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports no new preview without attaching or deleting the previous image at the same path", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await mkdtemp(join(tmpdir(), "drawme stale preview "));
    try {
      const input = join(dir, "sample.drawio");
      const output = join(dir, "sample.review.png");
      await writeFile(input, SAMPLE);
      const { binary } = await useRenderer(dir);

      const exportTool = tools.get("drawio_export")!;
      const params = { input, output, mode: "preview" };
      const first = await exportTool.execute("t", params, undefined, undefined, VISION_CTX);
      expect(first.details).toMatchObject({ binary });
      expect(first.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });

      const { argv } = await useRenderer(dir, true);
      const retry = await exportTool.execute("t", params, undefined, undefined, VISION_CTX);
      expect(retry.content).toEqual([
        { type: "text", text: expect.stringContaining(`the output was not created: ${output}`) },
      ]);
      expect(await argv()).toMatchObject([["--version"], expect.arrayContaining([input, "-o", "-f", "png"])]);
      expect(await readFile(output)).toEqual(Buffer.from(TINY_PNG, "base64"));
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attaches the preview image only when the current model can view images", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await mkdtemp(join(tmpdir(), "drawme model capabilities "));
    try {
      const input = join(dir, "sample.drawio");
      const output = join(dir, "sample.review.png");
      await writeFile(input, SAMPLE);
      await useRenderer(dir);

      const textOnly = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output }, undefined, undefined, TEXT_ONLY_CTX);
      expect(textOnly.content).toHaveLength(1);
      expect(textOf(textOnly.content[0])).toContain("Preview image NOT attached");
      expect(textOf(textOnly.content[0])).toContain("cannot view images");
      expect(textOnly.details).toMatchObject({ imageAttached: false });
      expect(existsSync(output)).toBe(true); // the file stays on disk for the user

      const vision = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output }, undefined, undefined, VISION_CTX);
      expect(vision.content).toHaveLength(2);
      expect(vision.content[1]).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG });
      expect(textOf(vision.content[0])).toContain("Preview image attached below");
      expect(vision.details).toMatchObject({ imageAttached: true });

      const unknownModel = await tools
        .get("drawio_export")!
        .execute("t", { input, mode: "preview", output }, undefined, undefined, {});
      expect(unknownModel.content).toEqual([{ type: "text", text: expect.stringContaining("image support is unknown") }]);
      expect(unknownModel.details).toMatchObject({ imageAttached: false });
      expect(unknownModel.details).not.toHaveProperty("previewReceipt");

      // Final exports stay text-only even for vision models.
      const final = await tools
        .get("drawio_export")!
        .execute("t", { input, format: "svg", mode: "final", output: join(dir, "sample.svg") }, undefined, undefined, VISION_CTX);
      expect(final.content).toHaveLength(1);
      expect(final.details).toMatchObject({ imageAttached: false });
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drawio_validate tool reports a clean sample", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await workspace();
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
    const dir = await workspace();
    const file = join(dir, "s.drawio");
    await writeFile(file, SAMPLE);
    const res = await tools.get("drawio_explain")!.execute("t", { input: file }, undefined, undefined, {});
    expect(textOf(res.content[0])).toContain("### Components");
    expect(textOf(res.content[0])).toContain("### Relations");
  });

  it("reports tool failures and empty search results as text", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const dir = await workspace();
    await useRenderer(dir);
    const missing = join(dir, "missing.drawio");

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
    const dir = await workspace();
    await useRenderer(dir);
    const notifications: { message: string; level: string }[] = [];
    const ctx = {
      cwd: dir,
      ui: {
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    };

    await commands.get("drawme")!.handler("   ", ctx);
    await commands.get("drawme-check")!.handler("", ctx);
    await commands.get("drawme-export")!.handler("", ctx);
    await commands.get("drawme-export")!.handler("missing.drawio", ctx);

    expect(notifications.some((n) => n.message.startsWith("Usage: /drawme ") && n.level === "info")).toBe(true);
    expect(notifications.some((n) => n.message.startsWith("draw.io "))).toBe(true);
    expect(notifications.some((n) => n.message.startsWith("Usage: /drawme-export "))).toBe(true);
    expect(notifications.some((n) => n.message.startsWith("Export failed:") && n.level === "error")).toBe(true);
  });
});

describe("real draw.io export", () => {
  const run = it.runIf(nativeCli.available);
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

  run("reuses the packaged orders example's stored animation without rewriting it", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const cwd = await workspace();
    const input = "orders.drawio";
    const source = join(cwd, input);
    const output = join(cwd, "orders.animated.svg");
    const board = join(cwd, "orders.storyboard.png");
    await copyFile(new URL("../example/event-driven-orders.drawio", import.meta.url), source);
    const original = await readFile(source);
    const result = await tools.get("drawio_animate")!.execute("orders", { input }, undefined, undefined, { cwd, ...VISION_CTX });
    expect(textOf(result.content[0])).toContain("Animation verified: 12 step(s)");
    expect(textOf(result.content[0])).toContain("Re-used the motion stored");
    expect(result.details).toMatchObject({ output, storyboard: board, saved: false, imageAttached: true, binary: nativeCli.binary });
    expect(result.details).not.toHaveProperty("previewReceipt");
    expect(await readFile(source)).toEqual(original);
    expect(await readFile(output, "utf8")).toContain("prefers-reduced-motion");
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: (await readFile(board)).toString("base64") });
  }, 120_000);
});

describe("native Mermaid and layout", () => {
  it.runIf(nativeCli.available && nativeCli.supportsMermaid === true)("converts inline Mermaid and fits, validates, previews and delivers the new diagram", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const cwd = await workspace();
    const input = "flow.drawio";
    const source = join(cwd, input);
    const run = (tool: string, params: object) => tools.get(tool)!.execute(tool, params, undefined, undefined, { cwd, ...VISION_CTX });

    const converted = await run("drawio_from_mermaid", { mermaid: "flowchart LR\n A[Start] --> B[End]", output: input });
    expect(textOf(converted.content[0])).toContain("Converted");
    expect(converted.details).toMatchObject({ output: source, binary: nativeCli.binary });
    expect(await readFile(source, "utf8")).toContain("Start");

    const fit = await run("drawio_fit_canvas", { input, margin: 35 });
    expect(fit.details).toMatchObject({ output: source, changed: true });
    const graph = new DOMParser().parseFromString(await readFile(source, "utf8"), "text/xml").getElementsByTagName("mxGraphModel")[0];
    expect(graph.getAttribute("page")).toBe("1");
    expect(Number(graph.getAttribute("pageWidth"))).toBeGreaterThan(70);
    expect(Number(graph.getAttribute("pageHeight"))).toBeGreaterThan(70);
    expect((await run("drawio_validate", { input })).details).toMatchObject({ errors: [] });

    const preview = await run("drawio_export", { input, mode: "preview" });
    const previewPath = join(cwd, "flow.preview.png");
    expect(preview.details).toMatchObject({ output: previewPath, embed: false, imageAttached: true });
    expect(preview.content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: (await readFile(previewPath)).toString("base64") });

    const final = await run("drawio_export", { input, format: "svg", mode: "final", output: "delivered.svg", embed: false });
    const deliverable = join(cwd, "delivered.svg");
    expect(final.details).toMatchObject({ output: deliverable, imageAttached: false, removedPreviews: [previewPath] });
    expect(final.content).toHaveLength(1);
    expect(existsSync(previewPath)).toBe(false);
    const svg = await readFile(deliverable, "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("Start");
    expect(svg).toContain("End");
  }, 120_000);

  it.runIf(nativeCli.available && nativeCli.supportsLayout === true)("moves overlapping nodes while retaining graph IDs and connector terminals", async () => {
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const cwd = await workspace();
    const input = "overlap.drawio";
    const source = join(cwd, input);
    const original = SAMPLE.replace('x="320" y="40"', 'x="40" y="40"');
    await writeFile(source, original);
    const result = await tools.get("drawio_layout")!.execute("layout", { input, preset: "horizontalFlow" }, undefined, undefined, { cwd });
    const output = join(cwd, "overlap.layout.drawio");
    expect(textOf(result.content[0])).toContain("Laid out (horizontalFlow)");
    expect(result.details).toMatchObject({ output, preset: "horizontalFlow", binary: nativeCli.binary });
    expect(await readFile(source, "utf8")).toBe(original);

    const doc = new DOMParser().parseFromString(await readFile(output, "utf8"), "text/xml");
    const cells = Array.from(doc.getElementsByTagName("mxCell"));
    expect(cells.map(cell => cell.getAttribute("id")).sort()).toEqual(["0", "1", "a", "b", "e1"]);
    const connector = cells.find(cell => cell.getAttribute("id") === "e1")!;
    expect([connector.getAttribute("source"), connector.getAttribute("target")]).toEqual(["a", "b"]);
    const position = (id: string) => {
      const geometry = cells.find(cell => cell.getAttribute("id") === id)!.getElementsByTagName("mxGeometry")[0];
      return { x: Number(geometry.getAttribute("x")), y: Number(geometry.getAttribute("y")) };
    };
    const a = position("a");
    const b = position("b");
    expect(Number.isFinite(a.x) && Number.isFinite(b.x)).toBe(true);
    // Both authored rectangles are 120 wide at the same point; horizontal ELK separates them.
    expect(Math.abs(a.x - b.x)).toBeGreaterThanOrEqual(120);
  }, 120_000);
});
