import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeDrawioAnimation, enhanceAnimatedSvg } from "../src/animation";

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
