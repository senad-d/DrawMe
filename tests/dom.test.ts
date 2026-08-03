import { describe, expect, it } from "vitest";
import { ELEMENT_NODE, TEXT_NODE, type DomEl, directText, firstByTag } from "../src/dom";

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
