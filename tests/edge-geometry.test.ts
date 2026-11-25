import { describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { attr, type DomEl } from "../src/dom";
import { collectCells, collectCellsWithIds, contentBounds, edgeLabelAnchor, explicitEdgeLabelRect } from "../src/geometry";

function graphRoot(cells: string): DomEl {
  return new DOMParser().parseFromString(`<root>${cells}</root>`, "text/xml").documentElement as unknown as DomEl;
}

describe("shared graph geometry", () => {
  it("exposes the same label text for plain and wrapped cells during analysis", () => {
    const cells = collectCells(graphRoot(`
      <mxCell id="plain" value="&lt;b&gt;Queue&lt;/b&gt;" vertex="1"/>
      <UserObject id="wrapped" label="&lt;b&gt;Queue&lt;/b&gt;"><mxCell vertex="1"/></UserObject>
    `));
    expect(cells.map((cell) => attr(cell, "value"))).toEqual(["<b>Queue</b>", "<b>Queue</b>"]);
  });

  it("bounds only finite free terminals, including a zero coordinate omitted by the encoder", () => {
    const { cells, ids } = collectCellsWithIds(graphRoot(`
      <mxCell id="e" edge="1"><mxGeometry relative="1" as="geometry">
        <mxPoint x="140" as="sourcePoint"/>
        <mxPoint x="-900" y="Infinity" as="targetPoint"/>
      </mxGeometry></mxCell>
    `));
    expect(contentBounds(cells, ids)).toEqual({ minX: 140, minY: 0, maxX: 140, maxY: 0 });
  });

  it("uses the outgoing segment's normal for an inline label at a repeated bend", () => {
    const [edge] = collectCells(graphRoot(`
      <mxCell id="e" edge="1" value="Queue"><mxGeometry relative="1" y="12" as="geometry">
        <mxPoint x="3" y="7" as="offset"/>
      </mxGeometry></mxCell>
    `));
    // Halfway is (80, 0), and the downward segment's positive normal points right.
    expect(edgeLabelAnchor(edge, [[0, 0], [80, 0], [80, 0], [80, 80]])).toEqual([95, 7]);
  });

  it("lets callers stop work inside a label's route traversal", () => {
    const [edge] = collectCells(graphRoot('<mxCell id="e" edge="1" value="Queue"/>'));
    const stop = new Error("geometry work limit");
    let remaining = 2;
    expect(() =>
      edgeLabelAnchor(edge, [[0, 0], [80, 0], [80, 80], [160, 80]], (work = 1) => {
        remaining -= work;
        if (remaining < 0) throw stop;
      }),
    ).toThrow(stop);
  });

  it.each([
    { direction: "rightward", start: [-10, -10], via: [100, 0], end: [90, 50], fraction: -0.5, box: [33, -10, 20, 10] },
    { direction: "downward", start: [-10, -10], via: [0, 80], end: [70, 70], fraction: -0.5, box: [5, 42, 20, 10] },
    { direction: "reversed", start: [90, 50], via: [100, 0], end: [-10, -10], fraction: 0.5, box: [33, 14, 20, 10] },
  ])("places a displaced label box on the oriented $direction segment", ({ start, via, end, fraction, box }) => {
    // Each route is 160 px long, with 20x20 vertex centers as its ends. The
    // relative x selects 40 or 120 px along it; positive y offsets it along
    // the oriented normal (upwards on the rightward segment).
    const { ids } = collectCellsWithIds(graphRoot(`
      <mxCell id="a" vertex="1"><mxGeometry x="${start[0]}" y="${start[1]}" width="20" height="20" as="geometry"/></mxCell>
      <mxCell id="b" vertex="1"><mxGeometry x="${end[0]}" y="${end[1]}" width="20" height="20" as="geometry"/></mxCell>
      <mxCell id="e" edge="1" source="a" target="b"><mxGeometry relative="1" as="geometry">
        <Array as="points"><mxPoint x="${via[0]}" y="${via[1]}"/></Array>
      </mxGeometry></mxCell>
      <mxCell id="label" value="Queue" vertex="1" style="edgeLabel;" parent="e">
        <mxGeometry relative="1" x="${fraction}" y="12" width="20" height="10" as="geometry">
          <mxPoint x="3" y="7" as="offset"/>
        </mxGeometry>
      </mxCell>
    `));
    expect(explicitEdgeLabelRect(ids.get("label")!, ids)).toEqual(box);
  });
});
