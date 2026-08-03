import { describe, it, expect } from "vitest";
import { mermaidArgs, layoutArgs, applyLayout, convertMermaid, LAYOUT_PRESETS } from "../src/drawio";

describe("mermaid / layout arg builders", () => {
  it("mermaidArgs converts to xml format", () => {
    expect(mermaidArgs("d.mmd", "d.drawio")).toEqual(["-x", "-f", "xml", "-o", "d.drawio", "d.mmd"]);
  });

  it("layoutArgs passes the preset through --layout", () => {
    expect(layoutArgs("d.drawio", "verticalTree", "d.layout.drawio")).toEqual([
      "-x",
      "-f",
      "xml",
      "--layout",
      "verticalTree",
      "-o",
      "d.layout.drawio",
      "d.drawio",
    ]);
  });

  it("exposes exactly the safe ELK presets", () => {
    expect([...LAYOUT_PRESETS]).toEqual([
      "verticalFlow",
      "horizontalFlow",
      "verticalTree",
      "horizontalTree",
      "radialTree",
      "organic",
    ]);
  });
});

describe("guards (no draw.io CLI needed)", () => {
  it("applyLayout rejects an unknown preset before doing any work", async () => {
    await expect(applyLayout({ input: "whatever.drawio", preset: "bogus" as any })).rejects.toThrow(/unknown layout preset/);
  });

  it("convertMermaid requires either inline text or an input path", async () => {
    // On draw.io < 30 this rejects with a version message; on >= 30 with the missing-input message.
    await expect(convertMermaid({})).rejects.toThrow(/draw\.io v30\+|either `input`|not found/);
  });
});
