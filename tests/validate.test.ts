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

const routedEdge = (id: string, source: string, target: string, x: number, y: number) =>
  `<mxCell id="${id}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="${x}" y="${y}"/></Array></mxGeometry></mxCell>`;

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

  it("warns when a waypointed edge routes through another vertex", () => {
    const cells =
      vertex("a", 0, 100) +
      vertex("b", 300, 100) +
      vertex("blocker", 140, 90, 80, 60) +
      routedEdge("e1", "a", "b", 180, 120);
    const r = validateXml(doc(cells));
    expect(r.warnings).toContain("edge 'e1' routes through vertex 'blocker'");
    expect(r.score).toMatchObject({ total: 20, through: 1 });
  });

  it("warns when two waypointed edge routes cross", () => {
    const cells =
      vertex("left", 0, 100) +
      vertex("right", 300, 100) +
      vertex("top", 150, 0) +
      vertex("bottom", 150, 250) +
      routedEdge("horizontal", "left", "right", 100, 120) +
      routedEdge("vertical", "top", "bottom", 190, 200);
    const r = validateXml(doc(cells));
    expect(r.warnings).toContain("edges 'horizontal' and 'vertical' cross");
    expect(r.score).toMatchObject({ total: 10, crossings: 1 });
  });

  it("reports compressed and missing page models", () => {
    const compressed = validateXml(`<mxfile><diagram name="Packed">compressed-data</diagram></mxfile>`);
    expect(compressed.warnings).toContain("page 'Packed': compressed, skipped (cannot lint)");

    const empty = validateXml(`<mxfile><diagram name="Empty"/></mxfile>`);
    expect(empty.errors).toContain("page 'Empty': no <mxGraphModel>");
  });

  it("warns about non-positive sizes and rejects non-numeric geometry", () => {
    const badSize = `<mxCell id="small" vertex="1" parent="1"><mxGeometry x="0" y="0" width="0" height="-1" as="geometry"/></mxCell>`;
    const invalid = `<mxCell id="invalid" vertex="1" parent="1"><mxGeometry x="abc" y="0" width="80" height="40" as="geometry"/></mxCell>`;
    const r = validateXml(doc(badSize + invalid));
    expect(r.warnings).toContain("vertex 'small' non-positive size 0x-1");
    expect(r.errors).toContain("vertex 'invalid' has missing/invalid geometry");
  });
});
