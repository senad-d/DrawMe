import { describe, it, expect } from "vitest";
import { validateXml } from "../src/validate";

/** Wrap a set of <mxCell> lines in a minimal valid .drawio document. */
function doc(cells: string): string {
  return `<mxfile><diagram name="Page-1"><mxGraphModel><root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    ${cells}
  </root></mxGraphModel></diagram></mxfile>`;
}

const vertex = (id: string, x: number, y: number, w = 80, h = 40) =>
  `<mxCell id="${id}" vertex="1" parent="1" value="${id}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;

const edge = (id: string, source: string, target: string) =>
  `<mxCell id="${id}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;

describe("validateXml", () => {
  it("passes a clean two-node, one-edge diagram", () => {
    const r = validateXml(doc(vertex("a", 0, 0) + vertex("b", 200, 0) + edge("e1", "a", "b")));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("flags a duplicate id", () => {
    const r = validateXml(doc(vertex("a", 0, 0) + vertex("a", 200, 0)));
    expect(r.errors).toContain("duplicate id 'a'");
  });

  it("flags a dangling edge endpoint", () => {
    const r = validateXml(doc(vertex("a", 0, 0) + edge("e1", "a", "ghost")));
    expect(r.errors).toContain("edge 'e1' target 'ghost' does not exist");
  });

  it("flags reuse of the reserved id 1", () => {
    const r = validateXml(doc(vertex("1", 0, 0)));
    expect(r.errors.some((e) => e.includes("reuses reserved id 0/1"))).toBe(true);
  });

  it("flags a broken parent reference", () => {
    const r = validateXml(doc(`<mxCell id="a" vertex="1" parent="nope"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>`));
    expect(r.errors).toContain("cell 'a' parent 'nope' does not exist");
  });

  it("flags a vertex with missing geometry", () => {
    const r = validateXml(doc(`<mxCell id="a" vertex="1" parent="1" value="a"/>`));
    expect(r.errors).toContain("vertex 'a' has missing/invalid geometry");
  });

  it("warns on overlapping sibling vertices", () => {
    const r = validateXml(doc(vertex("a", 0, 0, 100, 100) + vertex("b", 50, 50, 100, 100)));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContain("vertices 'a' and 'b' overlap");
  });

  it("warns on a negative position", () => {
    const r = validateXml(doc(vertex("a", -10, 0)));
    expect(r.warnings.some((w) => w.includes("negative position"))).toBe(true);
  });

  it("does not treat container children as overlaps (only leaf siblings)", () => {
    const container = `<mxCell id="grp" vertex="1" parent="1"><mxGeometry x="0" y="0" width="400" height="400" as="geometry"/></mxCell>`;
    const child = `<mxCell id="c" vertex="1" parent="grp"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>`;
    const r = validateXml(doc(container + child));
    expect(r.warnings.filter((w) => w.includes("overlap"))).toEqual([]);
  });
});
