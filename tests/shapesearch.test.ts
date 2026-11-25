import { describe, it, expect } from "vitest";
import { searchShapes } from "../src/shapesearch";

describe("searchShapes (over the bundled shape index)", () => {
  it("ranks the exact title before the unchanged order of other official styles", () => {
    const r = searchShapes("rectangle", 6);
    expect(r).toHaveLength(6);
    // every hit is a real 'rectangle' shape with a non-empty official style
    for (const m of r) {
      expect(m.title.toLowerCase()).toContain("rectangle");
      expect(m.style.length).toBeGreaterThan(0);
    }
    // The exact title now leads; the remaining tied matches keep their old alphabetical order.
    expect(r.map((m) => m.title)).toEqual([
      "Rectangle",
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

  it("ranks the exact alphanumeric title EC2 first", () => {
    expect(searchShapes("ec2", 1).map((shape) => shape.title.toLowerCase())).toEqual(["ec2"]);
  });

  it("finds the same Lambda matches with camel-case and spaced queries", () => {
    const spaced = searchShapes("aws lambda", 5);
    expect(spaced.length).toBeGreaterThan(0);
    expect(searchShapes("awsLambda", 5)).toEqual(spaced);
  });

  it.each([-1, 1.5, Infinity])("rejects the invalid limit %s", (limit) => {
    expect(() => searchShapes("aws", limit)).toThrow();
  });

  it("finds a UML actor shape", () => {
    const r = searchShapes("uml actor", 5);
    expect(r.some((m) => m.title.toLowerCase().includes("actor") || m.style.toLowerCase().includes("actor"))).toBe(true);
  });

  it("respects the limit", () => {
    expect(searchShapes("aws", 3).length).toBeLessThanOrEqual(3);
  });

  it("defaults to ten matches and returns none for a zero limit", () => {
    expect(searchShapes("aws")).toHaveLength(10);
    expect(searchShapes("aws", 0)).toEqual([]);
  });

  it("still finds approximate matches when there is no exact spelling", () => {
    expect(searchShapes("rectngle", 5).some((shape) => /rectangle/i.test(shape.title))).toBe(true);
  });

  it("returns nothing for gibberish", () => {
    expect(searchShapes("zzzqqwx-not-a-shape")).toEqual([]);
  });
});
