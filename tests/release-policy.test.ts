import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
};

type Job = {
  if?: string;
  needs?: string | string[];
  environment?: string;
  permissions?: Record<string, string>;
  "continue-on-error"?: boolean;
  steps: Step[];
};

const source = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
const workflow = parse(source) as {
  on: { workflow_dispatch: { inputs: { "dist-tag": { type: string; options: string[] } } } };
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: { validate: Job; publish: Job };
};
const { validate, publish } = workflow.jobs;

function requiredStep(job: Job, description: string, matches: (step: Step) => boolean) {
  const matching = job.steps.filter(matches);
  expect(matching, description).toHaveLength(1);
  const [step] = matching;
  expect(step.if, `${description} must not be bypassed by a step condition`).toBeUndefined();
  expect(step["continue-on-error"], `${description} must not swallow errors`).not.toBe(true);
  return step;
}

// Recognize just the policy's equality/format expression, not arbitrary Actions expressions.
function acceptsRef(condition: string | undefined, ref: string, defaultBranch: string) {
  const expression = condition?.replace(/^\$\{\{\s*(.*?)\s*\}\}$/, "$1") ?? "";
  const format = /^github\.ref\s*==\s*format\('([^']+)',\s*github\.event\.repository\.default_branch\)$/.exec(expression);
  expect(format, `expected a full-ref comparison with no status-check override: ${expression}`).not.toBeNull();
  // Actions expression string comparisons ignore case. The validation step below closes that gap.
  return ref.toLowerCase() === format![1].replace("{0}", defaultBranch).toLowerCase();
}

describe("offline release policy", () => {
  it("allows only manual dispatch and gates both jobs on the full default-branch ref", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const defaultBranch = "release/Stable";
    const cases = [
      ["refs/heads/release/Stable", true],
      ["refs/tags/release/Stable", false],
      ["refs/heads/main", false],
      ["refs/pull/46/merge", false],
    ] as const;
    for (const [name, job] of Object.entries({ validate, publish })) {
      for (const [ref, eligible] of cases) {
        expect(acceptsRef(job?.if, ref, defaultBranch), `${name}: ${ref}`).toBe(eligible);
      }
    }
  });

  it("rejects a case-only ref mismatch before checkout and requires validation to succeed", () => {
    const defaultBranch = "release/Stable";
    expect(acceptsRef(validate.if, "refs/heads/release/stable", defaultBranch)).toBe(true);
    const guard = requiredStep(validate, "exact ref check", (step) => step.env?.CURRENT_REF !== undefined);
    expect(validate.steps[0]).toBe(guard);
    expect(guard.env).toMatchObject({
      CURRENT_REF: "${{ github.ref }}",
      DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
    });
    expect(guard.run?.trim()).toMatch(/^if \[ "\$CURRENT_REF" != "refs\/heads\/\$DEFAULT_BRANCH" \]; then\n[^\n]*\n\s*exit 1\nfi$/);
    expect(validate["continue-on-error"]).not.toBe(true);
    expect([publish.needs].flat()).toEqual(["validate"]);
    // The equality-only job condition above leaves Actions' implicit success() check in force.
  });

  it("validates the dispatch SHA without release credentials and publishes that same SHA", () => {
    expect(workflow.permissions).toEqual({});
    expect(validate.permissions).toEqual({ contents: "read" });
    expect(validate).not.toHaveProperty("environment");
    expect(publish.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(publish.environment).toBe("npm");
    expect(source).toMatch(/# deployment branches and tags to the default branch only, with no tag rules\./);

    const checkout = (job: Job) => requiredStep(job, "checkout", (step) => step.uses?.startsWith("actions/checkout@") ?? false);
    const validationCheckout = checkout(validate);
    const publishingCheckout = checkout(publish);
    expect(validationCheckout.with).toMatchObject({ ref: "${{ github.sha }}", "persist-credentials": false });
    expect(publishingCheckout.with?.ref).toBe(validationCheckout.with?.ref);

    const install = requiredStep(validate, "locked install", (step) => step.run?.trim() === "npm ci --ignore-scripts");
    const gate = requiredStep(validate, "package validation", (step) => step.run?.trim() === "npm run validate");
    expect(validate.steps.indexOf(validationCheckout)).toBeLessThan(validate.steps.indexOf(install));
    expect(validate.steps.indexOf(install)).toBeLessThan(validate.steps.indexOf(gate));
    const privilegedCommands = publish.steps.map((step) => step.run).join("\n");
    expect(privilegedCommands).not.toMatch(/\bnpm\s+(?:ci|run(?:-script)?|test|exec)\b/);
  });

  it("uses only reviewed immutable actions and serializes releases", () => {
    const reviewed = [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ];
    for (const job of [validate, publish]) {
      expect(job.steps.flatMap((step) => step.uses ?? [])).toEqual(reviewed);
    }
    expect(workflow.concurrency).toEqual({ group: "publish-npm", "cancel-in-progress": false });
  });

  it("checks release metadata and uniqueness before publishing, then tags the validated SHA", () => {
    expect(workflow.on.workflow_dispatch.inputs["dist-tag"]).toMatchObject({
      type: "choice", options: ["latest", "next", "beta"],
    });
    const metadata = requiredStep(publish, "read package metadata", (step) => step.id === "package");
    const uniqueness = requiredStep(publish, "release uniqueness", (step) => step.run?.includes("npm view") ?? false);
    const upload = requiredStep(publish, "npm publish", (step) => step.run?.includes("npm publish") ?? false);
    const tag = requiredStep(publish, "push release tag", (step) => step.run?.includes("git push") ?? false);
    const positions = [
      publish.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@")),
      ...[metadata, uniqueness, upload, tag].map((step) => publish.steps.indexOf(step)),
    ];
    expect(positions[0]).toBeGreaterThanOrEqual(0);
    expect(positions.slice(1).every((index, i) => index > positions[i])).toBe(true);

    expect(metadata.run).toMatch(/^if \(!packageNameRe\.test\(pkg\.name\)\) \{\n[^\n]*\n\s*process\.exit\(1\);\n\}/m);
    expect(metadata.run).toMatch(/^if \(!semverRe\.test\(pkg\.version\)\) \{\n[^\n]*\n\s*process\.exit\(1\);\n\}/m);
    expect(uniqueness.env).toMatchObject({
      PACKAGE_NAME: "${{ steps.package.outputs.package_name }}",
      PACKAGE_VERSION: "${{ steps.package.outputs.package_version }}",
      RELEASE_TAG: "${{ steps.package.outputs.release_tag }}",
    });
    expect(uniqueness.run).toMatch(/if npm view "\$PACKAGE_NAME@\$PACKAGE_VERSION" version [^\n]+; then\n[^\n]*\n\s*exit 1/);
    expect(uniqueness.run).toMatch(/if git ls-remote --exit-code --tags origin "refs\/tags\/\$RELEASE_TAG" [^\n]+; then\n[^\n]*\n\s*exit 1/);
    expect(upload.env?.DIST_TAG).toBe("${{ inputs['dist-tag'] }}");
    expect(upload.run).toMatch(/case "\$DIST_TAG" in\n\s*latest\|next\|beta\) ;;\n\s*\*\)[^\n]*exit 1[^\n]*\nesac/);
    expect(upload.run).toContain('npm publish --provenance --access public --tag "$DIST_TAG" --ignore-scripts');
    expect(tag.env?.RELEASE_TAG).toBe("${{ steps.package.outputs.release_tag }}");
    expect(tag.run).toMatch(/^git tag --annotate "\$RELEASE_TAG" .+ "\$GITHUB_SHA"$/m);
    expect(tag.run).toContain('git push origin "refs/tags/$RELEASE_TAG"');
  });
});
