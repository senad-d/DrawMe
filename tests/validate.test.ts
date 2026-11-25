import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MOTION_ATTRIBUTE } from "../src/motion";
import { MIN_OUTER_MARGIN, validateFile, validateXml } from "../src/validate";

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
const finitePage = 'page="1" pageWidth="400" pageHeight="200"';
const compactPage = 'page="1" pageWidth="140" pageHeight="90"';

describe("validation limits", () => {
  it("checks the UTF-8 byte limit before parsing a string or file", async () => {
    const xml = '<mxGraphModel name="é"><root/></mxGraphModel>';
    const maxBytes = Buffer.byteLength(xml);
    const dir = await mkdtemp(join(tmpdir(), "drawme-validate-"));
    try {
      const input = join(dir, "diagram.drawio");
      await writeFile(input, xml);
      for (const result of [validateXml(xml, { maxBytes }), await validateFile(input, { maxBytes })]) {
        expect(result).toMatchObject({ incomplete: false, errors: [] });
      }
      for (const result of [validateXml(xml, { maxBytes: maxBytes - 1 }), await validateFile(input, { maxBytes: maxBytes - 1 })]) {
        expect(result.incomplete).toBe(true);
        expect(result.errors).toEqual([expect.stringMatching(/validation incomplete:.*byte limit/i)]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-regular input as a read failure, not a budget stop", async () => {
    const result = await validateFile(resolve("example"));
    expect(result.incomplete).toBe(false);
    expect(result.errors).toEqual([expect.stringMatching(/cannot read .*not a regular file/)]);
  });

  it("stops before analyzing a page over the cell limit, counting wrapped cells", () => {
    const xml = doc('<UserObject id="a"><mxCell vertex="1" parent="1"/></UserObject>');
    expect(validateXml(xml, { maxCellsPerPage: 3 })).toMatchObject({
      incomplete: false,
      errors: ["page 'Page-1': vertex 'a' has missing/invalid geometry"],
    });
    const partial = validateXml(xml, { maxCellsPerPage: 2 });
    expect(partial.incomplete).toBe(true);
    expect(partial.errors).toEqual([expect.stringMatching(/validation incomplete:.*Page-1.*2 cells/i)]);
  });

  it("charges even non-overlapping sibling comparisons against the work limit", () => {
    const row = (count: number) => doc(Array.from({ length: count }, (_, i) => vertex(`v${i}`, i * 100, 0)).join(""));
    expect(validateXml(row(20), { maxWork: 1500 }).incomplete).toBe(false);
    const partial = validateXml(row(50), { maxWork: 1500 });
    expect(partial.incomplete).toBe(true);
    expect(partial.errors).toEqual([expect.stringMatching(/validation incomplete:.*work budget/i)]);
    expect(partial.score.overlaps).toBe(0);
    expect(validateXml(row(50)).incomplete).toBe(false);
  });

  it("charges segment comparisons within an edge pair, even when the routes never cross", () => {
    const parallelEdge = (id: string, y: number) => {
      const points = Array.from({ length: 48 }, (_, i) => `<mxPoint x="${i + 1}" y="${y}"/>`).join("");
      return `<mxCell id="${id}" parent="1" edge="1"><mxGeometry relative="1" as="geometry"><mxPoint as="sourcePoint" x="0" y="${y}"/><mxPoint as="targetPoint" x="49" y="${y}"/><Array as="points">${points}</Array></mxGeometry></mxCell>`;
    };
    const a = parallelEdge("a", 20);
    const both = doc(a + parallelEdge("b", 40));
    expect(validateXml(doc(a), { maxWork: 1600 }).incomplete).toBe(false);
    const partial = validateXml(both, { maxWork: 1600 });
    expect(partial.incomplete).toBe(true);
    expect(partial.errors).toEqual([expect.stringMatching(/validation incomplete:.*work budget/i)]);
    expect(validateXml(both)).toMatchObject({ incomplete: false, score: { crossings: 0 } });
  });

  it("charges ancestor traversal inside geometry against the same work limit", () => {
    // Non-vertex ancestors don't introduce any additional overlap pairs. Their
    // depth affects delegated visibility and absolute-position traversal.
    const graph = (nested: boolean) => doc(
      Array.from({ length: 30 }, (_, i) => `<mxCell id="p${i}" parent="${nested && i > 0 ? `p${i - 1}` : "1"}"/>`).join("") +
        vertex("a", 20, 20).replace('parent="1"', 'parent="p29"'),
      compactPage,
    );
    expect(validateXml(graph(false), { maxWork: 860 })).toMatchObject({ incomplete: false, errors: [] });
    const partial = validateXml(graph(true), { maxWork: 860 });
    expect(partial.incomplete).toBe(true);
    expect(partial.errors).toEqual([expect.stringMatching(/validation incomplete:.*work budget/i)]);
    expect(validateXml(graph(true)).incomplete).toBe(false);
  });

  it("shares the work limit across pages instead of allowing each page a fresh budget", () => {
    const page = `<diagram><mxGraphModel ${finitePage}><root>${vertex("a", 40, 40).replace(' parent="1"', '')}</root></mxGraphModel></diagram>`;
    expect(validateXml(page, { maxWork: 100 }).incomplete).toBe(false);
    const partial = validateXml(`<mxfile>${page.repeat(4)}</mxfile>`, { maxWork: 100 });
    expect(partial.incomplete).toBe(true);
    expect(partial.errors).toEqual([expect.stringMatching(/validation incomplete:.*work budget/i)]);
  });

  it("retains findings and a partial score up to the diagnostic limit, plus one blocking marker", () => {
    const xml = doc(vertex("a", 20, 20) + vertex("b", 20, 20) + vertex("c", 20, 20), compactPage);
    const partial = validateXml(xml, { maxDiagnostics: 2 });
    expect(partial.incomplete).toBe(true);
    expect(partial.errors).toEqual([expect.stringMatching(/validation incomplete:.*diagnostics budget/i)]);
    expect(partial.warnings).toEqual([
      "page 'Page-1': vertices 'a' and 'b' overlap",
      "page 'Page-1': vertices 'a' and 'c' overlap",
    ]);
    expect(partial.observations).toEqual([]);
    expect(partial.score).toMatchObject({ total: 10, overlaps: 2 });
    expect(validateXml(xml, { maxDiagnostics: 3 })).toMatchObject({ incomplete: false, score: { total: 15 } });
  });

  it.each([
    ["stored motion", MOTION_ATTRIBUTE, '{"steps":[false,false,false]}', /motion step 3 must be an object/],
    ["native animation", "animation", '{"steps":[false,false,false]}', /page animation step 3 must be an object/],
  ])("stops %s at diagnostic emission using the remaining shared budget", (_kind, attribute, json, lastError) => {
    const page = (name: string, attribute: string, value: string) =>
      `<diagram name="${name}"><mxGraphModel ${finitePage}><root><UserObject id="0" ${attribute}="${value.replaceAll('"', '&quot;')}"><mxCell/></UserObject></root></mxGraphModel></diagram>`;
    const first = page("First", "animation", "legacy text");
    const second = page("Second", attribute, json);
    const firstWarning = "page 'First': legacy text page animations cannot be compiled to standalone animated SVG; save the animation as JSON";
    expect(validateXml(first, { maxDiagnostics: 1 })).toMatchObject({ incomplete: false, warnings: [firstWarning] });
    const xml = `<mxfile>${first}${second}</mxfile>`;
    expect(validateXml(xml).errors).toContainEqual(expect.stringMatching(lastError));
    const partial = validateXml(xml, { maxDiagnostics: 2 });
    expect(partial.incomplete).toBe(true);
    // An interrupted helper never returns its local array to the validator.
    expect(partial.errors).toEqual([expect.stringMatching(/validation incomplete:.*diagnostics budget/i)]);
    expect(partial.warnings).toEqual([firstWarning]);
    expect(partial.observations).toEqual([]);
  });
});

describe("validateXml", () => {
  it("validates equivalent bare, single-diagram, and wrapped graph models", () => {
    const graph = `<mxGraphModel ${compactPage}><root>${vertex("a", 20, 20).replace(' parent="1"', "")}</root></mxGraphModel>`;
    const bare = validateXml(graph);
    expect(bare).toMatchObject({ incomplete: false, errors: [], warnings: [] });
    expect(validateXml(`<diagram>${graph}</diagram>`)).toEqual(bare);
    expect(validateXml(`<mxfile><diagram>${graph}</diagram></mxfile>`)).toEqual(bare);
  });

  it("rejects unknown and page-less document envelopes as structural errors", () => {
    expect(validateXml("<html/>").errors).toEqual([expect.stringMatching(/expected.*<mxfile>/)]);
    expect(validateXml("<mxfile/>").errors).toEqual([expect.stringMatching(/no pages/)]);
  });

  it("returns recoverable and fatal XML parser diagnostics as errors and budgets their retention", () => {
    expect(validateXml('<mxGraphModel page=1><root/></mxGraphModel>').errors).toContainEqual(expect.stringMatching(/XML.*attribute.*quot/i));
    expect(validateXml('<mxGraphModel page="1"><root/></mxGraphModel>').errors).toEqual([]);
    expect(validateXml('<mxGraphModel><root></mxGraphModel>').errors).toEqual([expect.stringMatching(/XML.*(?:mismatch|unclosed)/i)]);
    const partial = validateXml('<mxGraphModel page=1 pageWidth=200><root/></mxGraphModel>', { maxDiagnostics: 1 });
    expect(partial.incomplete).toBe(true);
    expect(partial.errors).toEqual([
      expect.stringMatching(/XML.*attribute.*quot/i),
      expect.stringMatching(/validation incomplete:.*diagnostics budget/i),
    ]);
  });

  it("requires a graph's root element but accepts an empty rooted graph", () => {
    expect(validateXml('<diagram name="Broken"><mxGraphModel/></diagram>').errors).toEqual([
      expect.stringMatching(/page 'Broken': .*<root>/),
    ]);
    expect(validateXml('<mxGraphModel><root/></mxGraphModel>')).toMatchObject({ incomplete: false, errors: [], warnings: [] });
  });

  it.each([
    ['<mxCell id="a" parent="a"/>', "'a' -> 'a'"],
    ['<mxCell id="before" parent="a"/><mxCell id="a" parent="b"/><mxCell id="b" parent="c"/><mxCell id="c" parent="a"/>', "'a' -> 'b' -> 'c' -> 'a'"],
  ])("reports the containment cycle rather than cells merely leading into it: %s", (cells, cycle) => {
    expect(validateXml(doc(cells)).errors).toEqual([`page 'Page-1': containment cycle: ${cycle}`]);
  });

  it("does not let prose in page names change readability scores", () => {
    const xml = doc(vertex("a", 20, 20) + vertex("b", 20, 20), compactPage);
    const renamed = validateXml(xml.replace("Page-1", "routes through; overlap; cross; reduce bends"));
    expect(renamed.warnings).toHaveLength(1);
    expect(renamed.score).toEqual({ total: 5, through: 0, crossings: 0, overlaps: 1, anchors: 0 });
    expect(renamed.score).toEqual(validateXml(xml).score);
  });

  it("uses effective wrapper label, wrapper value, and fallback inner value in readability checks", () => {
    const text = "A deliberately long label for this narrow vertex";
    const plain = vertex("a", 20, 20, 80, 40, "fontSize=8;", text);
    const expected = validateXml(doc(plain, compactPage)).warnings;
    expect(expected).toHaveLength(2);
    for (const [attributes, innerValue] of [[`label="${text}" value="unused"`, "unused"], [`value="${text}"`, "unused"], ["", text]]) {
      const inner = plain.replace(' id="a"', "").replace(`value="${text}"`, `value="${innerValue}"`);
      expect(validateXml(doc(`<UserObject id="a" ${attributes}>${inner}</UserObject>`, compactPage)).warnings).toEqual(expected);
    }
  });

  it("uses signed normal displacement and explicit offset for inline label advice and shape intersection", () => {
    const cells = vertex("a", 40, 100) + vertex("b", 300, 100) + vertex("above", 150, 42);
    const label = (normal: number, offset = 0) =>
      `<mxCell id="e" value="DATA" edge="1" parent="1" source="a" target="b"><mxGeometry y="${normal}" relative="1" as="geometry"><Array as="points"><mxPoint x="210" y="120"/></Array><mxPoint as="offset" y="${offset}"/></mxGeometry></mxCell>`;
    const warnings = (normal: number, offset?: number) => validateXml(doc(cells + label(normal, offset), finitePage)).warnings;
    const onLine = expect.stringContaining("label sits directly on its line");
    const onShape = expect.stringContaining("edge label 'e' likely overlaps vertex 'above'");
    expect(warnings(0)).toContainEqual(onLine);
    expect(warnings(40)).not.toContainEqual(onLine);
    expect(warnings(40)).toContainEqual(onShape);
    expect(warnings(-40)).not.toContainEqual(onShape);
    expect(warnings(40, 40)).toContainEqual(onLine);
    expect(warnings(40, 40)).not.toContainEqual(onShape);
  });
  it("passes a clean two-node, one-waypointed-edge diagram when page dimensions are omitted", () => {
    const result = validateXml(doc(vertex("a", 0, 0) + vertex("b", 200, 0) + routedEdge("e1", "a", "b", 140, 20)));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.observations).toContain(
      "page 'Page-1': page dimensions are omitted or invalid; boundary, outer-margin, and empty-space checks require both pageWidth and pageHeight",
    );
  });

  it("validates animated SVG connector controls and portable page sequences", () => {
    const animation = JSON.stringify({
      animation: {
        loop: false,
        steps: [
          { opacity: { cells: ["a"], value: 0 } },
          { fadeIn: { cells: ["a"], delay: 500 } },
        ],
      },
    }).replaceAll('"', "&quot;");
    const animated = `<mxfile><diagram name="Animated"><mxGraphModel><root>
      <UserObject label="" id="0" animation="${animation}"><mxCell/></UserObject>
      <mxCell id="1" parent="0"/>
      ${vertex("a", 0, 0)}${vertex("b", 200, 0)}
      ${routedEdge("flow", "a", "b", 140, 20).replace(">", ' style="flowAnimation=1;flowAnimationDuration=1200;flowAnimationDirection=reverse;">')}
    </root></mxGraphModel></diagram></mxfile>`;
    const result = validateXml(animated);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.observations).toContain(
      "page 'Animated': 1 connector(s) use persistent flow animation; SVG preserves it, static formats do not: 'flow'",
    );
    expect(result.observations).toContain(
      "page 'Animated': page animation contains 2 step(s); standalone animated SVG supports visibility, opacity, fade, and wait actions",
    );

    const invalid = validateXml(
      doc(
        vertex("a", 0, 0) +
          vertex("b", 200, 0) +
          edge("bad", "a", "b", "flowAnimation=1;flowAnimationDuration=fast;flowAnimationDirection=sideways"),
      ),
    );
    expect(invalid.errors).toContain(
      "page 'Page-1': edge 'bad' has invalid flowAnimationDuration 'fast' (expected a positive millisecond value)",
    );
    expect(invalid.errors).toContain("page 'Page-1': edge 'bad' has invalid flowAnimationDirection 'sideways'");
  });

  it("warns when page animation effects cannot be compiled to standalone SVG", () => {
    const animation = JSON.stringify({ animation: { steps: [{ highlight: { cells: ["a"] } }] } }).replaceAll(
      '"',
      "&quot;",
    );
    const xml = `<mxfile><diagram name="Animated"><mxGraphModel><root>
      <UserObject label="" id="0" animation="${animation}"><mxCell/></UserObject>
      <mxCell id="1" parent="0"/>${vertex("a", 0, 0)}
    </root></mxGraphModel></diagram></mxfile>`;
    expect(validateXml(xml).warnings).toContain(
      "page 'Animated': page animation step 1 action 'highlight' is not supported in standalone animated SVG",
    );
  });

  it("warns when edges are auto-routed and cannot be route-checked", () => {
    const result = validateXml(doc(vertex("a", 0, 0) + vertex("b", 200, 0) + edge("e1", "a", "b")));
    expect(result.warnings).toContain(
      "page 'Page-1': 1 auto-routed edge(s) cannot be route-checked (no explicit waypoints): 'e1'; add waypoints and pinned anchors, or verify their routing visually",
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

  it("warns when a connector label lands on a bend of its own route or on another connector", () => {
    const orthogonal = "edgeStyle=orthogonalEdgeStyle;fontSize=12;labelBackgroundColor=#ffffff;";
    const labeled = (offset: string, extra = "") =>
      `<mxCell id="e1" edge="1" parent="1" source="user" target="hub" value="commands" style="${orthogonal}exitX=0.5;exitY=1;entryX=0.5;entryY=0;"><mxGeometry relative="1" as="geometry">${offset}<Array as="points"><mxPoint x="40" y="120"/><mxPoint x="340" y="120"/></Array></mxGeometry></mxCell>${extra}`;
    const shapes = vertex("user", 0, 0) + vertex("hub", 300, 200);
    const onBend = "edge label 'e1' likely sits on a bend or another segment of its own connector";

    // Centered on its horizontal run: the background color handles the line underneath.
    expect(validateXml(doc(shapes + labeled(""))).warnings.some((warning) => warning.includes(onBend))).toBe(false);
    // An offset that pushes the text onto the vertical leg of its own route.
    const pushed = validateXml(doc(shapes + labeled('<mxPoint x="-150" y="-15" as="offset"/>')));
    expect(pushed.warnings.some((warning) => warning.includes(onBend))).toBe(true);

    // Another connector whose vertical leg runs through the label.
    const crossing = `<mxCell id="e2" edge="1" parent="1" source="side" target="hub" style="${orthogonal}exitX=0.5;exitY=1;entryX=0;entryY=0.5;"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="190" y="60"/><mxPoint x="190" y="220"/></Array></mxGeometry></mxCell>`;
    const both = validateXml(doc(shapes + vertex("side", 150, -100) + labeled("", crossing)));
    expect(hasDiagnostic(both.warnings, "edge label 'e1' likely overlaps edge 'e2'")).toBe(true);
  });

  it("ignores collinear waypoints and 1px jogs when checking label placement", () => {
    const style = "edgeStyle=orthogonalEdgeStyle;fontSize=12;labelBackgroundColor=#ffffff;exitX=1;exitY=0.5;entryX=0;entryY=0.5;";
    const jog = `<mxCell id="e1" edge="1" parent="1" source="a" target="b" value="YES" style="${style}"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="160" y="20"/><mxPoint x="160" y="21"/></Array></mxGeometry></mxCell>`;
    const result = validateXml(doc(vertex("a", 0, 0) + vertex("b", 240, 1) + jog));
    expect(result.warnings.filter((warning) => warning.includes("edge label"))).toEqual([]);
  });

  it("reports likely route-through for auto-routed edges as a preview observation", () => {
    const result = validateXml(
      doc(vertex("a", 0, 0) + vertex("b", 400, 0) + vertex("blocker", 180, 0, 80, 40) + edge("e1", "a", "b")),
    );
    expect(result.observations).toContain(
      "page 'Page-1': edge 'e1' may pass over vertex 'blocker' (predicted from the direct line; verify in the preview, then add waypoints or move the shape if needed)",
    );
    expect(result.warnings.some((warning) => warning.includes("1 auto-routed edge(s) cannot be route-checked"))).toBe(true);

    const clear = validateXml(
      doc(vertex("a", 0, 0) + vertex("b", 400, 0) + vertex("aside", 180, 200, 80, 60) + edge("e1", "a", "b")),
    );
    expect(clear.observations.filter((observation) => observation.includes("may pass over"))).toEqual([]);
  });

  it("flags source and target anchors that face away from their peers", () => {
    const sourceWrong = validateXml(
      doc(vertex("a", 0, 0) + vertex("b", 0, 200) + edge("e1", "a", "b", "exitX=0.5;exitY=0")),
    );
    expect(sourceWrong.warnings).toContain(
      "page 'Page-1': edge 'e1': source exit pinned to top but target is below; re-pin to bottom (exitX=0.5;exitY=1) to shorten the route and reduce bends",
    );
    expect(sourceWrong.score).toMatchObject({ total: 8, anchors: 1 });

    const targetWrong = validateXml(
      doc(vertex("a", 0, 0) + vertex("b", 0, 200) + edge("e1", "a", "b", "entryX=0.5;entryY=1")),
    );
    expect(targetWrong.warnings).toContain(
      "page 'Page-1': edge 'e1': target entry pinned to bottom but source is above; re-pin to top (entryX=0.5;entryY=0) to shorten the route and reduce bends",
    );
    expect(targetWrong.score).toMatchObject({ total: 8, anchors: 1 });
  });

  it("does not flag correctly pinned, unpinned, or relative-port anchors", () => {
    const correct = validateXml(
      doc(
        vertex("a", 0, 0) +
          vertex("b", 0, 200) +
          edge("e1", "a", "b", "exitX=0.5;exitY=1;entryX=0.5;entryY=0"),
      ),
    );
    expect(correct.warnings.filter((warning) => warning.endsWith("reduce bends"))).toEqual([]);

    const unpinned = validateXml(doc(vertex("a", 0, 0) + vertex("b", 0, 200) + edge("e1", "a", "b")));
    expect(unpinned.warnings.filter((warning) => warning.endsWith("reduce bends"))).toEqual([]);

    const detoured = `<mxCell id="detour" edge="1" parent="1" source="a" target="b" style="entryX=0;entryY=0.5;"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="-100" y="220"/></Array></mxGeometry></mxCell>`;
    const waypointFacing = validateXml(doc(vertex("a", 300, 0) + vertex("b", 0, 200) + detoured));
    expect(waypointFacing.warnings.filter((warning) => warning.endsWith("reduce bends"))).toEqual([]);

    const container = vertex("box", 0, 0, 200, 120);
    const port = `<mxCell id="port" vertex="1" parent="box"><mxGeometry x="0.5" y="1" width="10" height="10" relative="1" as="geometry"/></mxCell>`;
    const relativePort = validateXml(
      doc(container + port + vertex("b", 0, 250) + edge("e1", "port", "b", "exitX=0.5;exitY=0")),
    );
    expect(relativePort.warnings.filter((warning) => warning.endsWith("reduce bends"))).toEqual([]);
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

    const thresholds = validateXml(
      doc(
        vertex("node10", 0, 100, 80, 40, "fontSize=10;", "Node") +
          vertex("node11", 200, 100, 80, 40, "fontSize=11;", "Node") +
          edge("edge9", "node10", "node11", "fontSize=9;", "9") +
          edge("edge10", "node10", "node11", "fontSize=10;", "10"),
      ),
    );
    expect(thresholds.warnings).toContain("page 'Page-1': vertex 'node10' has very small explicit fontSize 10px");
    expect(thresholds.warnings).toContain(
      "page 'Page-1': connector label 'edge9' has very small explicit fontSize 9px",
    );
    expect(thresholds.warnings.some((warning) => warning.includes("vertex 'node11'") && warning.includes("fontSize"))).toBe(false);
    expect(thresholds.warnings.some((warning) => warning.includes("label 'edge10'") && warning.includes("fontSize"))).toBe(false);
  });

  it("normalizes HTML-like label markup without counting tags or line breaks as visible text", () => {
    const formattedShort = vertex(
      "formatted",
      0,
      0,
      120,
      40,
      "rounded=1;",
      "&lt;span data-description='this attribute is intentionally much longer than the label'&gt;Short&lt;/span&gt;",
    );
    const multiline = vertex(
      "multiline",
      200,
      0,
      120,
      40,
      "rounded=1;",
      "A deliberately lengthy first line&lt;br /&gt;A deliberately lengthy second line",
    );
    const result = validateXml(doc(formattedShort + multiline));
    expect(result.warnings.filter((warning) => warning.includes("long label"))).toEqual([]);
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
    expect(
      result.warnings.some((warning) =>
        warning.includes("4 auto-routed edge(s) cannot be route-checked (no explicit waypoints): 'e1', 'e2', 'e3', 'e4'"),
      ),
    ).toBe(true);
  });

  it("warns when an edge label likely overlaps a vertex, keyed on the estimated label box", () => {
    const nodes = vertex("a", 0, 100) + vertex("b", 400, 100) + vertex("victim", 200, 30);
    const labeled = (offsetY: number) =>
      `<mxCell id="e1" edge="1" parent="1" source="a" target="b" value="DATA TRANSFER" style="labelBackgroundColor=#ffffff;"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="240" y="120"/></Array><mxPoint as="offset" x="0" y="${offsetY}"/></mxGeometry></mxCell>`;
    const overlapping = validateXml(doc(nodes + labeled(-60)));
    expect(overlapping.warnings).toContain("page 'Page-1': edge label 'e1' likely overlaps vertex 'victim'");

    const clear = validateXml(doc(nodes + labeled(60)));
    expect(clear.warnings.filter((warning) => warning.includes("likely overlaps"))).toEqual([]);
  });

  it("warns when an inline edge label has neither an offset nor a background", () => {
    const nodes = vertex("a", 0, 0) + vertex("b", 200, 0);
    const bare = validateXml(doc(nodes + edge("e1", "a", "b", "", "HTTP")));
    expect(bare.warnings).toContain(
      "page 'Page-1': edge 'e1' label sits directly on its line; add an offset or labelBackgroundColor",
    );

    const backgrounded = validateXml(doc(nodes + edge("e1", "a", "b", "labelBackgroundColor=#ffffff;", "HTTP")));
    expect(backgrounded.warnings.filter((warning) => warning.includes("sits directly on its line"))).toEqual([]);
  });

  it("keeps the checked-in examples warning-free", () => {
    const examples = readdirSync(resolve("example")).filter((name) => name.endsWith(".drawio")).sort();
    expect(examples.length).toBeGreaterThan(0);
    for (const name of examples) {
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
