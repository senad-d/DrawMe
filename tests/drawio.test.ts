import { describe, it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planExport, deriveOutput, exportDiagram } from "../src/drawio";

async function makeFakeDrawio(dir: string): Promise<string> {
  const binary = join(dir, "fake-drawio.mjs");
  await writeFile(
    binary,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("30.0.0\\n");
} else {
  const output = args[args.indexOf("-o") + 1];
  writeFileSync(output, "exported");
}
`,
  );
  await chmod(binary, 0o755);
  return binary;
}

describe("deriveOutput", () => {
  it("uses the .drawio.png double extension when embedding a PNG", () => {
    expect(deriveOutput("diagram.drawio", "png", true)).toBe("diagram.drawio.png");
  });
  it("uses a single extension when not embedding", () => {
    expect(deriveOutput("diagram.drawio", "png", false)).toBe("diagram.png");
    expect(deriveOutput("dir/diagram.drawio", "svg", true)).toBe("dir/diagram.svg");
    expect(deriveOutput("diagram", "pdf", true)).toBe("diagram.pdf");
  });
});

describe("planExport", () => {
  it("final PNG: embeds, scales x2, .drawio.png output", () => {
    const p = planExport({ input: "a.drawio" }, "darwin");
    expect(p.embed).toBe(true);
    expect(p.output).toBe("a.drawio.png");
    expect(p.args).toEqual(["-x", "-f", "png", "-e", "-s", "2", "-b", "10", "-o", "a.drawio.png"]);
    expect(p.linuxExtra).toEqual([]);
  });

  it("preview PNG: no -e, width-capped at 2000, single-extension output", () => {
    const p = planExport({ input: "a.drawio", mode: "preview" }, "darwin");
    expect(p.embed).toBe(false);
    expect(p.output).toBe("a.png");
    expect(p.args).toContain("--width");
    expect(p.args).toContain("2000");
    expect(p.args).not.toContain("-e");
    expect(p.args).not.toContain("-s");
  });

  it("final SVG: embeds, no raster sizing flags", () => {
    const p = planExport({ input: "a.drawio", format: "svg" }, "darwin");
    expect(p.embed).toBe(true);
    expect(p.output).toBe("a.svg");
    expect(p.args).toContain("-e");
    expect(p.args).not.toContain("-s");
    expect(p.args).not.toContain("--width");
  });

  it("JPG never embeds (draw.io cannot embed XML in JPG)", () => {
    const p = planExport({ input: "a.drawio", format: "jpg" }, "darwin");
    expect(p.embed).toBe(false);
    expect(p.args).not.toContain("-e");
  });

  it("an explicit width overrides scale and they are never combined", () => {
    const p = planExport({ input: "a.drawio", width: 1200 }, "darwin");
    expect(p.args).toContain("--width");
    expect(p.args).toContain("1200");
    expect(p.args).not.toContain("-s");
  });

  it("supports explicit height, scale, border, and embed options", () => {
    const sized = planExport({ input: "a.drawio", height: 900, border: 0, embed: false }, "darwin");
    expect(sized.args).toContain("--height");
    expect(sized.args).toContain("900");
    expect(sized.args).toContain("0");
    expect(sized.args).not.toContain("-e");

    const scaled = planExport({ input: "a.drawio", scale: 3 }, "darwin");
    expect(scaled.args).toContain("3");
  });

  it("transparent adds -t for PNG only", () => {
    expect(planExport({ input: "a.drawio", transparent: true }, "darwin").args).toContain("-t");
    expect(planExport({ input: "a.drawio", format: "svg", transparent: true }, "darwin").args).not.toContain("-t");
  });

  it("page index is passed through (1-based)", () => {
    const p = planExport({ input: "a.drawio", pageIndex: 2 }, "darwin");
    const i = p.args.indexOf("--page-index");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(p.args[i + 1]).toBe("2");
  });

  it("on Linux the headless flags trail the input; --no-sandbox only as root", () => {
    expect(planExport({ input: "a.drawio" }, "linux", false).linuxExtra).toEqual(["--disable-gpu"]);
    expect(planExport({ input: "a.drawio" }, "linux", true).linuxExtra).toEqual(["--disable-gpu", "--no-sandbox"]);
  });
});

describe("exportDiagram preview cleanup", () => {
  it("keeps only the latest predictable focused-review preview", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-cleanup-"));
    try {
      const input = join(dir, "example.drawio");
      const previews = ["canvas", "nodes", "connectors", "semantics"].map((pass) =>
        join(dir, `example.review-${pass}.png`),
      );
      previews.push(join(dir, "example.review.png"));
      const finalOutput = join(dir, "example.svg");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");

      for (let index = 0; index < previews.length; index++) {
        const result = await exportDiagram({ input, mode: "preview", output: previews[index], binary });
        expect(existsSync(previews[index])).toBe(true);
        expect(previews.slice(0, index).every((output) => !existsSync(output))).toBe(true);
        expect(result.removedPreviews).toEqual(index === 0 ? [] : [previews[index - 1]]);
        expect(result.previewCleanupWarnings).toEqual([]);
      }

      const result = await exportDiagram({ input, format: "svg", mode: "final", output: finalOutput, binary });

      expect(existsSync(finalOutput)).toBe(true);
      expect(previews.every((output) => !existsSync(output))).toBe(true);
      expect(result.removedPreviews).toEqual([previews.at(-1)]);
      expect(result.previewCleanupWarnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent same-source previews and leaves only the last queued output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-concurrent-previews-"));
    try {
      const input = join(dir, "example.drawio");
      const outputs = ["canvas", "nodes", "connectors"].map((pass) => join(dir, `example.review-${pass}.png`));
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");

      const results = await Promise.all(outputs.map((output) => exportDiagram({ input, mode: "preview", output, binary })));

      expect(outputs.slice(0, -1).every((output) => !existsSync(output))).toBe(true);
      expect(existsSync(outputs.at(-1)!)).toBe(true);
      expect(results.map((result) => result.removedPreviews)).toEqual([[], [outputs[0]], [outputs[1]]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("preserves the final output when it resolves to the latest preview path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-same-output-"));
    try {
      const input = join(dir, "example.drawio");
      const sharedOutput = join(dir, "example.review.png");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");

      await exportDiagram({ input, mode: "preview", output: sharedOutput, binary });
      const result = await exportDiagram({ input, mode: "final", output: sharedOutput, embed: false, binary });

      expect(existsSync(sharedOutput)).toBe(true);
      expect(result.output).toBe(sharedOutput);
      expect(result.removedPreviews).toEqual([]);
      expect(result.previewCleanupWarnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a superseded-preview cleanup failure without invalidating the replacement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-replacement-warning-"));
    try {
      const input = join(dir, "example.drawio");
      const previous = join(dir, "example.review-canvas.png");
      const latest = join(dir, "example.review-nodes.png");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");

      await exportDiagram({ input, mode: "preview", output: previous, binary });
      await rm(previous);
      await mkdir(previous);

      const result = await exportDiagram({ input, mode: "preview", output: latest, binary });

      expect(existsSync(latest)).toBe(true);
      expect(result.output).toBe(latest);
      expect(result.removedPreviews).toEqual([]);
      expect(result.previewCleanupWarnings).toHaveLength(1);
      expect(result.previewCleanupWarnings[0]).toContain(previous);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports cleanup failures without invalidating a successful final export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-cleanup-warning-"));
    try {
      const input = join(dir, "example.drawio");
      const preview = join(dir, "example.review-canvas.png");
      const finalOutput = join(dir, "example.svg");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");

      await exportDiagram({ input, mode: "preview", output: preview, binary });
      await rm(preview);
      await mkdir(preview);

      const result = await exportDiagram({ input, format: "svg", mode: "final", output: finalOutput, binary });

      expect(existsSync(finalOutput)).toBe(true);
      expect(result.output).toBe(finalOutput);
      expect(result.removedPreviews).toEqual([]);
      expect(result.previewCleanupWarnings).toHaveLength(1);
      expect(result.previewCleanupWarnings[0]).toContain(preview);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the previous preview when its replacement export fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-failed-replacement-"));
    try {
      const input = join(dir, "example.drawio");
      const previous = join(dir, "example.review-canvas.png");
      const failed = join(dir, "example.review-fails.png");
      const binary = join(dir, "fake-drawio.mjs");
      await writeFile(input, "<mxfile/>");
      await writeFile(
        binary,
        `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("30.0.0\\n");
} else {
  const output = args[args.indexOf("-o") + 1];
  if (output.includes("fails")) process.exit(1);
  writeFileSync(output, "exported");
}
`,
      );
      await chmod(binary, 0o755);

      await exportDiagram({ input, mode: "preview", output: previous, binary });
      await expect(exportDiagram({ input, mode: "preview", output: failed, binary })).rejects.toThrow(
        "draw.io export failed",
      );

      expect(existsSync(previous)).toBe(true);
      expect(existsSync(failed)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
