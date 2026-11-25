import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { attr, type DomEl } from "../src/dom";
import {
  type ById, type Point, collectCells, collectCellsWithIds, contentBounds, edgeLabelAnchor, edgeRoute,
  explicitEdgeLabelRect, isVisible, parentOrigin,
} from "../src/geometry";
import { createValidationBudget, ValidationBudgetExceeded, type ValidationBudget } from "../src/validation-budget";

function graph(cells: string) {
  return new DOMParser().parseFromString(`<root>${cells}</root>`, "text/xml").documentElement!;
}

describe("shared edge geometry", () => {
  it.each([
    { segment: "horizontal", x: -0.5, y: 20, box: [43, -20, 20, 10] },
    { segment: "vertical", x: 0.5, y: -20, box: [73, 50, 20, 10] },
  ])("places separate labels using fraction, signed normal and offset on a $segment segment", ({ x, y, box }) => {
    const { ids } = collectCellsWithIds(graph(`
      <mxCell id="a" vertex="1"><mxGeometry x="-5" y="-5" width="10" height="10"/></mxCell>
      <mxCell id="b" vertex="1"><mxGeometry x="95" y="95" width="10" height="10"/></mxCell>
      <mxCell id="e" edge="1" source="a" target="b"><mxGeometry relative="1">
        <Array as="points"><mxPoint x="100" y="0"/></Array>
      </mxGeometry></mxCell>
      <mxCell id="label" parent="e" vertex="1" style="edgeLabel"><mxGeometry relative="1" x="${x}" y="${y}" width="20" height="10">
        <mxPoint as="offset" x="3" y="5"/>
      </mxGeometry></mxCell>`) as unknown as DomEl);
    expect(explicitEdgeLabelRect(ids.get("label")!, ids)).toEqual(box);
  });

  it("clamps the label fraction and uses a nonzero segment for its normal", () => {
    const label = graph(`<mxCell><mxGeometry relative="1" x="6" y="4">
      <mxPoint as="offset" x="1" y="2"/>
    </mxGeometry></mxCell>`).firstChild as unknown as DomEl;
    expect(edgeLabelAnchor(label, [[0, 0], [20, 0], [20, 0]])).toEqual([21, -2]);
    expect(edgeLabelAnchor(label, [[20, 0], [20, 0]])).toEqual([21, 2]);
  });

  it("routes a waypointed edge through its free end in the parent's coordinate space", () => {
    const { ids } = collectCellsWithIds(graph(`
      <mxCell id="group" vertex="1"><mxGeometry x="10" y="20" width="40" height="40"/></mxCell>
      <mxCell id="a" vertex="1" parent="group"><mxGeometry x="5" y="5" width="10" height="10"/></mxCell>
      <mxCell id="e" edge="1" parent="group" source="a"><mxGeometry relative="1">
        <mxPoint as="sourcePoint" x="800" y="900"/>
        <Array as="points"><mxPoint x="50" y="10"/></Array>
        <mxPoint as="targetPoint" x="50" y="80"/>
      </mxGeometry></mxCell>`) as unknown as DomEl);
    expect(edgeRoute(ids.get("e")!, ids)).toEqual([[20, 30], [60, 30], [60, 100]]);
  });

  it("uses the wrapper label for analysis without modifying the serialization projection", () => {
    const root = graph(`<mxCell id="plain" value="Review" vertex="1"/>
      <UserObject id="wrapped" label="Review"><mxCell value="Stale" vertex="1"/></UserObject>`);
    const serializer = new XMLSerializer();
    const before = serializer.serializeToString(root);
    const geometryRoot = root as unknown as DomEl;
    expect(collectCellsWithIds(geometryRoot).ids.has("wrapped")).toBe(true);
    expect(serializer.serializeToString(root)).toBe(before);
    expect(collectCells(geometryRoot).map((cell) => attr(cell, "value"))).toEqual(["Review", "Review"]);
  });

  it("falls back to wrapper value, then the inner value when wrapper text is absent", () => {
    const root = graph(`<object id="wrapped" value="Review"><mxCell value="Stale"/></object>
      <UserObject id="fallback"><mxCell value="Inner"/></UserObject>`);
    expect(collectCells(root as unknown as DomEl).map((cell) => attr(cell, "value"))).toEqual(["Review", "Inner"]);
  });

  it("stops within the route segment scan when the work budget runs out", () => {
    const label = graph(`<mxCell><mxGeometry relative="1" x="0.5" y="4"/></mxCell>`).firstChild as unknown as DomEl;
    const route = Array.from({ length: 25 }, (_, x): Point => [x, 0]);
    expect(edgeLabelAnchor(label, route, createValidationBudget(64, 0))).toEqual([18, -4]);
    expect(() => edgeLabelAnchor(label, route, createValidationBudget(5, 0))).toThrow(ValidationBudgetExceeded);
  });

  it("passes the bounds work budget down into the edge's waypoint traversal", () => {
    const ignored = '<mxPoint x="invalid" y="0"/>'.repeat(14);
    const { ids } = collectCellsWithIds(graph(`<mxCell id="s"/><mxCell id="t"/>
      <mxCell id="e" edge="1" source="s" target="t"><mxGeometry relative="1"><Array as="points"><mxPoint x="0" y="0"/>${ignored}<mxPoint x="15" y="0"/></Array></mxGeometry></mxCell>`) as unknown as DomEl);
    const cells = [ids.get("e")!];
    expect(contentBounds(cells, ids, createValidationBudget(64, 0))).toEqual({ minX: 0, minY: 0, maxX: 15, maxY: 0 });
    expect(() => contentBounds(cells, ids, createValidationBudget(8, 0))).toThrow(ValidationBudgetExceeded);
  });

  it.each([
    { traversal: "parent origin", walk: parentOrigin, expected: [8, 16] },
    { traversal: "effective visibility", walk: isVisible, expected: true },
  ])("stops inside the $traversal traversal when the work budget runs out", ({ walk, expected }) => {
    const parents = Array.from({ length: 8 }, (_, i) => `<mxCell id="g${i}" parent="${i === 0 ? "1" : `g${i - 1}`}" vertex="1">
      <mxGeometry x="1" y="2" width="10" height="10"/>
    </mxCell>`).join("");
    const root = graph(`<mxCell id="0"/><mxCell id="1" parent="0"/>${parents}<mxCell id="leaf" parent="g7"/>`);
    const { ids } = collectCellsWithIds(root as unknown as DomEl);
    const leaf = ids.get("leaf")!;
    const traverse: (cell: DomEl, byId: ById, budget?: ValidationBudget) => unknown = walk;
    expect(traverse(leaf, ids)).toEqual(expected);
    expect(traverse(leaf, ids, createValidationBudget(32, 0))).toEqual(expected);
    expect(() => traverse(leaf, ids, createValidationBudget(3, 0))).toThrow(ValidationBudgetExceeded);
  });
});
