import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../package.json";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureRoots = ["src", "assets", "docs", "LICENSE", "README.md", "CHANGELOG.md", "SECURITY.md", "tsconfig.json"];
const entries = [...manifest.pi.extensions, "./src/extension-only.ts"];
const typeOnlyFiles = ["src/closure-fixture/private-import.ts", "src/closure-fixture/private-export.ts"];
const npmTimeoutMs = 15_000;
const checkerTimeoutMs = 20_000;
const testTimeoutMs = 30_000;
const extraEntry = `
import { format, type Options } from "./closure-fixture";
import type { PrivateImport } from "./closure-fixture/private-import";
import { type InlineImport } from "./closure-fixture/inline-import";
export type { PrivateExport } from "./closure-fixture/private-export";
export { type InlineExport } from "./closure-fixture/inline-export";
export { published } from "./closure-fixture/reexport.js";
export const text = format({ name: "mixed type and value" } satisfies Options);
export type Receipt = PrivateImport & InlineImport;
export const load = () => import("./closure-fixture/lazy");
`;
const fixtureSources: Record<string, string> = {
  "src/extension-only.ts": extraEntry,
  "src/closure-fixture/index.ts": `
import { prefix } from "./nested/helper.js";
export type Options = { name: string };
export const format = ({ name }: Options) => prefix + name;
`,
  "src/closure-fixture/nested/helper.ts": 'export const prefix = "Hello ";',
  "src/closure-fixture/reexport.ts": "export const published = true;",
  // The dynamic module leads back to its importer, exercising closure traversal on a cycle.
  "src/closure-fixture/lazy.ts": 'export { text as lazy } from "../extension-only";',
  "src/closure-fixture/private-import.ts": "export type PrivateImport = { imported: true };",
  "src/closure-fixture/private-export.ts": "export type PrivateExport = { exported: true };",
  "src/closure-fixture/inline-import.ts": "export type InlineImport = { inline: true };",
  "src/closure-fixture/inline-export.ts": "export type InlineExport = { inline: true };",
};

describe("packed Pi runtime closure", { concurrent: false }, () => {
  let fixture: string | undefined;
  let files: string[];

  beforeAll(async () => {
    const npmCli = process.env.npm_execpath;
    if (!npmCli || !isAbsolute(npmCli) || !/\.[cm]?js$/i.test(npmCli)) {
      throw new Error("Run these tests through npm test to provide the installed npm CLI JavaScript path.");
    }
    fixture = await mkdtemp(join(tmpdir(), "drawme pack closure "));
    const dir = fixture;
    for (const name of fixtureRoots) await cp(join(root, name), join(dir, name), { recursive: true });
    await mkdir(join(dir, "example"));
    for (const name of await readdir(join(root, "example"))) {
      if (name.endsWith(".drawio")) await cp(join(root, "example", name), join(dir, "example", name));
    }
    for (const [path, source] of Object.entries(fixtureSources)) {
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    files = (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(({ name, parentPath }) => relative(dir, join(parentPath, name)).split(sep).join("/"))
      .filter((path) => !typeOnlyFiles.includes(path))
      .sort();

    await mkdir(join(dir, "scripts"));
    await mkdir(join(dir, "node_modules"));
    for (const name of ["check-package-contents.mjs", "pack-closure.mjs"]) {
      await cp(join(root, "scripts", name), join(dir, "scripts", name));
    }
    const typescript = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
    await symlink(typescript, join(dir, "node_modules", "typescript"), "junction");
    // Forward the real CLI's output unchanged. Allow only a script-free dry run, add an explicit
    // offline flag, and bound npm itself so timing out the checker cannot leave a live npm child.
    const launcher = `
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] !== "pack" || args.slice(1).sort().join(" ") !== "--dry-run --ignore-scripts --json") {
  throw new Error("Expected npm pack --dry-run --json --ignore-scripts");
}
execFileSync(process.execPath, [${JSON.stringify(npmCli)}, "--offline", ...args], {
  stdio: "inherit", timeout: ${npmTimeoutMs}, killSignal: "SIGKILL",
});
`;
    await writeFile(join(dir, "scripts", "npm-dry-run.mjs"), launcher);
  }, testTimeoutMs);

  afterAll(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
  });

  async function checkPack(allowlist = files, extraManifest: Partial<typeof manifest> = {}) {
    const dir = fixture!;
    await writeFile(join(dir, "package.json"), JSON.stringify({
      ...manifest, pi: { ...manifest.pi, extensions: entries }, files: allowlist, ...extraManifest,
    }));
    const result = spawnSync(process.execPath, [join(dir, "scripts", "check-package-contents.mjs")], {
      cwd: dir,
      env: {
        ...process.env,
        npm_config_offline: "true",
        npm_config_cache: join(dir, "npm-cache"),
        npm_execpath: join(dir, "scripts", "npm-dry-run.mjs"),
      },
      encoding: "utf8",
      timeout: checkerTimeoutMs,
      killSignal: "SIGKILL",
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, output: result.stdout + result.stderr };
  }

  it("accepts the complete runtime graph even though explicit import type and export type targets are not shipped", async () => {
    for (const path of typeOnlyFiles) await expect(readFile(join(fixture!, path), "utf8")).resolves.toContain("export type");
    const { status, output } = await checkPack();
    expect(status, output).toBe(0);
    expect(output).toMatch(/check:pack OK \(\d+ files\)/);
  }, testTimeoutMs);

  it.each([
    ["the animation entry import", "src/animate.ts"],
    ["the motion module", "src/motion.ts"],
    ["the transitive storyboard module", "src/storyboard.ts"],
    ["the transitive SVG exporter", "src/svgexport.ts"],
    ["another declared Pi entry point", "src/extension-only.ts"],
    ["a mixed type/value import resolving to a directory index", "src/closure-fixture/index.ts"],
    ["a nested import resolving a .js specifier to a .ts file", "src/closure-fixture/nested/helper.ts"],
    ["a re-export", "src/closure-fixture/reexport.ts"],
    ["a literal dynamic import", "src/closure-fixture/lazy.ts"],
    ["an inline-only type import (retained as an empty import)", "src/closure-fixture/inline-import.ts"],
    ["an inline-only type re-export (retained as an empty export)", "src/closure-fixture/inline-export.ts"],
  ])("rejects omission of %s from the pack, not the checkout", async (_scenario, missing) => {
    expect(files).toContain(missing);
    await expect(readFile(join(fixture!, missing), "utf8")).resolves.not.toBe("");
    const { status, output } = await checkPack(files.filter((path) => path !== missing));
    expect(status, output).toBe(1);
    expect(output).toContain("check:pack FAILED (1 issue(s))");
    expect(output).toContain(`runtime package file is missing: ${missing}`);
  }, testTimeoutMs);

  it("names the importing file and unresolved relative runtime specifier", async () => {
    const entry = join(fixture!, "src", "extension-only.ts");
    try {
      await writeFile(entry, `${extraEntry}\nimport "./closure-fixture/not-found";\n`);
      const { status, output } = await checkPack();
      expect(status, output).toBe(1);
      expect(output).toContain('cannot resolve runtime import "./closure-fixture/not-found" from src/extension-only.ts');
    } finally {
      await writeFile(entry, extraEntry);
    }
  }, testTimeoutMs);

  it("still rejects missing package metadata and required docs, and checks the forbidden pack paths", async () => {
    const dir = fixture!;
    await mkdir(join(dir, "tests"));
    await writeFile(join(dir, "tests", "unpublished.txt"), "not part of a release\n");
    const { status, output } = await checkPack(
      [...files.filter((path) => path !== "docs/reference.md"), "tests/unpublished.txt"],
      { keywords: [] },
    );
    expect(status, output).toBe(1);
    expect(output).toContain("package.json keywords must include pi-package");
    expect(output).toContain("required package file is missing: docs/reference.md");
    expect(output).toContain("forbidden package file is present: tests/unpublished.txt");
  }, testTimeoutMs);
});
