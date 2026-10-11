import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import type { DomEl } from "../src/dom";
import { DEFAULT_DARK_ACCENT, analyzeStoredMotion, selectPage } from "../src/motion";
import { AUTOMATIC_CORRECTION_LIMIT } from "../src/workflow";

function example(name: string) {
  const xml = readFileSync(resolve("example", `${name}.drawio`), "utf8");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const cells = new Map(Array.from(doc.getElementsByTagName("mxCell")).map((cell) => [cell.getAttribute("id"), cell]));
  return {
    cells,
    label: (id: string) => cells.get(id)?.getAttribute("value") ?? "",
    model: selectPage(doc.documentElement as unknown as DomEl).model,
  };
}

describe("documentation examples", () => {
  it("keeps installation scopes and first-use commands accurate", () => {
    const { label } = example("drawme-installation-guide");
    expect(label("runtime")).toContain("22.19");
    expect(label("runtime")).toContain("/login, then /model");
    expect(label("desktop")).toContain("brew install --cask drawio");
    expect(label("personal")).toContain("pi install npm:@senad-d/drawme");
    expect(label("personal")).toContain("~/.pi/agent/settings.json");
    expect(label("project")).toContain("pi install npm:@senad-d/drawme -l");
    expect(label("project")).toContain(".pi/settings.json; loads after trust");
    expect(label("trial")).toContain("pi -e npm:@senad-d/drawme");
    expect(label("trial")).toContain("Starts Pi; does not change settings");
    expect(label("load-note")).toContain("/reload");
    expect(label("verify")).toContain("Reports the detected path + version");
    expect(label("describe")).toContain("/drawme a login flow with retry");
    expect(label("compatibility")).toContain("older versions still render and export");
  });

  it("keeps the user flow, fallbacks, correction cap and cleanup in sync", () => {
    const { cells, label } = example("drawme-how-it-works");
    const edge = (id: string) => [cells.get(id)?.getAttribute("source"), cells.get(id)?.getAttribute("target")];
    expect(edge("e-author-validate")).toEqual(["author", "validate"]);
    expect(edge("e-validate-review")).toEqual(["validate", "review"]);
    expect(edge("e-review-correct")).toEqual(["review", "correct"]);
    expect(edge("e-correct-validate")).toEqual(["correct", "validate"]);
    expect(edge("e-review-export")).toEqual(["review", "export"]);
    expect(label("e-review-correct")).toContain(`retries < ${AUTOMATIC_CORRECTION_LIMIT}`);
    expect(label("review")).toContain("Fit → placement → connections");
    expect(label("review")).toContain("Holistic typography + semantics");
    expect(label("vision")).toContain("Report rendered review as skipped");
    expect(label("missing-cli")).toContain("Still author + validate XML");
    expect(label("limit")).toContain("report unresolved findings");
    expect(label("cleanup")).toContain("Final export removes the latest preview");
    expect(label("motion")).toContain("Verified standalone animated SVG");
    expect(label("subtitle")).toContain("no approval pauses");
  });

  it("keeps the requested Light, Dark and Multi-color showcase themes explicit", () => {
    const install = example("drawme-installation-guide");
    const flow = example("drawme-how-it-works");
    const orders = example("event-driven-orders");
    expect(install.model.getAttribute("background")).toBe("#FFFFFF");
    expect(flow.model.getAttribute("background")).toBe("#FFFFFF");
    expect(orders.model.getAttribute("background")).toBe("#0B1220");
    for (const [id, color] of [["author", "#3B82F6"], ["review", "#8B5CF6"], ["export", "#10B981"]]) {
      expect(flow.cells.get(id)?.getAttribute("style")).toContain(`strokeColor=${color}`);
    }
    expect(flow.label("legend-prep")).toBe("Authoring");
    expect(flow.label("legend-quality")).toBe("Quality");
    expect(flow.label("legend-delivery")).toBe("Delivery");
    const motion = analyzeStoredMotion(orders.model)?.compiled;
    expect(motion?.dots.length).toBeGreaterThan(0);
    expect(motion?.dots.every((dot) => dot.color === DEFAULT_DARK_ACCENT)).toBe(true);
  });

  it("models AWS subscriptions, queue consumers and SQS redrive accurately", () => {
    const { cells, label } = example("event-driven-orders");
    const edge = (id: string) => [cells.get(id)?.getAttribute("source"), cells.get(id)?.getAttribute("target")];
    expect(edge("e-invoke")).toEqual(["gateway", "api"]);
    expect(edge("e-consume")).toEqual(["events", "fulfill-queue"]);
    expect(edge("e-work")).toEqual(["fulfill-queue", "worker"]);
    expect(edge("e-notify")).toEqual(["events", "notify-queue"]);
    expect(edge("e-notify-work")).toEqual(["notify-queue", "notifications"]);
    expect(edge("e-deadletter")).toEqual(["fulfill-queue", "dlq"]);
    expect(label("e-deadletter")).toBe("maxReceiveCount");
    expect(label("delivery")).toContain("filters outbox records");
    expect(label("delivery")).toContain("at least once");
    for (const id of ["gateway", "api", "outbox", "relay", "events", "fulfill-queue", "worker", "shipments", "notify-queue", "notifications", "email", "dlq"]) {
      expect(cells.get(id)?.getAttribute("style"), id).toContain("shape=mxgraph.aws4.resourceIcon");
    }
  });

  it("reveals order components before their connectors and finishes with everything visible", () => {
    const { cells, model } = example("event-driven-orders");
    const analysis = analyzeStoredMotion(model);
    expect(analysis?.errors).toEqual([]);
    expect(analysis?.spec?.steps).toHaveLength(12);
    const motion = analysis?.compiled;
    expect(motion).toBeTruthy();
    if (!motion) throw new Error("Order example must have valid stored motion");
    expect(motion.loop).toBe(true);
    expect(motion.durationMs).toBeLessThan(15_000);
    for (const frame of motion.frames) {
      for (const id of motion.targetCellIds) {
        const cell = cells.get(id);
        if (cell?.getAttribute("edge") !== "1" || frame.opacity.get(id) !== 1) continue;
        for (const endpoint of ["source", "target"]) {
          expect(frame.opacity.get(cell.getAttribute(endpoint) ?? "") ?? 1, `${frame.label}: ${id} ${endpoint}`).toBe(1);
        }
      }
    }
    const finalFrame = motion.frames.at(-1);
    for (const id of motion.targetCellIds) expect(finalFrame?.opacity.get(id)).toBe(1);
  });

  it("ships standalone SVG motion matching the stored source, with a reduced-motion fallback", () => {
    const { model } = example("event-driven-orders");
    const motion = analyzeStoredMotion(model)?.compiled;
    if (!motion) throw new Error("Order example must have valid stored motion");
    const svg = readFileSync(resolve("example", "event-driven-orders.animated.svg"), "utf8");
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const styles = Array.from(doc.getElementsByTagName("style")).map((style) => style.textContent).join("\n");
    expect(styles).toContain(motion.css);
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(doc.getElementsByTagName("animateMotion")).toHaveLength(motion.dots.length);
    const renderedCells = new Set(Array.from(doc.getElementsByTagName("g")).map((group) => group.getAttribute("data-cell-id")));
    for (const id of motion.targetCellIds) expect(renderedCells.has(id), id).toBe(true);
    expect(doc.documentElement?.getAttribute("content")).toContain("<mxfile");
    expect(doc.documentElement?.getAttribute("style")).toContain("background: #0B1220");
  });
});
