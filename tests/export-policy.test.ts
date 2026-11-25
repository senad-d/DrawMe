import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cappedScale, MAX_FINAL_RASTER_PIXELS, planExport, verifyStagedArtifact } from "../src/export-policy";

const INPUT = { input: "diagram.drawio" };
// FFmpeg's baseline JFIF export of a single 2×2 white frame.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z", "base64");

function flag(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : Number(args[i + 1]);
}

describe("planExport", () => {
  it("validates one-based pages and translates only an explicitly requested index", () => {
    expect(planExport(INPUT, "linux", false, 100, 100, "unknown").args).not.toContain("--page-index");
    for (const pageIndex of [0, 1.9]) {
      expect(() => planExport({ ...INPUT, pageIndex })).toThrow(/positive integer/);
    }
    for (const [version, indexes] of [["26.2.15", [0, 1]], ["27.0.2", [1, 2]], ["32.4.1", [1, 2]]] as const) {
      const pages = [1, 2].map(pageIndex => flag(planExport({ ...INPUT, pageIndex }, "linux", false, 100, 100, version).args, "--page-index"));
      expect(pages).toEqual(indexes);
    }
    expect(flag(planExport({ ...INPUT, pageIndex: 2 }).args, "--page-index")).toBe(2);
  });

  it("refuses root on Linux instead of building an unsandboxed command", () => {
    expect(() => planExport(INPUT, "linux", true)).toThrow(/unprivileged user/);
    expect(planExport(INPUT, "linux", false).linuxExtra).toEqual(["--disable-gpu"]);
  });

  it("preserves an extensionless output and recognizes case-insensitive JPEG aliases", () => {
    expect(planExport({ ...INPUT, format: "pdf", output: "report" }).output).toBe("report");
    expect(planExport({ ...INPUT, format: "jpg", output: "diagram.JpEg" }).output).toBe("diagram.JpEg");
    expect(() => planExport({ ...INPUT, format: "png", output: "diagram.jpg" })).toThrow(/suffix.*png/i);
    expect(() => planExport({ ...INPUT, format: "png", output: "directory.jpg/" })).toThrow(/must name a file/);
  });

  it("refuses editable final JPEG but disables embedding on review outputs", () => {
    expect(() => planExport({ ...INPUT, format: "jpg", embed: true })).toThrow(/JPG.*embed/i);
    const preview = planExport({ ...INPUT, mode: "preview", format: "jpg", embed: true });
    const board = planExport({ ...INPUT, mode: "final", reviewRaster: true, embed: true });
    expect(preview).toMatchObject({ embed: false, output: "diagram.preview.jpg" });
    expect(board).toMatchObject({ embed: false, mode: "final", reviewRaster: true });
    expect(preview.args).not.toContain("-e");
    expect(board.args).not.toContain("-e");
  });

  it("fits preview and persistent board requests by the long side without changing the content aspect", () => {
    const portrait = planExport({ ...INPUT, mode: "preview", width: 5000 }, "linux", false, 500, 2200);
    const landscape = planExport({ ...INPUT, reviewRaster: true, height: 5000 }, "linux", false, 2200, 500);
    expect(flag(portrait.args, "--height")).toBe(2000);
    expect(portrait.args).not.toContain("--width");
    expect(flag(landscape.args, "--width")).toBe(2000);
    expect(landscape.args).not.toContain("--height");
    const smaller = planExport({ ...INPUT, mode: "preview", width: 400 }, "linux", false, 500, 2200);
    expect(flag(smaller.args, "--width")).toBe(400);
    expect(smaller.args).not.toContain("-s");
  });

  it("budgets explicit final dimensions using the whole bordered raster", () => {
    const plan = planExport({ ...INPUT, width: 5000, scale: 99 }, "linux", false, 3000, 2000);
    const width = flag(plan.args, "--width")!;
    const border = flag(plan.args, "-b")!;
    const height = (w: number) => Math.ceil((w - 2 * border) * 2000 / 3000 + 2 * border);
    expect(width * height(width)).toBeLessThanOrEqual(MAX_FINAL_RASTER_PIXELS);
    expect((width + 1) * height(width + 1)).toBeGreaterThan(MAX_FINAL_RASTER_PIXELS);
    expect(plan.args).not.toContain("-s");
  });

  it("keeps tiny positive scale caps and rejects invalid sizes or scales", () => {
    expect(cappedScale(2, 40, 2_000_000, 1_000_000)).toBeGreaterThan(0);
    const plan = planExport({ ...INPUT, scale: 0.000001 }, "linux", false, 100, 100);
    expect(flag(plan.args, "--width")).toBe(1);
    for (const scale of [0, -1, Infinity, NaN]) {
      expect(() => planExport({ ...INPUT, scale })).toThrow(/positive finite/);
    }
    expect(() => planExport({ ...INPUT, width: Infinity })).toThrow(/positive finite/);
  });
});

async function withStage(action: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "drawme-export-policy-"));
  try {
    await action(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One blank print page with a conventional xref table. */
function pdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] >>",
  ];
  let text = "%PDF-1.4\n";
  const offsets = objects.map((obj, i) => {
    const start = text.length;
    text += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return `${String(start).padStart(10, "0")} 00000 n\n`;
  });
  return text + `xref\n0 4\n0000000000 65535 f\n${offsets.join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${text.length}\n%%EOF\n`;
}

describe("verifyStagedArtifact", () => {
  it("requires the staged renderer output to be an actual regular file", async () => {
    await withStage(async dir => {
      const plan = planExport({ ...INPUT, format: "pdf", output: "report" });
      await expect(verifyStagedArtifact(plan, dir)).rejects.toThrow(/not a regular file/);
      await expect(verifyStagedArtifact(plan, join(dir, "missing.pdf"))).rejects.toThrow(/not created/);
    });
  });

  it("checks PDF content without requiring a PDF suffix on the final name", async () => {
    await withStage(async dir => {
      const plan = planExport({ ...INPUT, format: "pdf", output: "report" });
      const stage = join(dir, "artifact.pdf");
      const data = pdf();
      await writeFile(stage, data);
      expect(await verifyStagedArtifact(plan, stage)).toEqual({ repaired: false });
      expect(await readFile(stage, "utf8")).toBe(data);
      await writeFile(stage, data.slice(0, -6));
      await expect(verifyStagedArtifact(plan, stage)).rejects.toThrow(/not a complete PDF/);
    });
  });

  it("preserves SVG width before padding and pins adaptive colors", async () => {
    await withStage(async dir => {
      const plan = planExport({ ...INPUT, format: "svg", width: 30 });
      const stage = join(dir, "artifact.svg");
      expect(flag(plan.args, "--width")).toBe(30);
      expect(flag(plan.args, "-b")).toBe(0);
      await writeFile(stage, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 10"><rect style="fill:light-dark(red, blue)"/></svg>');
      await verifyStagedArtifact(plan, stage);
      const svg = await readFile(stage, "utf8");
      expect(svg).toContain('width="110px"');
      expect(svg).toContain('style="fill:red"');
    });
  });

  it("requires a JPEG frame and scan, not merely the outer signature and trailer", async () => {
    await withStage(async dir => {
      const plan = planExport({ ...INPUT, format: "jpg" });
      const stage = join(dir, "artifact.jpg");
      await writeFile(stage, JPEG);
      expect(await verifyStagedArtifact(plan, stage)).toEqual({ repaired: false });
      for (const invalid of [Buffer.from([0xff, 0xd8, 0, 0xff, 0xd9]), JPEG.subarray(0, -2)]) {
        await writeFile(stage, invalid);
        await expect(verifyStagedArtifact(plan, stage)).rejects.toThrow(/not a complete JPG/);
      }
    });
  });

  it("enforces raster limits using the JPEG frame dimensions", async () => {
    await withStage(async dir => {
      const preview = planExport({ ...INPUT, mode: "preview", format: "jpg" });
      const final = planExport({ ...INPUT, format: "jpg" });
      const stage = join(dir, "artifact.jpg");
      const over = Buffer.from(JPEG);
      const sof = over.indexOf(Buffer.from([0xff, 0xc0]));
      over.writeUInt16BE(2001, sof + 7); // Replace the declared width only; marker sizes remain valid.
      await writeFile(stage, over);
      await expect(verifyStagedArtifact(preview, stage)).rejects.toThrow(/2000-pixel review limit/);
      over.writeUInt16BE(3000, sof + 5);
      await writeFile(stage, over);
      await expect(verifyStagedArtifact(final, stage)).rejects.toThrow(/6,000,000-pixel raster budget/);
    });
  });
});
