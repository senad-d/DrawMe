import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { analyzeAnimationPage, analyzeDrawioAnimation, enhanceAnimatedSvg } from "../src/animation";
import type { DomEl } from "../src/dom";
import { createValidationBudget, ValidationBudgetExceeded } from "../src/validation-budget";

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

  it("analyzes equivalent bare and wrapped graphs without treating compressed content as a model", () => {
    const wrapped = source(JSON.stringify({ steps: [{ fadeIn: { cells: ["a"] } }] }), "flowAnimation=1;");
    const bare = wrapped.replace('<mxfile><diagram name="Animated">', "").replace("</diagram></mxfile>", "");
    const summarize = (xml: string) => {
      const { pageName: _pageName, cells, ...rest } = analyzeDrawioAnimation(xml);
      return { ...rest, cellIds: [...cells.keys()] };
    };
    expect(summarize(bare)).toEqual(summarize(wrapped));
    expect(analyzeDrawioAnimation(bare).animatableCellIds).toEqual(["a", "b", "edge"]);
    expect(analyzeDrawioAnimation('<mxfile><diagram name="Compressed">eJw=</diagram></mxfile>').errors)
      .toEqual([expect.stringContaining("compressed")]);
    expect(() => analyzeDrawioAnimation("<mxfile/>")).toThrow("diagram has 0 page(s)");
  });

  it("uses the caller's budget for native steps, selectors, and diagnostic emission", () => {
    const xml = source(JSON.stringify({ steps: [
      { fadeTo: { cells: ["*", "missing"], value: 2, delay: -1 } },
      { highlight: { cells: ["a"] } },
    ] }));
    const diagram = new DOMParser().parseFromString(xml, "text/xml").getElementsByTagName("diagram")[0] as unknown as DomEl;
    const normal = analyzeAnimationPage(diagram);
    expect([normal.errors.length, normal.warnings.length, normal.observations.length]).toEqual([3, 1, 1]);
    expect(analyzeAnimationPage(diagram, createValidationBudget(1_000, 5))).toEqual(normal);
    expect(() => analyzeAnimationPage(diagram, createValidationBudget(1_000, 2))).toThrow(new ValidationBudgetExceeded("diagnostics"));
    expect(() => analyzeAnimationPage(diagram, createValidationBudget(1, 100))).toThrow(new ValidationBudgetExceeded("work"));
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

  it("keeps a time-zero hide hidden in playback and restores base opacity for reduced motion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-initial-hide-"));
    try {
      const input = join(dir, "sequence.drawio");
      const output = join(dir, "sequence.svg");
      const id = 'cell"\\\t';
      await writeFile(input, source(JSON.stringify({ steps: [
        { hide: { cells: [id] } },
        { fadeIn: { cells: ["b"], delay: 200 } },
      ] })).replace('id="a"', 'id="cell&quot;&#92;&#9;"'));
      await writeFile(output, SVG.replace('data-cell-id="a"', 'data-cell-id="cell&quot;&#92;&#9;" style="opacity: 0.8"'));

      await expect(enhanceAnimatedSvg(input, output)).resolves.toMatchObject({ verified: true, sequenceDurationMs: 200 });
      const result = await readFile(output, "utf8");
      expect(result).toContain(String.raw`g[data-cell-id="cell\"\\\9 "] { opacity: 0 !important; }`);
      expect(result).toContain(String.raw`g[data-cell-id="cell\"\\\9 "] { animation: none !important; opacity: 0.8 !important; }`);
      expect(result).toContain('g[data-cell-id="b"] { animation: drawme-opacity-1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a linked image in native animated SVG before writing but permits embedded images", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme-linked-animation-"));
    try {
      const input = join(dir, "sequence.drawio");
      const output = join(dir, "sequence.svg");
      await writeFile(input, source(JSON.stringify({ steps: [{ fadeIn: { cells: ["a"] } }] })));
      const image = (href: string) => SVG.replace("<defs></defs>", `<defs/><image xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="${href}"/>`);
      const linked = image("file:///local-logo.png");
      await writeFile(output, linked);
      await expect(enhanceAnimatedSvg(input, output)).rejects.toThrow(/embed.*image/i);
      expect(await readFile(output, "utf8")).toBe(linked);
      await writeFile(output, image("data:image/png;base64,aW1hZ2U="));
      await expect(enhanceAnimatedSvg(input, output)).resolves.toMatchObject({ verified: true });
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
