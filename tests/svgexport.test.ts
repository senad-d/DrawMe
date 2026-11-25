import { describe, expect, it } from "vitest";
import { padSvg, pinAuthoredColors, resolveLightDark } from "../src/svgexport";
import { assertStandaloneImages } from "../src/svg-helpers";

describe("standalone SVG images", () => {
  it("checks local sources in SVG, XHTML and CSS without mistaking embedded data or link text for image URLs", () => {
    const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:link="http://www.w3.org/1999/xlink">${body}</svg>`;
    const embedded = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22/%3E';
    const body = `<image link:href="${embedded}"/><use href="#icon"/>
      <a href="notes.md"><text>url(not-an-image.png)</text></a>
      <style>/* url(ignored.png) */ text::after { content: "url(text.png)"; } rect { fill:url(#icon); }</style>
      <foreignObject><picture xmlns="http://www.w3.org/1999/xhtml"><source srcset="${embedded} 2x"/>
      <img src="${embedded}" style="background-image: url('${embedded}')"/></picture></foreignObject>`;
    expect(() => assertStandaloneImages(svg(body))).not.toThrow();
    for (const unresolved of [
      '<image link:href="C:\\icons\\logo.png"/>',
      '<image href="file:///home/local/logo.png"/>',
      '<feImage href="../logo.png"/>',
      '<foreignObject><img xmlns="http://www.w3.org/1999/xhtml" src="//server/share/logo.png"/></foreignObject>',
      `<foreignObject><source xmlns="http://www.w3.org/1999/xhtml" srcset="${embedded}, ./logo.png 2x"/></foreignObject>`,
      '<style>rect { fill: u\\72 l("../logo.png"); }</style>',
      '<rect fill="url(./logo.svg#paint)"/>',
    ]) {
      expect(() => assertStandaloneImages(svg(body + unresolved))).toThrow(/unresolved image.*embed/i);
    }
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
