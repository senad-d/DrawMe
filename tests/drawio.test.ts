import { afterEach, describe, it, expect, vi } from "vitest";
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { MAX_FINAL_RASTER_PIXELS, cappedScale, planExport, deriveOutput, exportDiagram, run, xvfbScreen } from "../src/drawio";
import { installNodeRendererFixture, TINY_PNG } from "./fixtures";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100px" height="50px" viewBox="0 0 100 50"/>';
const renderImage = `writeFileSync(output, svg ? ${JSON.stringify(SVG)} : Buffer.from("${TINY_PNG}", "base64"));`;

let restoreRenderer: (() => void) | undefined;

afterEach(() => {
  restoreRenderer?.();
  restoreRenderer = undefined;
  vi.unstubAllEnvs();
});

function useFakeDrawio(binary: string): void {
  restoreRenderer?.();
  restoreRenderer = installNodeRendererFixture([binary]);
  vi.stubEnv("DISPLAY", ":99");
}

async function makeFakeDrawio(dir: string, render = renderImage): Promise<string> {
  const binary = join(dir, "fake-drawio.mjs");
  await writeFile(
    binary,
    `import { chmodSync, linkSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("30.0.0\\n");
} else {
  const output = args[args.indexOf("-o") + 1];
  const svg = args[args.indexOf("-f") + 1] === "svg";
  ${render}
}
`,
  );
  useFakeDrawio(binary);
  return binary;
}

describe("deriveOutput", () => {
  it("uses the .drawio.png double extension when embedding a PNG", () => {
    expect(deriveOutput("diagram.drawio", "png", true)).toBe("diagram.drawio.png");
  });
  it("uses a single extension when not embedding", () => {
    expect(deriveOutput("diagram.drawio", "png", false)).toBe("diagram.png");
    expect(deriveOutput(join("dir", "diagram.drawio"), "svg", true)).toBe(join("dir", "diagram.svg"));
    expect(deriveOutput("diagram", "pdf", true)).toBe("diagram.pdf");
  });
});

describe("xvfbScreen", () => {
  it("fits the requested raster with a margin, floored at 1280x1024 and capped at 8192", () => {
    const final = planExport({ input: "a.drawio" }, "linux", false, 1600).args;
    expect(final).toContain("3360");
    expect(xvfbScreen(final)).toBe("3616x3616x24");
    expect(xvfbScreen(planExport({ input: "a.drawio", mode: "preview" }, "linux", false).args)).toBe("2256x2256x24");
    expect(xvfbScreen(["-x", "-f", "svg", "-b", "0"])).toBe("1280x1024x24");
    expect(xvfbScreen(["--height", "900"])).toBe("1280x1156x24");
    expect(xvfbScreen(["--width", "20000"])).toBe("8192x8192x24");
  });
});

describe.skipIf(process.platform === "win32")("run", () => {
  it("kills the whole process group on timeout, leaving no orphans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme run with spaces "));
    const pidFile = join(dir, "pid");
    try {
      const script = `sleep 30 & pid=$!; trap 'wait "$pid"; exit 0' TERM; printf '%s' "$pid" > "$1"; wait "$pid"`;
      await expect(run("sh", ["-c", script, "fixture", pidFile], 300)).rejects.toThrow("timed out");
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(pid).toBeGreaterThan(0);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("planExport", () => {
  it("final PNG: embeds, scales x2, .drawio.png output", () => {
    const p = planExport({ input: "a.drawio" }, "darwin");
    expect(p.embed).toBe(true);
    expect(p.output).toBe("a.drawio.png");
    expect(p.args).toEqual(["-x", "-f", "png", "-e", "-s", "2", "-b", "40", "-o", "a.drawio.png"]);
    expect(p.linuxExtra).toEqual([]);
  });

  it("preview PNG: no -e, width-capped at 2000, separate preview suffix", () => {
    const p = planExport({ input: "a.drawio", mode: "preview" }, "darwin");
    expect(p.embed).toBe(false);
    expect(p.output).toBe("a.preview.png");
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

  it("animated mode defaults to final SVG and rejects static formats or preview mode", () => {
    const animated = planExport({ input: "a.drawio", animated: true }, "darwin");
    expect(animated.format).toBe("svg");
    expect(animated.mode).toBe("final");
    expect(animated.animated).toBe(true);
    expect(animated.args).toContain("-e");
    expect(() => planExport({ input: "a.drawio", format: "png", animated: true }, "darwin")).toThrow(
      "animated export requires format='svg'",
    );
    expect(() => planExport({ input: "a.drawio", mode: "preview", animated: true }, "darwin")).toThrow(
      "animated export requires mode='final'",
    );
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

  it("sizes scaled raster exports by width so the margin is even, and pads SVG itself", () => {
    const png = planExport({ input: "a.drawio" }, "darwin", false, 1000);
    expect(png.args).toEqual(["-x", "-f", "png", "-e", "--width", "2160", "-b", "80", "-o", "a.drawio.png"]);
    const jpg = planExport({ input: "a.drawio", format: "jpg", scale: 3, border: 10 }, "darwin", false, 500);
    expect(jpg.args).toEqual(["-x", "-f", "jpg", "--width", "1560", "-b", "30", "-o", "a.jpg"]);
    const svg = planExport({ input: "a.drawio", format: "svg" }, "darwin", false, 1000);
    expect(svg.args).toContain("-b");
    expect(svg.args[svg.args.indexOf("-b") + 1]).toBe("0");
    expect(svg.svgMargin).toBe(40);
    const preview = planExport({ input: "a.drawio", mode: "preview" }, "darwin", false, 1000);
    expect(preview.args).toEqual(["-x", "-f", "png", "--width", "2000", "-b", "40", "-o", "a.preview.png"]);
  });

  it("caps the final raster at about MAX_FINAL_RASTER_PIXELS by lowering the scale", () => {
    // 3000x2000 content at scale 2 would be ~25M pixels.
    const scale = cappedScale(2, 40, 3000, 2000);
    expect(scale).toBeLessThan(2);
    expect(scale * 3080 * (scale * 2080)).toBeLessThanOrEqual(MAX_FINAL_RASTER_PIXELS);
    expect(scale * 3080 * (scale * 2080)).toBeGreaterThan(MAX_FINAL_RASTER_PIXELS * 0.97);
    const big = planExport({ input: "a.drawio" }, "darwin", false, 3000, 2000);
    const width = Number(big.args[big.args.indexOf("--width") + 1]);
    expect(width).toBe(Math.round(3000 * scale + 2 * Math.round(40 * scale)));

    // A scale-1 export that is still too large is sized down by width as well.
    const one = planExport({ input: "a.drawio", scale: 1 }, "darwin", false, 4000, 3000);
    expect(one.args).toContain("--width");
    expect(one.args).not.toContain("-s");

    // Small diagrams and unknown heights retain the requested scale. Explicit widths are budgeted, too.
    expect(cappedScale(2, 40, 1000, 800)).toBe(2);
    expect(cappedScale(2, 40, 3000)).toBe(2);
    const fixed = planExport({ input: "a.drawio", width: 5000 }, "darwin", false, 3000, 2000).args;
    const explicitWidth = Number(fixed[fixed.indexOf("--width") + 1]);
    expect(explicitWidth).toBeLessThan(5000);
    expect(explicitWidth * (Math.ceil((explicitWidth - 80) * 2 / 3) + 80)).toBeLessThanOrEqual(MAX_FINAL_RASTER_PIXELS);
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

  it("on Linux keeps the sandbox and refuses root with actionable advice", () => {
    expect(planExport({ input: "a.drawio" }, "linux", false).linuxExtra).toEqual(["--disable-gpu"]);
    expect(() => planExport({ input: "a.drawio" }, "linux", true)).toThrow("unprivileged user");
  });
});

describe("exportDiagram source protection", () => {
  it.each(["same path", "file symlink", "directory symlink", "hard link"])(
    "rejects an output alias (%s) before starting the CLI",
    async (alias) => {
      const dir = await mkdtemp(join(tmpdir(), "drawme-source-alias-"));
      try {
        const input = join(dir, "source.drawio");
        const marker = join(dir, "started");
        const binary = join(dir, "fake-drawio.mjs");
        const source = "<mxfile/>";
        await writeFile(input, source);
        await writeFile(binary, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "started");\nconsole.log("30.0.0");\n`);
        useFakeDrawio(binary);
        let output = input;
        if (alias === "file symlink") {
          output = join(dir, "symlink.png");
          await symlink(input, output);
        } else if (alias === "directory symlink") {
          const directoryAlias = join(dir, "alias");
          await symlink(dir, directoryAlias, "junction");
          output = join(directoryAlias, "source.drawio");
        } else if (alias === "hard link") {
          output = join(dir, "hardlink.png");
          await link(input, output);
        }
        await expect(exportDiagram({ input, output, mode: "preview", binary })).rejects.toThrow("output aliases the input");
        expect(existsSync(marker)).toBe(false);
        expect(await readFile(input, "utf8")).toBe(source);
        expect(await readFile(output, "utf8")).toBe(source);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("exportDiagram publication", () => {
  it.each([
    { name: "explicit final", mode: "final", derived: false, existing: true },
    { name: "derived final", mode: "final", derived: true, existing: true },
    { name: "explicit final with a missing target", mode: "final", derived: false, existing: false },
    { name: "explicit preview", mode: "preview", derived: false, existing: true },
  ] as const)("publishes through the $name symlink without replacing it", async ({ mode, derived, existing }) => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-linked-output-"));
    try {
      const input = join(dir, "source.drawio");
      const output = join(dir, derived ? "source.svg" : "linked.svg");
      const linkTarget = join("artifacts", "final.svg");
      const target = join(dir, linkTarget);
      const binary = await makeFakeDrawio(dir);
      await mkdir(join(dir, "artifacts"));
      await writeFile(input, "<mxfile/>");
      if (existing) await writeFile(target, SVG);
      await symlink(linkTarget, output);

      const result = await exportDiagram({ input, output: derived ? undefined : output, mode, format: "svg", binary });
      expect(result.output).toBe(output);
      expect(await readlink(output)).toBe(linkTarget);
      const published = await readFile(target, "utf8");
      expect(published).toContain("data-drawme-margin");

      if (mode === "preview") {
        const final = await exportDiagram({ input, format: "svg", binary });
        expect(final.removedPreviews).toEqual([]);
        expect(await readlink(output)).toBe(linkTarget);
        expect(await readFile(target, "utf8")).toBe(published);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an output ending in a directory separator without creating the stripped path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-directory-output-"));
    try {
      const input = join(dir, "source.drawio");
      const output = join(dir, "missing.svg");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");

      await expect(exportDiagram({ input, output: `${output}${sep}`, format: "svg", binary })).rejects.toThrow("must name a file");
      expect(existsSync(output)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { change: "the output link is retargeted", error: "export destination changed" },
    { change: "the target becomes a hard link to the source", error: "output aliases the input" },
  ])("does not publish when $change during rendering", async ({ change, error }) => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-changed-symlink-"));
    try {
      const input = join(dir, "source.drawio");
      const output = join(dir, "linked.svg");
      const target = join(dir, "final.svg");
      const other = join(dir, "other.svg");
      const source = "<mxfile/>";
      const retarget = change === "the output link is retargeted";
      const update = retarget
        ? `unlinkSync(${JSON.stringify(output)}); symlinkSync(${JSON.stringify(other)}, ${JSON.stringify(output)});`
        : `unlinkSync(${JSON.stringify(target)}); linkSync(${JSON.stringify(input)}, ${JSON.stringify(target)});`;
      const binary = await makeFakeDrawio(dir, `${renderImage}\n${update}`);
      await writeFile(input, source);
      await writeFile(target, SVG);
      await writeFile(other, SVG);
      await symlink(target, output);

      await expect(exportDiagram({ input, output, format: "svg", binary })).rejects.toThrow(error);
      expect(await readlink(output)).toBe(retarget ? other : target);
      expect(await readFile(input, "utf8")).toBe(source);
      expect(await readFile(target, "utf8")).toBe(retarget ? SVG : source);
      expect(await readFile(other, "utf8")).toBe(SVG);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("preserves the private mode of a refreshed export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-private-output-"));
    try {
      const input = join(dir, "source.drawio");
      const output = join(dir, "private.svg");
      const binary = await makeFakeDrawio(dir, `${renderImage}\nchmodSync(output, 0o664);`);
      await writeFile(input, "<mxfile/>");
      await writeFile(output, SVG);
      await chmod(output, 0o600);

      await exportDiagram({ input, output, format: "svg", binary });
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(await readFile(output, "utf8")).toContain("data-drawme-margin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Root can write a mode-0444 file; Windows does not use POSIX access modes.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("does not replace an unwritable export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-unwritable-output-"));
    try {
      const input = join(dir, "source.drawio");
      const output = join(dir, "unwritable.svg");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");
      await writeFile(output, SVG);
      await chmod(output, 0o444);
      await expect(access(output, constants.W_OK)).rejects.toMatchObject({ code: "EACCES" });

      await expect(exportDiagram({ input, output, format: "svg", binary })).rejects.toMatchObject({ code: "EACCES" });
      expect(await readFile(output, "utf8")).toBe(SVG);
      expect((await stat(output)).mode & 0o777).toBe(0o444);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "no new output", format: "png", render: "", error: "output was not created" },
    { name: "a directory instead of a file", format: "pdf", render: "mkdirSync(output);", error: "not a regular file" },
    { name: "a partial PDF", format: "pdf", render: 'writeFileSync(output, "%PDF-1.7");', error: "not a complete PDF" },
    { name: "a partial JPG", format: "jpg", render: 'writeFileSync(output, Buffer.from([255, 216, 1, 2, 3]));', error: "not a complete JPG" },
    { name: "an empty PNG", format: "png", render: 'writeFileSync(output, "");', error: "not a complete PNG" },
    { name: "an incomplete PNG body", format: "png", render: `writeFileSync(output, Buffer.from("${TINY_PNG}", "base64").subarray(0, 49));`, error: "not a complete PNG" },
    { name: "non-SVG text at zero margin", format: "svg", render: 'writeFileSync(output, "<mxfile/>");', error: "SVG post-processing failed" },
    { name: "partial output followed by CLI failure", format: "png", render: 'writeFileSync(output, "partial"); process.exit(1);', error: "draw.io export failed" },
  ] as const)("keeps the old output when the renderer produces $name", async ({ format, render, error }) => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-publication-"));
    try {
      const input = join(dir, "source.drawio");
      const output = join(dir, `existing.${format}`);
      const good = format === "png" ? Buffer.from(TINY_PNG, "base64") : Buffer.from(SVG);
      const binary = await makeFakeDrawio(dir, render);
      await writeFile(input, "<mxfile/>");
      await writeFile(output, good);
      const entries = await readdir(dir);

      await expect(exportDiagram({ input, output, format, border: 0, binary })).rejects.toThrow(error);
      expect(await readFile(output)).toEqual(good);
      expect(await readdir(dir)).toEqual(entries);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exportDiagram animated SVG", () => {
  it("compiles and verifies a portable sequence after CLI export", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-animated-export-"));
    try {
      const input = join(dir, "sequence.drawio");
      const output = join(dir, "sequence.svg");
      const binary = join(dir, "fake-drawio.mjs");
      const animation = JSON.stringify({
        animation: {
          loop: false,
          steps: [
            { opacity: { cells: ["a"], value: 0 } },
            { fadeIn: { cells: ["a"], delay: 500 } },
          ],
        },
      }).replaceAll('"', "&quot;");
      await writeFile(
        input,
        `<mxfile><diagram name="Animated"><mxGraphModel><root>
          <UserObject label="" id="0" animation="${animation}"><mxCell/></UserObject>
          <mxCell id="1" parent="0"/>
          <mxCell id="a" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
        </root></mxGraphModel></diagram></mxfile>`,
      );
      await writeFile(
        binary,
        `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) process.stdout.write("31.0.0\\n");
else writeFileSync(args[args.indexOf("-o") + 1], '<svg xmlns="http://www.w3.org/2000/svg" width="80px" height="40px" viewBox="0 0 80 40"><defs/><g data-cell-id="a"><rect width="80" height="40"/></g></svg>');
`,
      );
      useFakeDrawio(binary);

      const result = await exportDiagram({ input, output, animated: true, binary });
      const svg = await readFile(output, "utf8");
      expect(result).toMatchObject({ format: "svg", animated: true });
      expect(result.animation).toMatchObject({ sequenceCompiled: true, verified: true, sequenceDurationMs: 500 });
      expect(svg).toContain("data-drawme-animation");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not publish a misleading static result when animation verification fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-animation-failure-"));
    try {
      const input = join(dir, "static.drawio");
      const output = join(dir, "static.svg");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile><diagram><mxGraphModel><root><mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/></root></mxGraphModel></diagram></mxfile>");
      await expect(exportDiagram({ input, output, animated: true, binary })).rejects.toThrow(
        "animated SVG verification failed",
      );
      expect(existsSync(output)).toBe(false);

      const preview = await exportDiagram({ input, mode: "preview", binary });
      const oldPreview = await readFile(preview.output);
      await writeFile(output, SVG);
      await expect(exportDiagram({ input, output, animated: true, binary })).rejects.toThrow("animated SVG verification failed");
      expect(await readFile(output, "utf8")).toBe(SVG);
      expect(await readFile(preview.output)).toEqual(oldPreview);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("exportDiagram preview cleanup", () => {
  it("keeps default previews separate from existing final exports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-default-preview-"));
    try {
      const input = join(dir, "source.drawio");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");
      const png = await exportDiagram({ input, binary });
      const pngBytes = await readFile(png.output);
      const svg = await exportDiagram({ input, format: "svg", binary });
      const svgBytes = await readFile(svg.output);

      const pngPreview = await exportDiagram({ input, mode: "preview", embed: true, binary });
      expect(pngPreview.embed).toBe(false);
      expect(pngPreview.output).not.toBe(png.output);
      const svgPreview = await exportDiagram({ input, mode: "preview", format: "svg", binary });
      expect(svgPreview.output).not.toBe(svg.output);
      const final = await exportDiagram({ input, format: "svg", output: join(dir, "another.svg"), binary });
      expect(final.removedPreviews).toEqual([svgPreview.output]);
      expect(await readFile(png.output)).toEqual(pngBytes);
      expect(await readFile(svg.output)).toEqual(svgBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a default preview that would take another source's default final path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-default-preview-collision-"));
    try {
      const input = join(dir, "drawing.drawio");
      const otherInput = join(dir, "drawing.preview.drawio");
      const otherSvg = SVG.replace("100px", "175px");
      const binary = await makeFakeDrawio(dir, `writeFileSync(output, ${JSON.stringify(otherSvg)});`);
      await writeFile(input, "<mxfile/>");
      await writeFile(otherInput, "<mxfile/>");
      const otherFinal = await exportDiagram({ input: otherInput, format: "svg", binary });
      const delivered = await readFile(otherFinal.output);
      await makeFakeDrawio(dir);

      await expect(exportDiagram({ input, mode: "preview", format: "svg", binary })).rejects.toThrow("preview destination is already in use");
      expect(await readFile(otherFinal.output)).toEqual(delivered);
      const final = await exportDiagram({ input, format: "svg", binary });
      expect(final.removedPreviews).not.toContain(otherFinal.output);
      expect(await readFile(otherFinal.output)).toEqual(delivered);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not delete another source's final at a previous preview path, including through aliases", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-shared-output-"));
    try {
      const a = join(dir, "a.drawio");
      const b = join(dir, "b.drawio");
      const shared = join(dir, "shared.png");
      const alias = join(dir, "alias");
      await symlink(dir, alias, "junction");
      const binary = await makeFakeDrawio(dir);
      await writeFile(a, "<mxfile/>");
      await writeFile(b, "<mxfile/>");
      await exportDiagram({ input: a, mode: "preview", output: shared, binary });
      await exportDiagram({ input: b, output: join(alias, "shared.png"), binary });
      const finalBytes = await readFile(shared);

      const next = await exportDiagram({ input: a, mode: "preview", binary });
      expect(next.removedPreviews).toEqual([]);
      expect(await readFile(shared)).toEqual(finalBytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
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
        expect(result.replacedPreview).toBe(index > 0);
        expect(result.previewCleanupWarnings).toEqual([]);
      }

      // A same-path re-export removes nothing but still counts as a replacement.
      const samePath = await exportDiagram({ input, mode: "preview", output: previews.at(-1)!, binary });
      expect(samePath.removedPreviews).toEqual([]);
      expect(samePath.replacedPreview).toBe(true);

      const result = await exportDiagram({ input, format: "svg", mode: "final", output: finalOutput, binary });

      expect(existsSync(finalOutput)).toBe(true);
      expect(previews.every((output) => !existsSync(output))).toBe(true);
      expect(result.removedPreviews).toEqual([previews.at(-1)]);
      expect(result.replacedPreview).toBe(false);
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

  it("keeps a preview path that the user edited in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-edited-preview-"));
    try {
      const input = join(dir, "source.drawio");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");
      const preview = await exportDiagram({ input, mode: "preview", binary });
      await writeFile(preview.output, "user edit");

      const final = await exportDiagram({ input, format: "svg", binary });
      expect(final.removedPreviews).toEqual([]);
      expect(await readFile(preview.output, "utf8")).toBe("user edit");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not reclaim a user replacement after a prior cleanup warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-retained-previews-"));
    try {
      const input = join(dir, "example.drawio");
      const first = join(dir, "first.png");
      const second = join(dir, "second.png");
      const latest = join(dir, "latest.png");
      const binary = await makeFakeDrawio(dir);
      await writeFile(input, "<mxfile/>");
      await exportDiagram({ input, mode: "preview", output: first, binary });
      await rm(first);
      await mkdir(first);
      await exportDiagram({ input, mode: "preview", output: second, binary });
      await rm(first, { recursive: true });
      await writeFile(first, "retained preview");
      const result = await exportDiagram({ input, mode: "preview", output: latest, binary });
      expect(result.removedPreviews).toEqual([second]);
      expect(result.previewCleanupWarnings).toEqual([]);
      expect(await readFile(first, "utf8")).toBe("retained preview");
      expect(existsSync(second)).toBe(false);
      expect(existsSync(latest)).toBe(true);
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
      await writeFile(input, "<mxfile/>");
      const binary = await makeFakeDrawio(dir);
      await exportDiagram({ input, mode: "preview", output: previous, binary });
      await makeFakeDrawio(dir, 'writeFileSync(output, "partial"); process.exit(1);');
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
