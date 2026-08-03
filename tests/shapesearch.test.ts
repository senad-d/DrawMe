import { describe, it, expect } from "vitest";
import { searchShapes } from "../src/shapesearch";

describe("searchShapes (over the bundled shape index)", () => {
  it("returns official styles for a plain keyword (matches upstream ranking)", () => {
    const r = searchShapes("rectangle", 5);
    expect(r).toHaveLength(5);
    // every hit is a real 'rectangle' shape with a non-empty official style
    for (const m of r) {
      expect(m.title.toLowerCase()).toContain("rectangle");
      expect(m.style.length).toBeGreaterThan(0);
    }
    // parity with scripts/shapesearch.py (verified): the alphabetical head of the tied group
    expect(r.map((m) => m.title)).toEqual([
      "Cloud Rectangle",
      "Corner Rounded Rectangle",
      "Diagonal Rounded Rectangle",
      "Diagonal Snip Rectangle",
      "Double Rectangle",
    ]);
  });

  it("finds an AWS Lambda shape and ranks the verbatim title first", () => {
    const r = searchShapes("aws lambda", 5);
    expect(r.length).toBeGreaterThan(0);
    // the top hit's title should mention lambda (verbatim-title tiebreaker)
    expect(r[0].title.toLowerCase()).toContain("lambda");
  });

  it("finds a UML actor shape", () => {
    const r = searchShapes("uml actor", 5);
    expect(r.some((m) => m.title.toLowerCase().includes("actor") || m.style.toLowerCase().includes("actor"))).toBe(true);
  });

  it("respects the limit", () => {
    expect(searchShapes("aws", 3).length).toBeLessThanOrEqual(3);
  });

  it("returns nothing for gibberish", () => {
    expect(searchShapes("zzzqqwx-not-a-shape")).toEqual([]);
  });
});
