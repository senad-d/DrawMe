import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { analyzeAnimationPage, analyzeDrawioAnimation, enhanceAnimatedSvg } from "../src/animation";
import { DEFAULT_VALIDATION_LIMITS, ValidationStop, createValidationBudget } from "../src/diagram-files";
import type { DomEl } from "../src/dom";
import { exportDiagram } from "../src/drawio";
import { TINY_PNG } from "./fixtures";
import { installRendererFixtureAdapter, writeRendererFixture } from "./renderer-fixture";

function source(animation: string | null, edgeStyle = ""): string {
  const root = animation === null
    ? '<mxCell id="0"/>'
    : `<UserObject label="" animation="${animation.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" id="0"><mxCell/></UserObject>`;
  return `<mxfile><diagram name="Animated"><mxGraphModel><root>
    ${root}<mxCell id="1" parent="0"/>
    <mxCell id="a" value="A" style="opacity=80;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="b" value="B" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="edge" style="${edgeStyle}" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
}

installRendererFixtureAdapter();

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100">
  <defs></defs>
  <g data-cell-id="a"><rect width="80" height="40"/></g>
  <g data-cell-id="b"><rect x="200" width="80" height="40"/></g>
  <g data-cell-id="edge"><path d="M80 20 L200 20"/></g>
</svg>`;

describe("animated SVG analysis", () => {
  it("recognizes connector flow controls and a portable page sequence", () => {
    const animation = JSON.stringify({
      animation: {
        loop: false,
        steps: [
          { opacity: { cells: ["a", "b"], value: 0 } },
          { fadeIn: { cells: ["a"], delay: 400 } },
          { fadeIn: { cells: ["b"], delay: 400 } },
        ],
      },
    });
    const result = analyzeDrawioAnimation(
      source(
        animation,
        "flowAnimation=1;flowAnimationDuration=1500;flowAnimationDirection=reverse;flowAnimationTimingFunction=ease-in-out;",
      ),
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.flowEdgeIds).toEqual(["edge"]);
    expect(result.sequence).toMatchObject({ enabled: true, loop: false });
    expect(result.sequence?.steps).toHaveLength(3);
    expect(result.observations).toHaveLength(2);
  });

  it("reports malformed flow controls, dangling references, and non-portable effects", () => {
    const animation = JSON.stringify({
      animation: {
        steps: [
          { fadeTo: { cells: ["missing"], value: 2, delay: -1 } },
          { highlight: { cells: ["a"] } },
        ],
      },
    });
    const result = analyzeDrawioAnimation(
      source(animation, "flowAnimation=1;flowAnimationDuration=fast;flowAnimationDirection=sideways;"),
    );

    expect(result.errors).toContain(
      "edge 'edge' has invalid flowAnimationDuration 'fast' (expected a positive millisecond value)",
    );
    expect(result.errors).toContain("edge 'edge' has invalid flowAnimationDirection 'sideways'");
    expect(result.errors).toContain("page animation step 1 action 'fadeTo' references missing cell 'missing'");
    expect(result.errors).toContain("page animation step 1 action 'fadeTo' needs value between 0 and 1");
    expect(result.errors).toContain("page animation step 1 action 'fadeTo' has an invalid delay");
    expect(result.warnings).toContain(
      "page animation step 2 action 'highlight' is not supported in standalone animated SVG",
    );
  });

  it("analyzes bare and wrapped page models alike, without treating compressed pages as empty graphs", () => {
    const wrapped = source(JSON.stringify({ steps: [{ fadeIn: { cells: ["a"] } }] }), "flowAnimation=1;");
    const bare = wrapped.match(/<mxGraphModel>[\s\S]+<\/mxGraphModel>/)![0];
    const { flowEdgeIds, sequence, errors } = analyzeDrawioAnimation(wrapped);
    expect(analyzeDrawioAnimation(bare)).toMatchObject({ flowEdgeIds, sequence, errors });
    expect(analyzeDrawioAnimation('<mxfile><diagram>compressed-data</diagram></mxfile>').errors)
      .toEqual(["compressed or missing page model cannot be inspected for animation"]);
  });

  it("sends each native diagnostic to the shared budget before inspecting subsequent cells", () => {
    const xml = source(null, "flowAnimation=1;flowAnimationDuration=fast;flowAnimationDirection=sideways;")
      .replace("</root>", '<mxCell id="later" vertex="1"/></root>');
    const page = new DOMParser().parseFromString(xml, "text/xml").getElementsByTagName("diagram")[0];
    const later = Array.from(page.getElementsByTagName("mxCell")).find((cell) => cell.getAttribute("id") === "later")!;
    const getLater = vi.spyOn(later, "getAttribute");
    const accepted: string[] = [];
    const budget = createValidationBudget({ ...DEFAULT_VALIDATION_LIMITS, maxDiagnostics: 2 },
      (level, message) => accepted.push(`${level}: ${message}`));
    budget.finding("warning", "earlier page finding");
    expect(() => analyzeAnimationPage(page as unknown as DomEl, budget)).toThrow(ValidationStop);
    expect(accepted).toEqual(["warning: earlier page finding", "error: edge 'edge' has invalid flowAnimationDuration 'fast' (expected a positive millisecond value)"]);
    expect(getLater).not.toHaveBeenCalledWith("style");
  });

  it("charges repeated wildcard expansion before allocating the rest of the requested selectors", () => {
    const xml = source(JSON.stringify({ steps: [{ fadeIn: { cells: Array<string>(20).fill("*") } }] }));
    const page = new DOMParser().parseFromString(xml, "text/xml").getElementsByTagName("diagram")[0] as unknown as DomEl;
    const accepted: string[] = [];
    const budget = createValidationBudget({ ...DEFAULT_VALIDATION_LIMITS, maxWork: 80 }, (_, message) => accepted.push(message));
    expect(() => analyzeAnimationPage(page, budget)).toThrow(/work limit/);
    expect(accepted).toEqual([]);
  });

  it("preserves a parser budget stop rather than mistaking it for a malformed-XML exception", () => {
    const recoverable = source(null).replace('width="80"', 'width=80');
    const exhausted = createValidationBudget({ ...DEFAULT_VALIDATION_LIMITS, maxDiagnostics: 0 }, () => {});
    expect(() => analyzeDrawioAnimation(recoverable, 1, exhausted)).toThrow(ValidationStop);
  });

  it("rejects invalid page indexes and legacy text sequences", () => {
    expect(() => analyzeDrawioAnimation(source(null), 2)).toThrow("pageIndex 2 is out of range");
    expect(analyzeDrawioAnimation(source("show a fade")).warnings).toContain(
      "legacy text page animations cannot be compiled to standalone animated SVG; save the animation as JSON",
    );
  });
});

describe("enhanceAnimatedSvg", () => {
  it("compiles portable page steps into standalone SVG CSS with reduced-motion fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-animation-"));
    try {
      const input = join(dir, "sequence.drawio");
      const output = join(dir, "sequence.svg");
      const animation = JSON.stringify({
        animation: {
          loop: true,
          steps: [
            { opacity: { cells: ["a", "b"], value: 0 } },
            { fadeIn: { cells: ["a"], delay: 400 } },
            { fadeIn: { cells: ["b"], delay: 400 }, immediate: true },
            { wait: 600 },
          ],
        },
      });
      await writeFile(input, source(animation));
      await writeFile(output, SVG);

      const summary = await enhanceAnimatedSvg(input, output);
      const result = await readFile(output, "utf8");

      expect(summary).toEqual({
        page: "Animated",
        connectorFlows: 0,
        sequenceSteps: 4,
        sequenceDurationMs: 1000,
        sequenceCompiled: true,
        verified: true,
      });
      expect(result).toContain('data-drawme-animation="opacity-timeline"');
      expect(result).toContain('g[data-cell-id="a"]');
      expect(result).toContain('g[data-cell-id="b"]');
      expect(result).toContain("1000ms ease-in-out 0ms infinite");
      expect(result).toContain("prefers-reduced-motion: reduce");
      expect(result).toContain('g[data-cell-id="a"] { animation: none !important; opacity: 0.8 !important; }');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("emits a static time-zero hide alongside real animation, but does not count it as motion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-zero-hide-"));
    try {
      const input = join(dir, "sequence.drawio");
      const output = join(dir, "sequence.svg");
      const hide = { hide: { cells: ["a"] } };
      const fade = { fadeIn: { cells: ["b"], delay: 400 }, immediate: true };
      await writeFile(output, SVG);
      await writeFile(input, source(JSON.stringify({ steps: [hide, { wait: 100 }] })));
      await expect(enhanceAnimatedSvg(input, output)).rejects.toThrow("no visible opacity change");
      expect(await readFile(output, "utf8")).toBe(SVG);

      await writeFile(input, source(JSON.stringify({ steps: [hide, fade] })));
      expect(await enhanceAnimatedSvg(input, output)).toMatchObject({ verified: true, sequenceDurationMs: 400 });
      const result = await readFile(output, "utf8");
      expect(result).toContain('g[data-cell-id="a"] { opacity: 0 !important; }');
      expect(result).toContain('g[data-cell-id="a"] { animation: none !important; opacity: 0.8 !important; }');
      expect(result).toMatch(/g\[data-cell-id="b"\] \{ animation: drawme-opacity-/);

      const child = source(JSON.stringify({ steps: [hide, fade] }))
        .replace('id="b" value="B" vertex="1" parent="1"', 'id="b" value="B" vertex="1" parent="a"');
      const nested = SVG.replace('</g>\n  <g data-cell-id="b">', '<g data-cell-id="b">').replace('</g>\n  <g data-cell-id="edge">', '</g></g>\n  <g data-cell-id="edge">');
      await writeFile(input, child);
      await writeFile(output, nested);
      await expect(enhanceAnimatedSvg(input, output)).rejects.toThrow("no visible opacity change");
      expect(await readFile(output, "utf8")).toBe(nested);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses bounded diagram intake when re-reading native animation source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-large-source-"));
    try {
      const input = join(dir, "large.drawio");
      const output = join(dir, "large.svg");
      await writeFile(input, source(null));
      await truncate(input, DEFAULT_VALIDATION_LIMITS.maxBytes + 1);
      await writeFile(output, SVG);
      await expect(enhanceAnimatedSvg(input, output)).rejects.toThrow(/diagram input exceeds the .* byte limit/);
      expect(await readFile(output, "utf8")).toBe(SVG);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses local image dependencies on the independent native-flow path before rewriting the SVG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-local-flow-"));
    try {
      const input = join(dir, "flow.drawio");
      const output = join(dir, "flow.svg");
      const linked = SVG.replace('<path d="M80 20 L200 20"/>',
        '<path style="animation: flow 500ms linear infinite;"/><image href="file:///logo.png"/>');
      await writeFile(input, source(null, "flowAnimation=1;"));
      await writeFile(output, linked);
      await expect(enhanceAnimatedSvg(input, output)).rejects.toThrow(/unresolved image.*embed/i);
      expect(await readFile(output, "utf8")).toBe(linked);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a local CSS image-set candidate in a staged SVG and accepts all-embedded candidates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-image-set-"));
    try {
      const input = join(dir, "sequence.drawio");
      const output = join(dir, "final.svg");
      const rendererOutput = join(dir, "renderer-response.svg");
      const binary = await writeRendererFixture(dir, `
import { copyFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) process.stdout.write('32.4.1\\n');
else copyFileSync(${JSON.stringify(rendererOutput)}, args[args.indexOf('-o') + 1]);
`);
      const embedded = `data:image/png;base64,${TINY_PNG}`;
      const label = `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" style="background-image: image-set('${embedded}' type('image/png') 1x, '../logo.png' 2x)">logo.png</div></foreignObject>`;
      const linked = SVG.replace("</svg>", `${label}</svg>`);
      const exportSvg = () => exportDiagram({ input, output, binary, format: "svg", animated: true });
      await writeFile(input, source(JSON.stringify({ steps: [{ fadeIn: { cells: ["a"] } }] })));
      await writeFile(output, SVG);
      await writeFile(rendererOutput, linked);
      await expect(exportSvg()).rejects.toThrow(/animated SVG verification failed:.*unresolved image.*embed/i);
      expect(await readFile(output, "utf8")).toBe(SVG);

      await writeFile(rendererOutput, linked.replace("../logo.png", embedded));
      await expect(exportSvg()).resolves.toMatchObject({ output, animation: { verified: true } });
      expect(await readFile(output, "utf8")).toContain("logo.png</div>");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verifies connector animation already emitted by draw.io", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-flow-animation-"));
    try {
      const input = join(dir, "flow.drawio");
      const output = join(dir, "flow.svg");
      await writeFile(input, source(null, "flowAnimation=1;"));
      await writeFile(
        output,
        SVG.replace('<path d="M80 20 L200 20"/>', '<path d="M80 20 L200 20" style="animation: flow 500ms linear infinite;"/>'),
      );

      await expect(enhanceAnimatedSvg(input, output)).resolves.toMatchObject({
        connectorFlows: 1,
        sequenceCompiled: false,
        verified: true,
      });
      expect(await readFile(output, "utf8")).toContain("prefers-reduced-motion: reduce");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses verified connector flow as independent evidence without claiming a wait-only sequence animated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-wait-with-flow-"));
    try {
      const input = join(dir, "flow.drawio");
      const output = join(dir, "flow.svg");
      const staged = SVG.replace('<path d="M80 20 L200 20"/>', '<path style="animation: flow 500ms linear infinite;"/>');
      await writeFile(input, source(JSON.stringify({ steps: [{ wait: 500 }] }), "flowAnimation=1;"));
      await writeFile(output, staged);
      await expect(enhanceAnimatedSvg(input, output)).resolves.toMatchObject({
        connectorFlows: 1, sequenceSteps: 1, sequenceCompiled: false, verified: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses static or incomplete outputs instead of presenting them as animated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-no-animation-"));
    try {
      const input = join(dir, "static.drawio");
      const output = join(dir, "static.svg");
      await writeFile(input, source(null));
      await writeFile(output, SVG);
      await expect(enhanceAnimatedSvg(input, output)).rejects.toThrow("no enabled page sequence");

      await writeFile(input, source(null, "flowAnimation=1;"));
      await expect(enhanceAnimatedSvg(input, output)).rejects.toThrow("did not preserve flow animation for connector(s): edge");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
