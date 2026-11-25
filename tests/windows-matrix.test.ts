import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  shell?: string;
  if?: string;
  "continue-on-error"?: boolean | string;
};

type Defaults = { run?: { shell?: string } };
const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")) as {
  on: { push?: { branches?: string[] }; pull_request?: unknown };
  permissions?: Record<string, string>;
  defaults?: Defaults;
  jobs: {
    validate: {
      name: string;
      "runs-on": string;
      strategy: { matrix: { os?: string[]; node?: string[]; include?: unknown; exclude?: unknown } };
      permissions?: Record<string, string>;
      defaults?: Defaults;
      steps: Step[];
      if?: string;
      container?: unknown;
      "continue-on-error"?: boolean | string;
    };
  };
};
const { validate } = workflow.jobs;

describe("portable CI gate (offline workflow policy)", () => {
  it("schedules native Windows and Linux validation for pushes to main and pull requests", () => {
    expect(workflow.on.push?.branches).toContain("main");
    expect(workflow.on).toHaveProperty("pull_request", null);
    expect(validate.if).toBeUndefined();
    expect(validate.container).toBeUndefined();
    expect(validate["runs-on"]).toBe("${{ matrix.os }}");
    expect(validate.name).toContain("${{ matrix.os }}");
    const { os, node, include, exclude } = validate.strategy.matrix;
    expect(os).toEqual(expect.arrayContaining(["ubuntu-latest", "windows-latest"]));
    expect(node?.length).toBeGreaterThan(0);
    // Both OSes get the same Node versions; no exceptions override or remove a required leg.
    expect(include ?? []).toEqual([]);
    expect(exclude ?? []).toEqual([]);
  });

  it("requires a read-only locked install followed by the full validation gate on every leg", () => {
    expect(validate.permissions ?? workflow.permissions).toEqual({ contents: "read" });
    expect([undefined, false]).toContain(validate["continue-on-error"]);
    const required = (label: string, matches: (step: Step) => boolean) => {
      const steps = validate.steps.filter(matches);
      expect(steps, label).toHaveLength(1);
      const [step] = steps;
      expect(step.if, `${label} runs on both OSes`).toBeUndefined();
      expect([undefined, false], `${label} must not swallow errors`).toContain(step["continue-on-error"]);
      return step;
    };
    const checkout = required("checkout", (step) => step.uses?.startsWith("actions/checkout@") ?? false);
    const setup = required("Node setup", (step) => step.uses?.startsWith("actions/setup-node@") ?? false);
    expect(setup.with?.["node-version"]).toBe("${{ matrix.node }}");
    const install = required("locked install", (step) => step.run?.trim() === "npm ci --ignore-scripts");
    const gate = required("full local validation", (step) => step.run?.trim() === "npm run validate");
    const positions = [checkout, setup, install, gate].map((step) => validate.steps.indexOf(step));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    for (const step of [install, gate]) {
      // Use Actions' native default shell, not a Linux-only shell or a WSL wrapper on Windows.
      expect(step.shell ?? validate.defaults?.run?.shell ?? workflow.defaults?.run?.shell).toBeUndefined();
    }
  });
});
