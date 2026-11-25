import { deflateRawSync } from "node:zlib";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { ELEMENT_NODE, TEXT_NODE, type DomEl, diagramPages, directText, firstByTag, pageModel } from "../src/dom";

function rootOf(xml: string): DomEl {
  return new DOMParser().parseFromString(xml, "text/xml").documentElement as unknown as DomEl;
}

function node(nodeType: number, tagName?: string, nodeValue?: string | null, children: DomEl[] = []): DomEl {
  return {
    nodeType,
    tagName,
    nodeValue,
    childNodes: children,
    getAttribute: () => null,
    hasAttribute: () => false,
    setAttribute: () => undefined,
  };
}

describe("DOM helpers", () => {
  it("returns null when element children do not have the requested tag", () => {
    const parent = node(ELEMENT_NODE, "parent", null, [node(ELEMENT_NODE, "other")]);
    expect(firstByTag(parent, "wanted")).toBeNull();
  });

  it("ignores element children and null text values when reading direct text", () => {
    const parent = node(ELEMENT_NODE, "parent", null, [node(ELEMENT_NODE, "child"), node(TEXT_NODE, undefined, null)]);
    expect(directText(parent)).toBe("");
  });
});

describe("diagram pages", () => {
  it("selects the same graph in bare, single-diagram and mxfile forms", () => {
    const graph = '<mxGraphModel pageWidth="640"><root/></mxGraphModel>';
    const bare = rootOf(graph);
    const single = rootOf(`<diagram>${graph}</diagram>`);
    const wrapped = rootOf(`<mxfile><diagram>${graph}</diagram></mxfile>`);

    expect(diagramPages(bare)).toEqual([bare]);
    expect(diagramPages(single)).toEqual([single]);
    expect(pageModel(bare)).toBe(bare);
    for (const root of [bare, single, wrapped]) {
      const pages = diagramPages(root);
      expect(pages).toHaveLength(1);
      const model = pageModel(pages[0]);
      expect(model?.tagName).toBe("mxGraphModel");
      expect(model?.getAttribute("pageWidth")).toBe("640");
    }
  });

  it("counts direct diagram envelopes without needing an uncompressed graph", () => {
    const compressed = deflateRawSync(encodeURIComponent("<mxGraphModel><root/></mxGraphModel>")).toString("base64");
    const root = rootOf(`<mxfile>
      <diagram name="Packed">${compressed}</diagram>
      <metadata><diagram name="Not a page"/></metadata>
      <diagram name="Missing"><metadata><mxGraphModel/></metadata></diagram>
    </mxfile>`);
    const pages = diagramPages(root);
    expect(pages.map((page) => page.getAttribute("name"))).toEqual(["Packed", "Missing"]);
    expect(pages.map(pageModel)).toEqual([null, null]);
    expect(pages.map((page) => directText(page).trim())).toEqual([compressed, ""]);
  });

  it("does not treat an empty mxfile as a page", () => {
    expect(diagramPages(rootOf("<mxfile/>"))).toEqual([]);
  });

  it("rejects unrecognized root types even when they contain diagrams", () => {
    expect(() => diagramPages(rootOf("<document><diagram/></document>"))).toThrow(/root/);
  });
});
