import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Permissions = Record<string, "read" | "write" | "none">;
type Step = { name: string; run?: string } & Record<string, unknown>;
type Job = {
  permissions?: Permissions;
  steps: Step[];
  needs?: string | string[];
  if?: string;
} & Record<string, unknown>;

const workflow = parse(readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8"), {
  version: "1.2",
}) as {
  on: unknown;
  permissions?: Permissions;
  env?: unknown;
  defaults?: unknown;
  jobs: { validate: Job; publish: Job };
};
const { validate, publish } = workflow.jobs;
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";
const DISPATCH_SHA = "${{ github.sha }}";
const PREFLIGHT_ENV = {
  DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
  CURRENT_REF: "${{ github.ref }}",
};

function behavior({ name: _name, ...step }: Step) {
  return step;
}

function effectivePermissions(job: Job) {
  // Job permissions replace workflow permissions; unspecified scopes are none.
  return job.permissions ?? workflow.permissions;
}

function checkPreflight(step: Step) {
  expect(behavior(step)).toEqual({ shell: "bash", env: PREFLIGHT_ENV, run: expect.any(String) });
  const script = step.run!.trim();
  // Run only a builtin-only comparison/echo/exit block; never execute arbitrary workflow code.
  const safePreflight = /^if \[ "\$[A-Z_]+" [!=]=? "[\w/$-]+" \]; then\n(?:[ \t]+echo "[\w /$'.:-]+"\n)+[ \t]+exit [01]\nfi$/;
  expect(script).toMatch(safePreflight);
  return script;
}

describe("npm release workflow policy", () => {
  it("permits manual dispatch only with the supported dist-tag choices and no default authority", () => {
    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          "dist-tag": {
            description: expect.any(String), required: true, default: "latest", type: "choice",
            options: ["latest", "next", "beta"],
          },
        },
      },
    });
    expect(workflow.permissions).toEqual({});
    expect(workflow.env).toBeUndefined();
    expect(workflow.defaults).toBeUndefined();
    expect(Object.keys(workflow.jobs).sort()).toEqual(["publish", "validate"]);
  });

  it("runs the case-sensitive preflight first and validates the dispatch SHA without release authority", () => {
    expect(effectivePermissions(validate)).toEqual({ contents: "read" });
    expect(validate).not.toHaveProperty("environment");
    expect(validate).not.toHaveProperty("if");
    expect(validate).not.toHaveProperty("continue-on-error");
    expect(validate).not.toHaveProperty("env");
    expect(validate).not.toHaveProperty("defaults");
    checkPreflight(validate.steps[0]);
    expect(validate.steps.slice(1).map(behavior)).toEqual([
      { uses: CHECKOUT, with: { ref: DISPATCH_SHA, "persist-credentials": false } },
      { uses: SETUP_NODE, with: { "node-version": "22.19.0", cache: "npm" } },
      { run: "npm ci --ignore-scripts" },
      { run: "npm run validate" },
    ]);
  });

  it.each([
    { scenario: "the exact default branch", ref: "refs/heads/release/stable", status: 0 },
    { scenario: "a tag with the default branch name", ref: "refs/tags/release/stable", status: 1 },
    { scenario: "another branch", ref: "refs/heads/main", status: 1 },
    { scenario: "a case-only variant", ref: "refs/heads/Release/stable", status: 1 },
  ])("preflight handles $scenario", ({ ref, status }) => {
    const script = checkPreflight(validate.steps[0]);
    const defaultBranch = "release/stable";
    // Git for Windows bash, not the Windows System32 WSL launcher.
    const gitBash = "C:/Program Files/Git/bin/bash.exe";
    const bash = process.platform === "win32" && existsSync(gitBash) ? gitBash : "/bin/bash";
    const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
      env: { DEFAULT_BRANCH: defaultBranch, CURRENT_REF: ref },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(status);
    if (status !== 0) {
      expect(result.stdout).toContain(`refs/heads/${defaultBranch}`);
      expect(result.stdout).toContain(ref);
    }
  }, 10_000);

  it("requires successful validation and the full default ref before using the npm environment", () => {
    expect(Array.isArray(publish.needs) ? publish.needs : [publish.needs]).toEqual(["validate"]);
    expect(publish.if).toBe(
      "${{ success() && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}",
    );
    expect(publish.environment).toBe("npm");
    expect(effectivePermissions(publish)).toEqual({ contents: "write", "id-token": "write" });
    expect(publish).not.toHaveProperty("env");
    expect(publish).not.toHaveProperty("defaults");
  });

  it("publishes the same SHA with pinned actions, no shared cache or lifecycle hooks, and tags after publishing", () => {
    const [checkout, setup, npm, metadata, novelty, release, tag] = publish.steps.map(behavior);
    expect(publish.steps).toHaveLength(7);
    expect(checkout).toEqual({ uses: CHECKOUT, with: { ref: DISPATCH_SHA } });
    expect(setup).toEqual({
      uses: SETUP_NODE,
      with: { "node-version": "22.19.0", "registry-url": "https://registry.npmjs.org", "package-manager-cache": false },
    });
    expect(npm).toEqual({ run: "npm install --global npm@11.18.0 --ignore-scripts" });
    expect(metadata).toEqual({ id: "package", run: expect.any(String) });
    expect(metadata.run).toMatch(/^node --input-type=module <<'NODE' >> "\$GITHUB_OUTPUT"\n[\s\S]+\nNODE\n?$/);
    expect(metadata.run).toContain('readFileSync("package.json", "utf8")');
    expect(novelty).toEqual({
      env: {
        PACKAGE_NAME: "${{ steps.package.outputs.package_name }}",
        PACKAGE_VERSION: "${{ steps.package.outputs.package_version }}",
        RELEASE_TAG: "${{ steps.package.outputs.release_tag }}",
      },
      run: expect.any(String),
    });
    expect(novelty.run).toContain('if npm view "$PACKAGE_NAME@$PACKAGE_VERSION" version');
    expect(novelty.run).toContain('if git ls-remote --exit-code --tags origin "refs/tags/$RELEASE_TAG"');
    expect(release).toEqual({
      env: { DIST_TAG: "${{ inputs['dist-tag'] }}" },
      run: 'npm publish --ignore-scripts --provenance --access public --tag "$DIST_TAG"',
    });
    expect(tag).toEqual({ env: { RELEASE_TAG: "${{ steps.package.outputs.release_tag }}" }, run: expect.any(String) });
    expect(tag.run).toContain('git tag --annotate "$RELEASE_TAG"');
    expect(tag.run).toContain('git push origin "refs/tags/$RELEASE_TAG"');
    for (const { run } of [metadata, novelty, tag]) {
      expect(run).not.toMatch(/\b(?:npm\s+(?:run(?:-script)?|test|t|ci|exec|install|publish)|npx|yarn|pnpm)\b/);
    }
  });
});
