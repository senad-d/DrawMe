import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MIN_OUTER_MARGIN, validateXml } from "../src/validate";

/** Wrap a set of <mxCell> lines in a minimal valid .drawio document. */
function doc(cells: string, modelAttributes = ""): string {
  return `<mxfile><diagram name="Page-1"><mxGraphModel ${modelAttributes}><root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    ${cells}
  </root></mxGraphModel></diagram></mxfile>`;
}

const vertex = (id: string, x: number, y: number, w = 80, h = 40, style = "", value = id) =>
  `<mxCell id="${id}" vertex="1" parent="1" value="${value}" style="${style}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;

const edge = (id: string, source: string, target: string, style = "", value = "") =>
  `<mxCell id="${id}" edge="1" parent="1" source="${source}" target="${target}" style="${style}" value="${value}"><mxGeometry relative="1" as="geometry"/></mxCell>`;

const routedEdge = (id: string, source: string, target: string, x: number, y: number) =>
  `<mxCell id="${id}" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="${x}" y="${y}"/></Array></mxGeometry></mxCell>`;

const hasDiagnostic = (diagnostics: string[], suffix: string) => diagnostics.some((diagnostic) => diagnostic.endsWith(suffix));

describe("validateXml", () => {
  it("passes a clean two-node, one-edge diagram when page dimensions are omitted", () => {
    const result = validateXml(doc(vertex("a", 0, 0) + vertex("b", 200, 0) + edge("e1", "a", "b")));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.observations).toContain(
      "page 'Page-1': page dimensions are omitted or invalid; boundary, outer-margin, and empty-space checks require both pageWidth and pageHeight",
    );
  });

  it("flags duplicate IDs, dangling endpoints, reserved IDs, and broken parents with page context", () => {
    const duplicate = validateXml(doc(vertex("a", 0, 0) + vertex("a", 200, 0)));
    expect(duplicate.errors).toContain("page 'Page-1': duplicate id 'a'");

    const dangling = validateXml(doc(vertex("a", 0, 0) + edge("e1", "a", "ghost")));
    expect(dangling.errors).toContain("page 'Page-1': edge 'e1' target 'ghost' does not exist");

    const reserved = validateXml(doc(vertex("1", 0, 0)));
    expect(hasDiagnostic(reserved.errors, "cell '1' reuses reserved id 0/1")).toBe(true);

    const brokenParent = validateXml(
      doc(`<mxCell id="a" vertex="1" parent="nope"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>`),
    );
    expect(brokenParent.errors).toContain("page 'Page-1': cell 'a' parent 'nope' does not exist");
  });

  it("rejects missing or invalid vertex geometry", () => {
    const missing = validateXml(doc(`<mxCell id="a" vertex="1" parent="1" value="a"/>`));
    expect(missing.errors).toContain("page 'Page-1': vertex 'a' has missing/invalid geometry");

    const invalid = validateXml(
      doc(`<mxCell id="invalid" vertex="1" parent="1"><mxGeometry x="abc" y="0" width="80" height="40" as="geometry"/></mxCell>`),
    );
    expect(invalid.errors).toContain("page 'Page-1': vertex 'invalid' has missing/invalid geometry");
  });

  it("rejects missing and malformed edge geometry", () => {
    const nodes = vertex("a", 0, 0) + vertex("b", 200, 0);
    const missing = validateXml(
      doc(nodes + `<mxCell id="missing" edge="1" parent="1" source="a" target="b"/>`),
    );
    expect(missing.errors).toContain("page 'Page-1': edge 'missing' has missing geometry");

    for (const geometry of [
      `<mxGeometry as="geometry"/>`,
      `<mxGeometry relative="1"/>`,
      `<mxGeometry relative="0" as="geometry"/>`,
      `<mxGeometry relative="1" as="notGeometry"/>`,
    ]) {
      const malformed = validateXml(
        doc(nodes + `<mxCell id="bad" edge="1" parent="1" source="a" target="b">${geometry}</mxCell>`),
      );
      expect(malformed.errors).toContain(
        "page 'Page-1': edge 'bad' geometry must have relative='1' and as='geometry'",
      );
    }
  });

  it("warns on overlapping siblings, negative positions, and non-positive sizes", () => {
    const result = validateXml(
      doc(vertex("a", -10, 0, 100, 100) + vertex("b", 50, 50, 100, 100) + vertex("small", 250, 0, 0, -1)),
    );
    expect(result.warnings).toContain("page 'Page-1': vertices 'a' and 'b' overlap");
    expect(hasDiagnostic(result.warnings, "vertex 'a' negative position (-10,0)")).toBe(true);
    expect(hasDiagnostic(result.warnings, "vertex 'small' non-positive size 0x-1")).toBe(true);
    expect(result.score).toMatchObject({ total: 5, overlaps: 1 });
  });

  it("does not treat container children as sibling overlaps", () => {
    const container = `<mxCell id="grp" vertex="1" parent="1"><mxGeometry x="0" y="0" width="400" height="400" as="geometry"/></mxCell>`;
    const child = `<mxCell id="c" vertex="1" parent="grp"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>`;
    const result = validateXml(doc(container + child));
    expect(result.warnings.filter((warning) => warning.includes("overlap"))).toEqual([]);
  });

  it("warns when a nested child visibly exceeds its container", () => {
    const container = `<mxCell id="grp" vertex="1" parent="1"><mxGeometry x="20" y="20" width="200" height="120" as="geometry"/></mxCell>`;
    const child = `<mxCell id="c" vertex="1" parent="grp"><mxGeometry x="170" y="90" width="60" height="50" as="geometry"/></mxCell>`;
    const result = validateXml(doc(container + child, `page="1" pageWidth="400" pageHeight="220"`));
    expect(result.warnings).toContain(
      "page 'Page-1': vertex 'c' extends beyond parent 'grp' (right, bottom)",
    );
  });

  it("excludes intentional relative border ports and relative edge labels from containment checks", () => {
    const container = `<mxCell id="grp" vertex="1" parent="1"><mxGeometry x="20" y="20" width="200" height="120" as="geometry"/></mxCell>`;
    const port = `<mxCell id="port" value="p" style="shape=mxgraph.sysml.port;fontSize=8;" vertex="1" parent="grp"><mxGeometry x="1" y="0.5" width="20" height="20" relative="1" as="geometry"/></mxCell>`;
    const result = validateXml(doc(container + port));
    expect(result.warnings.filter((warning) => warning.includes("extends beyond parent"))).toEqual([]);
    expect(result.warnings.filter((warning) => warning.includes("fontSize"))).toEqual([]);
  });

  it("warns when explicitly waypointed routes pass through vertices or cross", () => {
    const through = validateXml(
      doc(
        vertex("a", 0, 100) +
          vertex("b", 300, 100) +
          vertex("blocker", 140, 90, 80, 60) +
          routedEdge("e1", "a", "b", 180, 120),
      ),
    );
    expect(through.warnings).toContain("page 'Page-1': edge 'e1' routes through vertex 'blocker'");
    expect(through.score).toMatchObject({ total: 20, through: 1 });

    const crossing = validateXml(
      doc(
        vertex("left", 0, 100) +
          vertex("right", 300, 100) +
          vertex("top", 150, 0) +
          vertex("bottom", 150, 250) +
          routedEdge("horizontal", "left", "right", 100, 120) +
          routedEdge("vertical", "top", "bottom", 190, 200),
      ),
    );
    expect(crossing.warnings).toContain("page 'Page-1': edges 'horizontal' and 'vertical' cross");
    expect(crossing.score).toMatchObject({ total: 10, crossings: 1 });
  });

  it("warns on right and bottom page overflow", () => {
    const result = validateXml(
      doc(vertex("outside", 250, 170, 80, 60), `page="1" pageScale="1" pageWidth="300" pageHeight="200"`),
    );
    expect(result.warnings).toContain("page 'Page-1': content extends beyond right page boundary by 30px");
    expect(result.warnings).toContain("page 'Page-1': content extends beyond bottom page boundary by 30px");
  });

  it("includes explicit waypoints and practical explicit edge-label boxes in content bounds", () => {
    const nodes = vertex("a", 20, 80) + vertex("b", 300, 80);
    const routed = routedEdge("e1", "a", "b", 410, 210);
    const waypointResult = validateXml(
      doc(nodes + routed, `page="1" pageWidth="400" pageHeight="200"`),
    );
    expect(waypointResult.warnings).toContain(
      "page 'Page-1': content extends beyond right page boundary by 10px",
    );
    expect(waypointResult.warnings).toContain(
      "page 'Page-1': content extends beyond bottom page boundary by 10px",
    );

    const label = `<mxCell id="label" value="routed label" style="edgeLabel;" vertex="1" parent="e2"><mxGeometry width="80" height="20" relative="1" as="geometry"><mxPoint x="230" y="0" as="offset"/></mxGeometry></mxCell>`;
    const labelResult = validateXml(
      doc(nodes + routedEdge("e2", "a", "b", 200, 100) + label, `page="1" pageWidth="400" pageHeight="200"`),
    );
    expect(labelResult.warnings.some((warning) => warning.includes("right page boundary"))).toBe(true);
  });

  it("accepts content with the documented minimum page margin and applies pageScale", () => {
    const result = validateXml(
      doc(
        vertex("top-left", 20, 20) + vertex("bottom-right", 300, 140),
        `page="1" pageWidth="400" pageHeight="200"`,
      ),
    );
    expect(result.warnings).toEqual([]);
    expect(MIN_OUTER_MARGIN).toBe(20);

    const scaled = validateXml(
      doc(
        vertex("scaled-top-left", 20, 20) + vertex("scaled-bottom-right", 300, 140),
        `page="1" pageScale="2" pageWidth="200" pageHeight="100"`,
      ),
    );
    expect(scaled.warnings).toEqual([]);
  });

  it("warns when outer margins are too small", () => {
    const result = validateXml(
      doc(vertex("tight", 10, 10, 380, 180), `page="1" pageWidth="400" pageHeight="200"`),
    );
    expect(result.warnings).toContain(
      "page 'Page-1': content outer margin is below 20px (left 10px, top 10px, right 10px, bottom 10px)",
    );
  });

  it("warns conservatively when the page is substantially larger than its content", () => {
    const result = validateXml(
      doc(vertex("small", 100, 100, 100, 50), `page="1" pageWidth="1000" pageHeight="800"`),
    );
    expect(result.warnings).toContain(
      "page 'Page-1': canvas has excessive empty space (content 100x50px within 1000x800px page)",
    );
  });

  it("documents omitted page dimensions and infinite-canvas behavior without boundary warnings", () => {
    const omitted = validateXml(doc(vertex("far", 5000, 5000)));
    expect(omitted.warnings.filter((warning) => warning.includes("page boundary"))).toEqual([]);
    expect(omitted.observations.some((observation) => observation.includes("page dimensions are omitted"))).toBe(true);

    const infinite = validateXml(doc(vertex("far", 5000, 5000), `page="0" pageWidth="100" pageHeight="100"`));
    expect(infinite.warnings.filter((warning) => warning.includes("page boundary"))).toEqual([]);
    expect(infinite.observations.some((observation) => observation.includes("infinite canvas"))).toBe(true);
  });

  it("keeps diagnostics page-specific in multi-page files", () => {
    const xml = `<mxfile>
      <diagram name="Clean"><mxGraphModel page="1" pageWidth="200" pageHeight="100"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${vertex("a", 20, 20)}</root></mxGraphModel></diagram>
      <diagram name="Overflow"><mxGraphModel page="1" pageWidth="200" pageHeight="100"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${vertex("b", 180, 80)}</root></mxGraphModel></diagram>
    </mxfile>`;
    const result = validateXml(xml);
    expect(result.warnings.some((warning) => warning.startsWith("page 'Overflow':") && warning.includes("right page boundary"))).toBe(true);
    expect(result.warnings.some((warning) => warning.startsWith("page 'Overflow':") && warning.includes("bottom page boundary"))).toBe(true);
    expect(result.warnings.some((warning) => warning.startsWith("page 'Clean':") && warning.includes("boundary"))).toBe(false);
  });

  it("reports conservative small-font and long-unwrapped-label warnings", () => {
    const smallNode = vertex("tiny", 0, 0, 80, 40, "fontSize=8;", "Tiny");
    const narrowLong = vertex(
      "long",
      200,
      0,
      120,
      40,
      "rounded=1;",
      "This label is definitely much too long for this narrow node",
    );
    const labeledEdge = edge("e1", "tiny", "long", "fontSize=8;", "HTTP");
    const result = validateXml(doc(smallNode + narrowLong + labeledEdge));
    expect(result.warnings).toContain("page 'Page-1': vertex 'tiny' has very small explicit fontSize 8px");
    expect(result.warnings).toContain(
      "page 'Page-1': connector label 'e1' has very small explicit fontSize 8px",
    );
    expect(result.warnings).toContain(
      "page 'Page-1': vertex 'long' has a long label in narrow geometry without whiteSpace=wrap",
    );
  });

  it("does not claim to analyze dense auto-routed connector crossings without waypoints", () => {
    const nodes = Array.from({ length: 6 }, (_, index) => vertex(`n${index}`, (index % 3) * 200, Math.floor(index / 3) * 160)).join("");
    const edges = [
      edge("e1", "n0", "n5"),
      edge("e2", "n2", "n3"),
      edge("e3", "n1", "n4"),
      edge("e4", "n0", "n4"),
    ].join("");
    const result = validateXml(doc(nodes + edges));
    expect(result.warnings.filter((warning) => warning.includes(" cross") || warning.includes("routes through"))).toEqual([]);
  });

  it("keeps the checked-in clean examples free of structural findings", () => {
    for (const name of ["drawme-how-it-works.drawio", "drawme-installation-guide.drawio", "git-graph-example.drawio"]) {
      const result = validateXml(readFileSync(resolve("example", name), "utf8"));
      expect(result.errors, name).toEqual([]);
      expect(result.warnings, name).toEqual([]);
    }
  });

  it("reports compressed and missing page models", () => {
    const compressed = validateXml(`<mxfile><diagram name="Packed">compressed-data</diagram></mxfile>`);
    expect(compressed.warnings).toContain("page 'Packed': compressed, skipped (cannot lint)");

    const empty = validateXml(`<mxfile><diagram name="Empty"/></mxfile>`);
    expect(empty.errors).toContain("page 'Empty': no <mxGraphModel>");
  });
});
