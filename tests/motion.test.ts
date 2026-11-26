import { describe, expect, it, vi } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { DEFAULT_VALIDATION_LIMITS, ValidationStop, createValidationBudget } from "../src/diagram-files";
import type { DomEl } from "../src/dom";
import {
  DEFAULT_ACCENT,
  DEFAULT_DARK_ACCENT,
  MOTION_ATTRIBUTE,
  analyzeStoredMotion,
  compileMotion,
  injectMotion,
  isDarkBackground,
  motionCells,
  parseMotionSpec,
  readStoredMotion,
  selectPage,
  storeMotion,
  themeAccent,
  type MotionSpec,
} from "../src/motion";
import { buildStoryboard, sampleFrames, MAX_STORYBOARD_FRAMES } from "../src/storyboard";
import { validateXml } from "../src/validate";

const PAGE = `<mxfile><diagram name="Flow"><mxGraphModel pageWidth="400" pageHeight="200"><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="40" y="40" width="80" height="40" as="geometry"/></mxCell>
  <mxCell id="b" value="B" vertex="1" parent="1"><mxGeometry x="240" y="40" width="80" height="40" as="geometry"/></mxCell>
  <mxCell id="e" value="calls" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="180" y="60"/></Array></mxGeometry></mxCell>
  <mxCell id="d" style="dashed=1;" edge="1" parent="1" source="b" target="a"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><defs/>
  <g data-cell-id="0"><g data-cell-id="1">
    <g data-cell-id="a"><g><rect x="40" y="40" width="80" height="40"/></g></g>
    <g data-cell-id="b"><g><rect x="240" y="40" width="80" height="40"/></g></g>
    <g data-cell-id="e"><g><path d="M 120 60 L 232 60" fill="none" stroke="#000"/><path d="M 240 60 L 232 64 L 232 56 Z" fill="#000"/></g><g><text>calls</text></g></g>
    <g data-cell-id="d"><g><path d="M 240 70 L 120 70" fill="none" stroke-dasharray="3 3" style="animation: flow 500ms linear infinite;"/></g></g>
  </g></g>
</svg>`;

function model(xml = PAGE): DomEl {
  const root = new DOMParser().parseFromString(xml, "text/xml").documentElement as unknown as DomEl;
  return selectPage(root).model;
}

function compile(spec: MotionSpec) {
  return compileMotion(spec, motionCells(model()));
}

describe("motion spec parsing", () => {
  it("accepts a typed spec and rejects malformed fields", () => {
    const errors: string[] = [];
    const spec = parseMotionSpec(
      {
        loop: "yes",
        hold: -1,
        steps: [
          { effect: "spin", cells: ["a"] },
          { effect: "popIn", cells: "a" },
          { effect: "highlight", cells: ["a"], color: "red;}" },
          { effect: "slideIn", cells: ["a"], direction: "diagonal" },
        ],
      },
      errors,
    );
    expect(spec?.steps).toHaveLength(3);
    expect(errors).toContain("motion loop must be a boolean");
    expect(errors).toContain("motion hold must be between 0 and 60000 ms");
    expect(errors.some((error) => error.includes("unknown effect 'spin'"))).toBe(true);
    expect(errors).toContain("motion step 2 cells must be an array of cell ids");
    expect(errors).toContain("motion step 3 color must be a hex color such as #2563eb");
    expect(errors).toContain("motion step 4 direction must be one of up, down, left, right");
  });

  it("requires a non-empty steps array", () => {
    const errors: string[] = [];
    expect(parseMotionSpec({ steps: [] }, errors)).toBeNull();
    expect(errors).toEqual(["motion spec must contain a non-empty steps array"]);
  });
});

describe("motion compilation", () => {
  it("validates targets against the page and the timeline state", () => {
    const result = compile({
      steps: [
        { effect: "drawIn", cells: ["a", "d", "missing"] },
        { effect: "highlight", cells: ["b"] },
        { effect: "travel", cells: ["e"] },
        { effect: "wait" },
        { effect: "popIn", cells: ["b"], parallel: true, duration: 0 },
      ],
    });
    expect(result.compiled).toBeNull();
    expect(result.errors).toContain("motion step 1 (drawIn) needs a connector, but 'a' is a shape");
    expect(result.errors).toContain("motion step 1 (drawIn) cannot draw dashed connector 'd'; use fadeIn or make it solid");
    expect(result.errors).toContain("motion step 1 (drawIn) references missing cell 'missing'");
    expect(result.errors).toContain("motion step 4 (wait) needs a duration in ms");
    expect(result.errors).toContain("motion step 5 (popIn) duration must be between 1 and 60000 ms");
  });

  it("rejects entrances on visible cells and emphasis on hidden ones", () => {
    const result = compile({
      steps: [
        { effect: "highlight", cells: ["a"] },
        { effect: "popIn", cells: ["a"] },
        { effect: "popIn", cells: ["b"] },
        { effect: "fadeIn", cells: ["e"] },
        { effect: "fadeOut", cells: ["e"] },
        { effect: "travel", cells: ["e"] },
      ],
    });
    expect(result.errors).toContain(
      "motion step 2 (popIn) targets 'a', which is already visible; fade it out first or use highlight",
    );
    expect(result.errors).toContain("motion step 6 (travel) targets 'e', which is hidden at that point; reveal it first");
  });

  it("rejects wait-only and no-op timelines rather than treating frames or CSS as motion", () => {
    const specs: MotionSpec[] = [
      { steps: [{ effect: "wait", duration: 500 }] },
      { steps: [{ effect: "dim", cells: ["a"], value: 1 }] },
      { steps: [{ effect: "highlight", cells: ["e"], color: "#0000" }] },
    ];
    for (const spec of specs) {
      const { compiled, errors } = compile(spec);
      expect(compiled).toBeNull();
      expect(errors.join(" ")).toMatch(/no effective visual motion/i);
    }
  });

  it("rejects repeated full entrance but permits fading a dimmed cell back to full", () => {
    const fade: MotionSpec["steps"][number] = { effect: "fadeIn", cells: ["a"] };
    const repeated = compile({ steps: [fade, fade] });
    expect(repeated.compiled).toBeNull();
    expect(repeated.errors.join(" ")).toContain("already visible");
    const dimmed = compile({ steps: [fade, { effect: "dim", cells: ["a"], value: 0.25 }, fade] });
    expect(dimmed.errors).toEqual([]);
    expect(dimmed.compiled?.frames.map((frame) => frame.opacity.get("a"))).toEqual([1, 0.25, 1]);
  });

  it("uses an ancestor's opacity at the actual staggered start, independent of parallel step order", () => {
    const cells = motionCells(model(PAGE.replace('id="b" value="B" vertex="1" parent="1"', 'id="b" value="B" vertex="1" parent="a"')));
    const fade: MotionSpec["steps"][number] = { effect: "fadeIn", cells: ["a"], duration: 500 };
    const highlight: MotionSpec["steps"][number] = { effect: "highlight", cells: ["b"] };
    expect(compileMotion({ steps: [highlight, fade] }, cells).errors.join(" ")).toContain("hidden at that point");
    expect(compileMotion({ steps: [fade, { ...highlight, parallel: true }] }, cells).errors.join(" "))
      .toContain("hidden at that point");
    expect(compileMotion({ steps: [fade, highlight] }, cells).errors).toEqual([]);
    expect(compileMotion({ steps: [{ effect: "fadeOut", cells: ["a"] }, { ...highlight, parallel: true }] }, cells).errors)
      .toEqual([]);
    const staggered = { ...highlight, cells: ["e", "b"], stagger: 250 };
    for (const steps of [[fade, { ...staggered, parallel: true }], [staggered, { ...fade, parallel: true }]]) {
      const result = compileMotion({ steps }, cells);
      expect(result.errors).toEqual([]);
      expect(result.compiled?.frames[0].accent.has("b")).toBe(true);
    }
  });

  it("does not certify effects in authored hidden layers, including fades that change a local track", () => {
    const cells = motionCells(model(PAGE.replace('id="1" parent="0"', 'id="1" parent="0" visible="0"')));
    expect(compileMotion({ steps: [{ effect: "highlight", cells: ["b"] }] }, cells).errors.join(" "))
      .toContain("hidden at that point");
    expect(compileMotion({ steps: [{ effect: "fadeIn", cells: ["b"] }] }, cells).errors.join(" "))
      .toMatch(/no effective visual motion|hidden/);
  });

  it("keeps the documented step, timing, and storyboard sampling boundaries", () => {
    const wait = { effect: "wait", duration: 60_000 } as const;
    const highlight: MotionSpec["steps"][number] = { effect: "highlight", cells: ["a"], duration: 60_000 };
    const longest: MotionSpec = { hold: 60_000, steps: [highlight, wait, wait, wait, wait] };
    expect(compile(longest).compiled).toMatchObject({ sequenceMs: 300_000, durationMs: 360_000 });
    expect(compile({ ...longest, steps: [...longest.steps, { ...wait, duration: 1 }] }).errors.join(" "))
      .toContain("maximum 300000 ms");
    expect(compile({ steps: [{ ...highlight, duration: 60_001 }] }).errors.join(" ")).toContain("60000 ms");
    expect(compile({ steps: [{ ...highlight, stagger: 60_000 }] }).errors).toEqual([]);
    expect(compile({ steps: [{ ...highlight, stagger: 60_001 }] }).errors.join(" ")).toContain("60000 ms");
    const many = { steps: Array<MotionSpec["steps"][number]>(200).fill({ ...highlight, duration: 10 }) };
    const parsed = parseMotionSpec(many, []);
    const frames = compile(parsed!).compiled!.frames;
    expect(frames).toHaveLength(200);
    expect(sampleFrames(frames)).toHaveLength(12);
    const errors: string[] = [];
    parseMotionSpec({ steps: [...many.steps, highlight] }, errors);
    expect(errors).toEqual(["motion spec has 201 steps (maximum 200)"]);
  });

  it("adds wait time between visual batches without adding a frame", () => {
    const motion = compile({ loop: false, steps: [
      { effect: "fadeIn", cells: ["a"], duration: 200 },
      { effect: "wait", duration: 450 },
      { effect: "highlight", cells: ["a"], duration: 300 },
    ] }).compiled!;
    expect(motion.durationMs).toBe(950);
    expect(motion.frames.map((frame) => frame.time)).toEqual([200, 950]);
  });

  it("rejects the same cell twice in one parallel group", () => {
    const result = compile({
      steps: [
        { effect: "popIn", cells: ["a"] },
        { effect: "highlight", cells: ["a"], parallel: true },
      ],
    });
    expect(result.errors).toContain("motion step 2 (highlight) targets 'a' again in the same parallel group");
  });

  it("builds a staggered, looping timeline with frames per sequential batch", () => {
    const result = compile({
      hold: 1000,
      steps: [
        { effect: "popIn", cells: ["a", "b"], stagger: 100, duration: 500 },
        { effect: "drawIn", cells: ["e"], duration: 800 },
        { effect: "wait", duration: 200 },
        { effect: "travel", cells: ["e"], duration: 1000 },
        { effect: "highlight", cells: ["b"], parallel: true, duration: 600, color: "#f59e0b" },
        { effect: "dim", cells: ["a"], value: 0.3 },
      ],
    });
    expect(result.errors).toEqual([]);
    const motion = result.compiled!;
    expect(motion.sequenceMs).toBe(600 + 800 + 200 + 1000 + 500);
    expect(motion.durationMs).toBe(motion.sequenceMs + 1000);
    expect(motion.loop).toBe(true);
    expect(motion.drawInEdgeIds).toEqual(["e"]);
    expect(motion.dots).toEqual([{ cellId: "e", start: 1600, duration: 1000, color: "#2563eb" }]);
    expect(motion.frames.map((frame) => frame.label)).toEqual([
      "popIn a, b",
      "drawIn e",
      "travel e · highlight b",
      "dim a",
    ]);
    expect(motion.frames[0].opacity.get("e")).toBe(0);
    expect(motion.frames[1].opacity.get("e")).toBe(1);
    expect(motion.frames[2].accent.get("b")).toBe("#f59e0b");
    expect(motion.frames[3].opacity.get("a")).toBe(0.3);

    expect(motion.css).toContain('g[data-cell-id="a"] { animation: ');
    expect(motion.css).toContain("transform-box: fill-box; transform-origin: center;");
    expect(motion.css).toContain("transform: translate(0px, 0px) scale(0.6)");
    expect(motion.css).toContain("cubic-bezier(0.34, 1.56, 0.64, 1)");
    expect(motion.css).toContain('g[data-cell-id="e"] [data-drawme-line] { animation: ');
    expect(motion.css).toContain("stroke-dasharray: 1 1;");
    expect(motion.css).toContain("drop-shadow(0px 0px 12px #f59e0b)");
    expect(motion.css).toContain("infinite normal both");
    expect(motion.css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(motion.css).toContain("opacity: 0.3 !important;");
    expect(motion.css).toContain("[data-drawme-dot] { display: none !important; }");
  });

  it("plays once without a hold when loop is false", () => {
    const motion = compile({ loop: false, hold: 5000, steps: [{ effect: "fadeIn", cells: ["a"], duration: 400 }] }).compiled!;
    expect(motion.durationMs).toBe(400);
    expect(motion.css).toContain("400ms linear 0ms 1 normal both");
  });
});

describe("motion SVG injection", () => {
  it("marks connector parts, adds SMIL dots, and appends the stylesheet", () => {
    const motion = compile({
      steps: [
        { effect: "popIn", cells: ["a"] },
        { effect: "drawIn", cells: ["e"] },
        { effect: "travel", cells: ["e"], color: "#10b981" },
      ],
    }).compiled!;
    const svg = injectMotion(SVG, motion, ["d"]);
    expect(svg).toContain('pathLength="1" data-drawme-line="1"');
    expect(svg).toMatch(/<path d="M 240 60 L 232 64 L 232 56 Z" fill="#000" data-drawme-decor="1"\/>/);
    expect(svg).toContain('<g data-drawme-decor="1"><text>calls</text></g>');
    expect(svg).toContain('<circle r="5" fill="#10b981"');
    expect(svg).toContain('<animateMotion path="M 120 60 L 232 60"');
    expect(svg).toContain('keyPoints="0;0;1;1"');
    expect(svg).toContain('repeatCount="indefinite"');
    expect(svg).toContain('data-drawme-animation="motion"');
    expect(svg).toContain('g[data-cell-id="d"] * { animation: none !important; }');
  });

  it("keeps a short SMIL traversal distinct even near the longest allowed sequence", () => {
    const wait = { effect: "wait", duration: 60_000 } as const;
    const motion = compile({ steps: [wait, wait, wait, wait, { effect: "travel", cells: ["e"], duration: 1 }] }).compiled!;
    const svg = new DOMParser().parseFromString(injectMotion(SVG, motion), "image/svg+xml");
    const times = svg.getElementsByTagName("animateMotion")[0].getAttribute("keyTimes")!.split(";").map(Number);
    expect(times[1]).toBeLessThan(times[2]);
  });

  it("refuses unresolved responsive image candidates on the injected-motion path", () => {
    const motion = compile({ steps: [{ effect: "fadeIn", cells: ["a"] }] }).compiled!;
    const picture = '<foreignObject><img xmlns="http://www.w3.org/1999/xhtml" srcset="data:image/png;base64,AAAA 1x, ../logo.png 2x"/></foreignObject>';
    const linked = SVG.replace("</svg>", `${picture}</svg>`);
    expect(() => injectMotion(linked, motion)).toThrow(/unresolved image.*embed/i);
    const embedded = linked.replace("../logo.png", "data:image/png;base64,BBBB");
    expect(injectMotion(embedded, motion)).toContain("data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x");
  });

  it("refuses an SVG that lacks an animated cell", () => {
    const motion = compile({ steps: [{ effect: "fadeIn", cells: ["a"] }] }).compiled!;
    expect(() => injectMotion(SVG.replace('data-cell-id="a"', 'data-cell-id="z"'), motion)).toThrow(
      "SVG is missing animated cell group(s): a",
    );
  });
});

describe("motion storage", () => {
  it("wraps a plain root cell in a UserObject and reads the spec back", () => {
    const page = model();
    storeMotion(page, JSON.stringify({ steps: [{ effect: "fadeIn", cells: ["a"] }] }));
    const root = page as unknown as { getElementsByTagName(tag: string): { length: number; item(i: number): DomEl } };
    const wrapper = root.getElementsByTagName("UserObject").item(0);
    expect(wrapper.getAttribute("id")).toBe("0");
    expect(root.getElementsByTagName("UserObject")).toHaveLength(1);
    expect(readStoredMotion(page)).toContain('"fadeIn"');
    expect(analyzeStoredMotion(page)?.compiled?.targetCellIds).toEqual(["a"]);
  });

  it("sends stored compiler errors to the shared budget at discovery and charges target scans", () => {
    const page = model();
    storeMotion(page, JSON.stringify({ steps: [{ effect: "fadeIn", cells: ["first", "second", "third"] }] }));
    const accepted: string[] = [];
    const diagnose = createValidationBudget({ ...DEFAULT_VALIDATION_LIMITS, maxDiagnostics: 2 },
      (level, message) => accepted.push(`${level}: ${message}`));
    diagnose.finding("warning", "earlier page finding");
    expect(() => analyzeStoredMotion(page, diagnose)).toThrow(ValidationStop);
    expect(accepted).toEqual(["warning: earlier page finding", "error: motion step 1 (fadeIn) references missing cell 'first'"]);

    const cells = motionCells(page);
    const getCell = vi.spyOn(cells, "get");
    const onlyFirst = createValidationBudget({ ...DEFAULT_VALIDATION_LIMITS, maxDiagnostics: 1 }, () => {});
    expect(() => compileMotion({ steps: [{ effect: "fadeIn", cells: ["first", "second", "third"] }] }, cells, undefined, onlyFirst))
      .toThrow(ValidationStop);
    expect(getCell).not.toHaveBeenCalledWith("third");

    storeMotion(page, JSON.stringify({ steps: [{ effect: "fadeIn", cells: Array<string>(200).fill("a") }] }));
    const work = createValidationBudget({ ...DEFAULT_VALIDATION_LIMITS, maxWork: 100 }, () => { throw new Error("unexpected finding"); });
    expect(() => analyzeStoredMotion(page, work)).toThrow(/work limit/);
  });

  it("reports stored-motion errors and timeline conflicts through drawio_validate", () => {
    const stored = JSON.stringify({ steps: [{ effect: "popIn", cells: ["ghost"] }] }).replaceAll('"', "&quot;");
    const xml = PAGE.replace('<mxCell id="0"/>', `<UserObject label="" ${MOTION_ATTRIBUTE}="${stored}" id="0"><mxCell/></UserObject>`);
    expect(validateXml(xml).errors).toContain("page 'Flow': motion step 1 (popIn) references missing cell 'ghost'");

    const good = JSON.stringify({ steps: [{ effect: "popIn", cells: ["a"] }] }).replaceAll('"', "&quot;");
    const native = JSON.stringify({ animation: { steps: [{ fadeIn: { cells: ["a"] } }] } }).replaceAll('"', "&quot;");
    const both = PAGE.replace(
      '<mxCell id="0"/>',
      `<UserObject label="" ${MOTION_ATTRIBUTE}="${good}" animation="${native}" id="0"><mxCell/></UserObject>`,
    );
    const result = validateXml(both);
    expect(result.errors).toContain(
      "page 'Flow': page has both stored motion and an enabled native page animation; keep only one timeline",
    );
    expect(result.observations.some((line) => line.includes("stored motion has 1 step(s)"))).toBe(true);
  });

  it("detects dark page backgrounds and picks the matching default accent", () => {
    expect(isDarkBackground("#0B1220")).toBe(true);
    expect(isDarkBackground("#FFFFFF")).toBe(false);
    expect(isDarkBackground(null)).toBe(false);
    const dark = model(PAGE.replace("<mxGraphModel ", '<mxGraphModel background="#0B1220" '));
    expect(themeAccent(dark)).toBe(DEFAULT_DARK_ACCENT);
    expect(themeAccent(model())).toBe(DEFAULT_ACCENT);
    const motion = compileMotion({ steps: [{ effect: "travel", cells: ["e"] }] }, motionCells(dark), themeAccent(dark));
    expect(motion.compiled!.dots[0].color).toBe(DEFAULT_DARK_ACCENT);
  });
});

describe("storyboard", () => {
  it("lays out one prefixed, shifted copy of the page per frame", () => {
    const motion = compile({
      steps: [
        { effect: "popIn", cells: ["a"] },
        { effect: "drawIn", cells: ["e"] },
        { effect: "highlight", cells: ["a"], color: "#ef4444" },
      ],
    }).compiled!;
    const xml = buildStoryboard(model(), motion.frames);
    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const cells = Array.from(doc.getElementsByTagName("mxCell"));
    const byId = new Map(cells.map((cell) => [cell.getAttribute("id"), cell]));

    expect(byId.has("f1-a")).toBe(true);
    expect(byId.has("f3-e")).toBe(true);
    expect(byId.get("f2-e")!.getAttribute("source")).toBe("f2-a");
    expect(byId.get("f1-e")!.getAttribute("style")).toContain("opacity=0;textOpacity=0;");
    expect(byId.get("f1-b")!.getAttribute("style")).toBeNull();
    expect(byId.get("f3-a")!.getAttribute("style")).toContain("strokeColor=#ef4444;strokeWidth=3;");
    expect(byId.get("f1-caption")!.getAttribute("value")).toBe("1 · 0.6s · popIn a");
    // Second frame sits one tile to the right: page width 400 + 80 gap, plus the 80 outer gap.
    const geometry = byId.get("f2-a")!.getElementsByTagName("mxGeometry")[0];
    expect(geometry.getAttribute("x")).toBe(String(80 + 480 + 40));
    const waypoint = byId.get("f2-e")!.getElementsByTagName("mxPoint")[0];
    expect(waypoint.getAttribute("x")).toBe(String(80 + 480 + 180));
  });

  it("samples long timelines down to the frame limit, keeping the ends", () => {
    const frames = Array.from({ length: 30 }, (_, index) => ({
      time: index,
      label: `step ${index}`,
      opacity: new Map<string, number>(),
      accent: new Map<string, string>(),
    }));
    const sampled = sampleFrames(frames);
    expect(sampled).toHaveLength(MAX_STORYBOARD_FRAMES);
    expect(sampled[0].label).toBe("step 0");
    expect(sampled.at(-1)!.label).toBe("step 29");
  });
});
