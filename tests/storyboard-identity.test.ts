import { DOMParser } from "@xmldom/xmldom";
import { expect, it } from "vitest";
import type { DomEl } from "../src/dom";
import { buildStoryboard } from "../src/storyboard";

it("omits hidden-layer content and keeps connectors linked to uniquely identified clones", () => {
  const parser = new DOMParser();
  const model = parser.parseFromString(`<mxGraphModel pageWidth="300" pageHeight="180"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="draft-layer" parent="0" visible="0"/>
    <mxCell id="draft" value="DRAFT ONLY" vertex="1" parent="draft-layer"><mxGeometry x="40" y="90" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="frame" value="Start" vertex="1" parent="1"><mxGeometry x="40" y="40" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="caption" value="End" vertex="1" parent="1"><mxGeometry x="180" y="40" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="edge" edge="1" source="frame" target="caption" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`, "text/xml").documentElement as unknown as DomEl;
  const board = buildStoryboard(model, [{ time: 200, label: "Review step", opacity: new Map(), accent: new Map() }]);
  const cells = Array.from(parser.parseFromString(board, "text/xml").getElementsByTagName("mxCell"));
  const ids = cells.map((cell) => cell.getAttribute("id"));
  expect.soft(cells.map((cell) => cell.getAttribute("value"))).not.toContain("DRAFT ONLY");
  expect.soft(new Set(ids).size, "all storyboard cells must have unique IDs").toBe(ids.length);
  const edge = cells.find((cell) => cell.getAttribute("edge") === "1");
  expect(cells.filter((cell) => cell.getAttribute("id") === edge?.getAttribute("source")).map((cell) => cell.getAttribute("value"))).toEqual(["Start"]);
  expect(cells.filter((cell) => cell.getAttribute("id") === edge?.getAttribute("target")).map((cell) => cell.getAttribute("value"))).toEqual(["End"]);
});

it("drops edges and labels that depend on omitted clones and preserves surviving wrapped parents", () => {
  const parser = new DOMParser();
  const model = parser.parseFromString(`<mxGraphModel pageWidth="300" pageHeight="180"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <UserObject id="container" label="Container"><mxCell vertex="1" parent="1"><mxGeometry width="100" height="80" as="geometry"/></mxCell></UserObject>
    <mxCell id="inside" value="Inside" parent="container" vertex="1"><mxGeometry x="10" y="10" width="20" height="20" as="geometry"/></mxCell>
    <mxCell id="hidden" parent="container" visible="0" vertex="1"><mxGeometry x="10" y="40" width="20" height="20" as="geometry"/></mxCell>
    <mxCell id="edge" edge="1" value="Omitted edge" source="inside" target="hidden" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="label" value="Omitted label" vertex="1" parent="edge"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel>`, "text/xml").documentElement as unknown as DomEl;
  const board = buildStoryboard(model, [{ time: 200, label: "Review step", opacity: new Map(), accent: new Map() }]);
  const output = parser.parseFromString(board, "text/xml");
  const wrapper = output.getElementsByTagName("UserObject")[0];
  const cells = Array.from(output.getElementsByTagName("mxCell"));
  expect(wrapper.getAttribute("label")).toBe("Container");
  expect(cells.find((cell) => cell.getAttribute("value") === "Inside")?.getAttribute("parent")).toBe(wrapper.getAttribute("id"));
  expect(cells.some((cell) => cell.getAttribute("edge") === "1")).toBe(false);
  expect(board).not.toContain("Omitted label");
});
