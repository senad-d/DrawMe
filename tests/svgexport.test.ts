import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import type { DomEl } from "../src/dom";
import { verifyStandaloneImages, walkElements } from "../src/svg-helpers";
import { padSvg, pinAuthoredColors, resolveLightDark } from "../src/svgexport";

function parseSvg(content: string): DomEl {
  return new DOMParser().parseFromString(content, "image/svg+xml").documentElement as unknown as DomEl;
}

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">';

describe("shared SVG helpers", () => {
  it("walks the root and descendants in document order, ignoring text and comments", () => {
    const root = parseSvg(`${SVG_OPEN}text<defs><marker/><pattern><rect/></pattern></defs><!-- gap --><g><path/></g></svg>`);
    expect(walkElements(root).map(({ tagName }) => tagName)).toEqual(["svg", "defs", "marker", "pattern", "rect", "g", "path"]);
  });

  it.each([
    '<image href="./logo.png"/>',
    '<image href="/assets/logo.png"/>',
    '<image href="https://example.invalid/logo.png"/>',
    '<image xmlns:link="http://www.w3.org/1999/xlink" link:href="file:///logo.png"/>',
    '<image href="#logo" xlink:href="logo.png"/>',
    '<filter><feImage href="logo.png"/></filter>',
    '<foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="logo.png"/></foreignObject>',
  ])("refuses non-self-contained rendered image references (%s)", (image) => {
    expect(() => verifyStandaloneImages(walkElements(parseSvg(`${SVG_OPEN}${image}</svg>`)))).toThrow(/embed the image/i);
  });

  it("allows embedded images and local fragment references without inspecting diagram metadata", () => {
    const svg = `${SVG_OPEN}<desc>file:///logo.png</desc><defs><g id="logo"><rect/></g></defs>
      <image href="#logo"/><image xlink:href="data:image/svg+xml,%3Csvg%2F%3E"/></svg>`;
    expect(() => verifyStandaloneImages(walkElements(parseSvg(svg)))).not.toThrow();
  });

  it("keeps one shared definition of each SVG primitive and no per-target wait arm", () => {
    const source = (file: string) => readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
    const declarations = /function (cssString|walkElements|walk)\(/g;
    expect(source("svg-helpers").match(declarations)).toEqual(["function cssString(", "function walkElements("]);
    for (const file of ["animation", "motion", "svgexport"]) {
      const text = source(file);
      expect(text).toMatch(/import \{[^}]*\bwalkElements\b[^}]*\} from "\.\/svg-helpers";/);
      if (file !== "svgexport") expect(text).toMatch(/import \{[^}]*\bcssString\b[^}]*\} from "\.\/svg-helpers";/);
      expect(text).not.toMatch(declarations);
    }
    const motion = source("motion");
    const compiler = motion.slice(motion.indexOf("export function compileMotion("), motion.indexOf("function compileTrackCss("));
    expect(compiler).toContain("switch (effect)");
    expect(compiler).not.toMatch(/case ["']wait["']:/);
  });
});

describe("SVG color pinning", () => {
  it("resolves light-dark() to the authored color, including nested functions", () => {
    expect(resolveLightDark("fill: light-dark(rgb(1, 2, 3), rgb(4, 5, 6)); stroke: #000;")).toBe(
      "fill: rgb(1, 2, 3); stroke: #000;",
    );
    expect(resolveLightDark("--bg: light-dark(#ffffff, var(--ge-dark-color, #121212));")).toBe("--bg: #ffffff;");
    expect(resolveLightDark("color: light-dark(light-dark(#111, #222), #333)")).toBe("color: #111");
    expect(resolveLightDark("no adaptive colors")).toBe("no adaptive colors");
    expect(resolveLightDark("broken: light-dark(#fff, #000")).toBe("broken: light-dark(#fff, #000");
  });

  it("pins style attributes, style sheets, and the root color scheme", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" style="background-color: light-dark(#0B1220, #121212); color-scheme: light dark;" content="light-dark(kept)">
  <style type="text/css">@supports (color: light-dark(#000, #fff)) { #s { --ge-adaptive-bg: light-dark(#ffffff, var(--ge-dark-color, #121212)); } }</style>
  <rect style="fill: light-dark(rgb(15, 30, 61), rgb(200, 210, 230));"/>
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml" style="color: light-dark(#DBEAFE, #1e293b);">Label</div></foreignObject>
</svg>`;
    const pinned = pinAuthoredColors(svg);
    expect(pinned).not.toMatch(/style="[^"]*light-dark/);
    expect(pinned).toContain('style="background-color: #0B1220; color-scheme: light;"');
    expect(pinned).toContain("--ge-adaptive-bg: #ffffff;");
    expect(pinned).toContain("fill: rgb(15, 30, 61);");
    expect(pinned).toContain("color: #DBEAFE;");
    // Non-style data (such as the embedded diagram) is untouched.
    expect(pinned).toContain('content="light-dark(kept)"');
  });

  it("resolves style CDATA and preserves incomplete adaptive functions", () => {
    expect(resolveLightDark("light-dark(rgb(1, 2, 3))")).toBe("rgb(1, 2, 3)");
    expect(resolveLightDark("light-dark(#111, #222); light-dark(#fff")).toBe("#111; light-dark(#fff");
    const svg = '<svg><style><![CDATA[rect { fill: light-dark(#111, #eee); }]]></style></svg>';
    expect(pinAuthoredColors(svg)).toContain("<![CDATA[rect { fill: #111; }]]>");
    expect(() => pinAuthoredColors('<html style="color: light-dark(#111, #eee)"/>')).toThrow("not valid SVG");
  });

  it("returns an SVG without adaptive colors unchanged", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff"/></svg>';
    expect(pinAuthoredColors(svg)).toBe(svg);
  });

  it("pads a borderless SVG evenly, keeping defs and the background outside the shifted drawing", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px" viewBox="0 0 200 100"><defs/><rect fill="#0B1220" width="100%" height="100%" x="0" y="0"/><g><g data-cell-id="0"><rect x="0" y="0" width="200" height="100"/></g></g></svg>`;
    const padded = padSvg(svg, 40);
    expect(padded).toContain('width="280px" height="180px" viewBox="0 0 280 180"');
    expect(padded).toMatch(/<svg[^>]*><defs\/><rect fill="#0B1220" width="100%" height="100%" x="0" y="0"\/><g transform="translate\(40,40\)" data-drawme-margin="40"><g><g data-cell-id="0">/);
    expect(padSvg(svg, 0)).toBe(svg);
    expect(padSvg(svg, -1)).toBe(svg);
    expect(padSvg(svg, Number.NaN)).toBe(svg);
  });
});
