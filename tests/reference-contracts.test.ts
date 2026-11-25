import { readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { cappedScale, checkRasterSize, MAX_FINAL_RASTER_PIXELS } from "../src/export-size";
import drawme from "../src/index";
import { compileMotion, parseMotionSpec, type MotionCell, type MotionSpec, type MotionStep } from "../src/motion";
import { sampleFrames } from "../src/storyboard";
import { validateXml } from "../src/validate";
import { DEFAULT_MAX_XML_BYTES } from "../src/xml-input";
import { installNodeRendererFixture, makeMockPi, TINY_PNG } from "./fixtures";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const reference = read("docs/reference.md");
const authoring = (name: string) => read(`assets/references/${name}.md`);

function section(text: string, heading: string) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `documented section ${heading}`).toBeGreaterThanOrEqual(0);
  const depth = heading.indexOf(" ");
  const end = lines.findIndex((line, i) => i > start && /^#+ /.test(line) && line.indexOf(" ") <= depth);
  return lines.slice(start + 1, end < 0 ? lines.length : end).join("\n");
}

function capture(text: string, pattern: RegExp, contract: string) {
  const value = pattern.exec(text)?.[1];
  expect(value, contract).toBeDefined();
  return value!;
}

function quantity(text: string, pattern: RegExp, contract: string) {
  return Number(capture(text, pattern, contract).replaceAll(",", ""));
}

const toolSection = (name: string) => section(reference, `### \`${name}\``);

function registration() {
  const { pi, tools, commands } = makeMockPi();
  drawme(pi as never);
  return { tools, commands };
}

async function workspace() {
  const tmp = await mkdtemp(join(tmpdir(), "drawme reference contracts "));
  onTestFinished(() => rm(tmp, { recursive: true, force: true }));
  const cwd = await realpath(tmp);
  const { tools, commands } = registration();
  const ctx = { cwd, model: { input: ["text", "image"] } };
  return {
    cwd, ctx, commands,
    put: (name: string, value: string) => writeFile(join(cwd, name), value),
    call: (name: string, args: object = {}, context: object = ctx) => tools.get(name)!.execute(name, args, undefined, undefined, context),
  };
}

type Workspace = Awaited<ReturnType<typeof workspace>>;
async function fixtureRenderer(session: Workspace, version: string) {
  const fixture = "reference renderer.cjs";
  const binary = join(session.cwd, fixture);
  await session.put(fixture, `const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") console.log(${JSON.stringify(version)});
else if (args.includes("-o") && args.includes("png")) {
  writeFileSync(args[args.indexOf("-o") + 1], Buffer.from(${JSON.stringify(TINY_PNG)}, "base64"));
} else process.exitCode = 2;
`);
  vi.stubEnv("DISPLAY", ":99");
  vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
  const restore = installNodeRendererFixture([binary]);
  onTestFinished(() => {
    restore();
    vi.unstubAllEnvs();
  });
}

const page = (cells = "") => `<diagram><mxGraphModel page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram>`;
const diagram = (...pages: string[]) => `<mxfile>${pages.join("")}</mxfile>`;

it("documents the registered export options, file-only destination and JPEG editability", async () => {
  const exportDoc = toolSection("drawio_export");
  const options = section(exportDoc, "#### Options");
  const documented = [...options.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map(([, name]) => name);
  const schema = registration().tools.get("drawio_export")!.parameters.properties;
  expect(documented.sort()).toEqual(Object.keys(schema).sort());
  expect(schema).toHaveProperty("width.type", "number");
  expect(schema).not.toHaveProperty("height");
  expect(schema).toHaveProperty("pageIndex.minimum", 1);
  expect(schema).toHaveProperty("pageIndex.type", "integer");
  expect(options).toMatch(/^\| `width` .*Overrides `scale`; `height` is not a public tool option/m);
  expect(options).toMatch(/^\| `pageIndex` .*1-based.*27\.0\.2 or later/m);
  expect(options).toMatch(/^\| `output` .*file, not a directory.*suffix must match `format`/m);
  expect(exportDoc).toMatch(/Final JPG rejects `embed: true` and is never editable/i);
  expect(section(read("CHANGELOG.md"), "## [Unreleased]")).toMatch(/public export tool exposes `width`, not `height`/i);

  const session = await workspace();
  const input = "source.drawio";
  await session.put(input, diagram(page()));
  await mkdir(join(session.cwd, "directory.pdf"));
  for (const [params, failure] of [
    [{ format: "pdf", output: "directory.pdf" }, /^Export failed:.*not a regular file/i],
    [{ format: "png", output: "wrong.svg" }, /^Export failed:.*(?:extension|suffix)/i],
    [{ format: "jpg", embed: true }, /^Export failed:.*JPG.*embed/i],
  ] as const) {
    const result = await session.call("drawio_export", { input, ...params });
    expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(failure) }]);
  }
});

it("checks documented raster caps on both axes and distinguishes SVG and PDF sizing", () => {
  const size = section(toolSection("drawio_export"), "#### Size and margins");
  const area = quantity(size, /pixel budget is ([\d,]+) pixels/i, "documented raster area");
  const previewSides = /long side (?:is capped )?at ([\d,]+) px by default,? or ([\d,]+) px (?:with an explicit `width`|when width is supplied)/i;
  const sides = previewSides.exec(size)?.slice(1);
  expect(sides, "documented default and explicit preview side limits").toHaveLength(2);
  const changelog = section(read("CHANGELOG.md"), "## [Unreleased]");
  expect(quantity(changelog, /enforce a ([\d,]+)-pixel budget including margins/i, "changelog raster area")).toBe(area);
  expect(previewSides.exec(changelog)?.slice(1), "changelog preview side limits").toEqual(sides);
  expect(area).toBe(MAX_FINAL_RASTER_PIXELS);
  expect(size).toMatch(/including both margins on both axes.*lowers the final raster scale.*explicit `width`.*includes both margins/i);
  expect(size).toMatch(/\*\*SVG:\*\* `width`.*before padding.*`border` on both sides/i);
  expect(size).toMatch(/\*\*PDF:\*\*.*page bounds.*media box.*fit the source canvas first/i);

  for (const [raw, width] of [[sides![0], undefined], [sides![1], 5000]] as const) {
    const cap = Number(raw.replaceAll(",", ""));
    const opts = { input: "unused.drawio", width };
    for (const [w, h] of [[cap, 640], [640, cap]]) {
      expect(() => checkRasterSize(opts, "preview", w, h)).not.toThrow();
    }
    for (const [w, h] of [[cap + 1, 640], [640, cap + 1]]) {
      expect(() => checkRasterSize(opts, "preview", w, h)).toThrow(/preview limit/);
    }
  }
  const scale = cappedScale(2, 40, 2400, 1800);
  expect(scale).toBeLessThan(2);
  expect((2400 + 80) * (1800 + 80) * scale ** 2).toBeLessThanOrEqual(area);
  expect(() => checkRasterSize({ input: "unused.drawio", width: area }, "final", area + 1, 1)).toThrow(/pixel budget/);
});

const motionDocs = () => [
  ["reference", section(toolSection("drawio_animate"), "#### Behavior")],
  ["XML authoring", section(authoring("xml-authoring"), "### Motion with `drawio_animate`")],
] as const;
const cells = new Map<string, MotionCell>(["a", "b"].map((id) => [id, { kind: "vertex", style: "", parent: null }]));
const fade = { effect: "fadeIn", cells: ["a"], duration: 1 } satisfies MotionStep;
const wait = (duration: number): MotionStep => ({ effect: "wait", duration });

function analyze(spec: MotionSpec) {
  const errors: string[] = [];
  const parsed = parseMotionSpec(spec, errors);
  return parsed && !errors.length ? compileMotion(parsed, cells) : { compiled: null, errors };
}

describe("documented motion boundaries", () => {
  it("matches the maximum step count, hold, stagger, visual duration and pre-hold timeline", () => {
    const limits = motionDocs().map(([doc, text]) => {
      expect(text, doc).toMatch(/wait.*requires a duration and may be zero/i);
      return {
        count: quantity(text, /\b1[–-]([\d,]+) steps/, `${doc}: step count`),
        holdAndStagger: quantity(text, /`hold` and `stagger`[^.]*?\b0[–-]([\d,]+) ms/, `${doc}: hold and stagger`),
        visual: quantity(text, /positive[^.;\n]*?at most ([\d,]+) ms/i, `${doc}: visual duration`),
        total: quantity(text, /\bsequence[^.]*?(?:within|at most) ([\d,]+) ms/i, `${doc}: sequence duration`),
      };
    });
    expect(limits[0]).toEqual(limits[1]);
    const { count, holdAndStagger, visual, total } = limits[0];

    const steps = [fade, ...Array.from({ length: count - 1 }, () => wait(0))];
    expect(analyze({ steps }).compiled?.sequenceMs).toBe(1);
    expect(analyze({ steps: [...steps, wait(0)] }).errors).toEqual([expect.stringContaining(`maximum ${count}`)]);
    const timed = { ...fade, duration: visual, cells: ["a", "b"], stagger: holdAndStagger };
    expect(analyze({ steps: [timed], hold: holdAndStagger }).compiled?.durationMs).toBe(visual + 2 * holdAndStagger);
    const invalid: [MotionSpec, string][] = [
      [{ steps: [timed], hold: holdAndStagger + 1 }, "hold"],
      [{ steps: [{ ...timed, stagger: holdAndStagger + 1 }] }, "stagger"],
      [{ steps: [{ ...timed, duration: visual + 1 }] }, "duration"],
      [{ steps: [{ ...fade, duration: 0 }] }, "duration"],
    ];
    for (const [spec, name] of invalid) {
      expect(analyze(spec).errors).toEqual([expect.stringContaining(`${name} must be between`)]);
    }
    const timeline: MotionStep[] = [fade];
    for (let remaining = total - 1; remaining > 0; remaining -= visual) timeline.push(wait(Math.min(remaining, visual)));
    expect(analyze({ steps: timeline, hold: holdAndStagger }).compiled?.durationMs).toBe(total + holdAndStagger);
    expect(analyze({ steps: [...timeline, wait(1)] }).errors).toEqual([expect.stringContaining(`maximum ${total} ms`)]);
  });

  it("samples visual batches including dim-to-fade, omitting wait tiles and retaining the endpoints", () => {
    const documented = motionDocs().map(([doc, text]) => {
      expect(text, doc).toMatch(/parallel[^.]*?(?:share|same)[^.]*?tile/i);
      expect(text, doc).toMatch(/standalone waits[^.]*?no tile/i);
      expect(text, doc).toMatch(/fadeIn[^.]*?restore a dimmed cell/i);
      expect(text, doc).toContain(".storyboard.png");
      expect(text, doc).toContain("<output>.page-<pageIndex>.board.png");
      expect(text, doc).toMatch(/unresolved[^.]*?imag[^.]*?(?:standalone|embed)|refuse[^.]*?unresolved linked images/i);
      return quantity(text, /up to (\d+) (?:frames|visual batches)/i, `${doc}: sampled storyboard cap`);
    });
    expect(documented[0]).toBe(documented[1]);
    const cap = documented[0];
    const { compiled, errors } = analyze({ steps: [
      { effect: "dim", cells: ["a"], duration: 10, value: 0.25 },
      { effect: "fadeIn", cells: ["b"], duration: 10, parallel: true },
      wait(20), { ...fade, duration: 10 },
      ...Array.from({ length: cap }, (): MotionStep => ({ effect: "highlight", cells: ["a"], duration: 10 })),
    ] });
    expect(errors).toEqual([]);
    const frames = compiled!.frames;
    expect(frames).toHaveLength(cap + 2);
    expect(frames.slice(0, 2).map(({ time, opacity }) => [time, opacity.get("a"), opacity.get("b")])).toEqual([[10, 0.25, 1], [40, 1, 1]]);
    const samples = sampleFrames(frames);
    expect(samples).toHaveLength(cap);
    expect([samples[0], samples.at(-1)]).toEqual([frames[0], frames.at(-1)]);
  });
});

it("describes native command animation and gives the same stored-motion alternative as command help", async () => {
  const commands = section(reference, "## Commands");
  const row = commands.split("\n").find((line) => line.startsWith("| `/drawme-export"));
  expect(row).toMatch(/animated-svg.*native draw\.io page sequences or connector flow only/i);
  expect(row).toMatch(/stored DrawMe motion.*use `drawio_animate`.*omit `steps`/i);
  const notify = vi.fn();
  await registration().commands.get("drawme-export")!.handler("", { ui: { notify } });
  expect(notify).toHaveBeenCalledWith(expect.stringMatching(/animated-svg only supports native draw\.io page sequences or connector flow.*stored DrawMe motion.*drawio_animate.*omit steps/i), "info");
});

it("agrees with capability probes on the minimum version for Mermaid and layout", async () => {
  const mermaid = authoring("mermaid-authoring");
  const mermaidNotations = authoring("diagram-types").split("\n").filter((line) => /\bMermaid\b/.test(line)).join("\n");
  const capabilities = [toolSection("drawio_from_mermaid"), toolSection("drawio_layout"), mermaid, mermaidNotations];
  const versions = capabilities.flatMap((doc) => {
    const matches = [...doc.matchAll(/draw\.io (\d+\.\d+\.\d+) or later/g)].map(([, version]) => version);
    expect(matches.length, "version-gated authoring guidance").toBeGreaterThan(0);
    return matches;
  });
  expect(new Set(versions)).toEqual(new Set(["30.2.4"]));
  expect(mermaid).toMatch(/supportsMermaid: true/);
  expect(mermaid).toMatch(/supportsLayout: true/);
  expect(mermaid).toMatch(/Run `drawio_fit_canvas` on the imported\s+finite pages/i);

  const session = await workspace();
  await fixtureRenderer(session, "30.2.3");
  const check = () => session.call("drawio_check");
  const notify = vi.fn();
  const checkCommand = () => session.commands.get("drawme-check")!.handler("", { ...session.ctx, ui: { notify } });
  expect((await check()).details).toMatchObject({ version: "30.2.3", supportsMermaid: false, supportsLayout: false });
  await checkCommand();
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/Mermaid import: unsupported; ELK layout: unsupported/), "info");
  await session.put("reference renderer.cjs", `console.log(${JSON.stringify(versions[0])});\n`);
  expect((await check()).details).toMatchObject({ version: versions[0], supportsMermaid: true, supportsLayout: true });
  await checkCommand();
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/Mermaid import: supported; ELK layout: supported/), "info");
});

it("documents exactly one Mermaid source and reports invalid combinations before conversion", async () => {
  for (const doc of [toolSection("drawio_from_mermaid"), authoring("mermaid-authoring")]) {
    expect(doc).toMatch(/exactly one of `mermaid`[^\n]*?or `input`/i);
  }
  expect(toolSection("drawio_from_mermaid")).toMatch(/inline Mermaid: `diagram\.drawio` in the Pi session's working directory/i);
  const session = await workspace();
  await fixtureRenderer(session, "30.2.4");
  await session.put("source.mmd", "flowchart LR\nA[From file] --> B");
  for (const args of [{ input: "source.mmd", mermaid: "graph TD\nX[Inline] --> Y" }, {}, { mermaid: " " }]) {
    const result = await session.call("drawio_from_mermaid", args);
    expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/^Mermaid conversion failed:.*exactly one/i) }]);
    await expect(access(join(session.cwd, "diagram.drawio"))).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("separates transcript review from process-local preview retirement across session pages", async () => {
  const review = section(toolSection("drawio_export"), "#### Preview review and cleanup");
  expect(section(reference, "## Commands")).toMatch(/Relative input and output paths resolve from the calling Pi session's working directory/i);
  expect(review).toMatch(/actually attached prior preview of the same source and page on the current conversation branch/i);
  expect(review).toMatch(/transcript independently of the files on disk/i);
  expect(review).toMatch(/owned and tracked by the current process, per source, not per page.*does not survive a restart/i);
  expect(review).toMatch(/Text-only or unknown models get no attachment.*final.*text-only/i);

  const session = await workspace();
  await fixtureRenderer(session, "32.4.1");
  const input = "review.drawio";
  await session.put(input, diagram(page(), page()));
  const first = await session.call("drawio_export", { input, mode: "preview", pageIndex: 1 });
  const firstPath = join(session.cwd, "review.preview.png");
  expect(first.details).toMatchObject({ output: firstPath, imageAttached: true, pageIndex: 1 });
  const sessionManager = { buildSessionProjection: () => ({
    messages: [{ ...first, role: "toolResult", toolName: "drawio_export", isError: false }],
  }) };
  const next = await session.call("drawio_export", { input, mode: "preview", pageIndex: 2, output: "page 2.png" }, { ...session.ctx, sessionManager });
  expect(next.details).toMatchObject({ pageIndex: 2, removedPreviews: [firstPath], imageAttached: true });
  expect(next.content[0]).toMatchObject({ text: expect.stringContaining("Critique it") });
  expect(first.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  await expect(access(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("identifies an incomplete validation as blocking and keeps unchecked routes separate from crossings", async () => {
  const text = toolSection("drawio_validate");
  expect(text).toMatch(/unchecked auto-routes:.*does not mean a crossing was detected/i);
  expect(text).toMatch(/predicted straight-line connection.*hint for preview review, not proof/i);
  expect(text).toMatch(/`incomplete: true`.*blocking `Validation incomplete:`.*Do not treat a partial score as clean\..*reduce or split/i);
  const limit = quantity(text, /intake limit is (\d+) MiB/i, "documented XML intake cap") * 1024 ** 2;
  expect(limit).toBe(DEFAULT_MAX_XML_BYTES);
  const session = await workspace();
  const input = "bounds.drawio";
  await session.put(input, "");
  await truncate(join(session.cwd, input), limit + 1);
  const stopped = await session.call("drawio_validate", { input });
  expect(stopped.details).toMatchObject({ incomplete: true, errors: [expect.stringContaining(`${limit} byte limit`)] });
  expect(stopped.content[0]).toMatchObject({ text: expect.stringMatching(/^Validation incomplete:[\s\S]*Partial readability score:/) });

  const vertex = (id: string, x: number) => `<mxCell id="${id}" vertex="1" parent="1"><mxGeometry x="${x}" y="50" width="80" height="40" as="geometry"/></mxCell>`;
  const route = '<mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>';
  await session.put(input, diagram(page(vertex("a", 20) + vertex("blocker", 170) + vertex("b", 320) + route)));
  const checked = await session.call("drawio_validate", { input });
  expect(checked.details).toMatchObject({ incomplete: false, errors: [], score: { crossings: 0, through: 0 } });
  expect(checked.content[0]).toMatchObject({ text: expect.stringMatching(/Actionable warnings[^]*auto-routed edge\(s\) cannot be route-checked[^]*Informational observations[^]*predicted from the direct line/i) });
});

it("matches the documented per-page cell and per-document diagnostic limits", () => {
  const text = toolSection("drawio_validate");
  const maxCells = quantity(text, /up to ([\d,]+) cells per page/i, "documented cell cap");
  const maxDiagnostics = quantity(text, /a diagnostic budget of ([\d,]+) across the document/i, "documented diagnostic cap");
  // Empty layers avoid the separate pairwise-work limit; two root cells count toward the page size.
  const layers = Array.from({ length: maxCells - 2 }, (_, i) => `<mxCell id="layer${i}" parent="0"/>`).join("");
  expect(validateXml(diagram(page(layers)), { maxWork: 1_000_000 }).incomplete).toBe(false);
  const extra = '<mxCell id="extra" parent="0"/>';
  expect(validateXml(diagram(page(layers + extra)))).toMatchObject({
    incomplete: true, errors: [expect.stringMatching(new RegExp(`^Validation incomplete:.*${maxCells} cells`))],
  });

  // Each page contributes exactly one diagnostic; the incomplete marker is additional.
  const broken = "<diagram><mxGraphModel/></diagram>";
  expect(validateXml(`<mxfile>${broken.repeat(maxDiagnostics)}</mxfile>`)).toMatchObject({ incomplete: false });
  const stopped = validateXml(`<mxfile>${broken.repeat(maxDiagnostics + 1)}</mxfile>`);
  expect(stopped.incomplete).toBe(true);
  expect(stopped.errors).toHaveLength(maxDiagnostics + 1);
  expect(stopped.errors.at(-1)).toMatch(/^Validation incomplete:.*diagnostics budget exceeded/i);
});

it("lists all registered text failure prefixes, not validation diagnostics", async () => {
  const failure = section(reference, "## Failure results");
  const documented = [...failure.matchAll(/`([^`]+ failed:)`/g)].map(([, prefix]) => prefix);
  const session = await workspace();
  const input = "missing.drawio";
  const cases = [
    ["drawio_export", { input }], ["drawio_animate", { input }], ["drawio_fit_canvas", { input }],
    ["drawio_layout", { input, preset: "horizontalFlow" }], ["drawio_from_mermaid", {}],
    ["drawio_explain", { input }], ["drawio_open", { path: input }],
  ] as const;
  const observed = [];
  for (const [name, args] of cases) {
    const { content } = await session.call(name, args);
    expect(content, name).toHaveLength(1);
    const text = content[0].type === "text" ? content[0].text : "";
    observed.push(capture(text, /^([^:\n]+ failed:)/, `${name}: text failure prefix`));
  }
  expect(documented.sort()).toEqual(observed.sort());
  expect(failure).toMatch(/Validation instead reports diagnostics and explicitly marks incomplete results/i);
});

it("recommends a native, unprivileged, sandboxed renderer on Linux and WSL without testing desktop-open advice", () => {
  const troubleshooting = authoring("troubleshooting");
  const linuxRows = troubleshooting.split("\n").filter((line) => /^\| Linux:/.test(line));
  const wslRendererRows = troubleshooting.split("\n").filter((line) => /^\| WSL2?:[^|]*(?:draw\.?io|CLI|renderer)/i.test(line));
  const locate = section(troubleshooting, "## WSL2 / Windows specifics")
    .split(/(?=^\*\*[^*]+\.\*\*)/m).find((entry) => entry.startsWith("**Locate the CLI.**")) ?? "";
  expect(linuxRows).toContainEqual(expect.stringMatching(/native Linux draw\.io as an unprivileged user.*sandbox enabled/i));
  expect(linuxRows).toContainEqual(expect.stringMatching(/Xvfb.*`xvfb-run`.*headless discovery and rendering/i));
  expect(wslRendererRows).toContainEqual(expect.stringMatching(/Install draw\.io desktop in the WSL Linux distribution.*Windows executable is not a supported renderer/i));
  expect(locate).toMatch(/native Linux draw\.io as an unprivileged user, with the\s+sandbox enabled/i);
  expect(locate).toMatch(/Xvfb.*`xvfb-run`/i);
  expect([...linuxRows, ...wslRendererRows, locate].join("\n")).not.toMatch(/--no-sandbox|\/mnt\/c|(?:drawio|draw\.io)\.exe|cmd\.exe/i);
});
