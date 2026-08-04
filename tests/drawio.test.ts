import { describe, it, expect } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planExport, deriveOutput, exportDiagram } from "../src/drawio";

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
  it("removes every preview created for the source after a successful final export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-cleanup-"));
    try {
      const input = join(dir, "example.drawio");
      const firstPreview = join(dir, "example.preview.png");
      const secondPreview = join(dir, "example-review.png");
      const finalOutput = join(dir, "example.svg");
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
  writeFileSync(output, "exported");
}
`,
      );
      await chmod(binary, 0o755);

      await exportDiagram({ input, mode: "preview", output: firstPreview, binary });
      await exportDiagram({ input, mode: "preview", output: secondPreview, binary });
      expect(existsSync(firstPreview)).toBe(true);
      expect(existsSync(secondPreview)).toBe(true);

      const result = await exportDiagram({ input, format: "svg", mode: "final", output: finalOutput, binary });

      expect(existsSync(finalOutput)).toBe(true);
      expect(existsSync(firstPreview)).toBe(false);
      expect(existsSync(secondPreview)).toBe(false);
      expect(result.removedPreviews).toEqual([firstPreview, secondPreview]);
      expect(result.previewCleanupWarnings).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
