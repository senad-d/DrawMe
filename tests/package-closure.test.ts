import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../package.json";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = "src/pack-fixture.ts";
const runtimeModule = "src/pack-fixture-runtime.ts";
const typeModule = "src/pack-fixture-types.ts";
const npmTimeoutMs = 10_000;
// The longest case runs three npm commands sequentially; leave time for fixture writes and assertions.
const packTestTimeoutMs = 3 * npmTimeoutMs + 5_000;

function runNpm(dir: string, command: "run check:pack" | "pack --dry-run --json") {
  // A fixed command works with npm.cmd on Windows, without interpolating any paths or fixture data.
  const result = spawnSync(`npm --offline --ignore-scripts ${command}`, {
    cwd: dir, shell: true, encoding: "utf8", timeout: npmTimeoutMs,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}\n${result.stderr}` };
}

function checkPack(dir: string, excluded: string[] = [], extraEntries: string[] = []) {
  const fixtureManifest = {
    ...manifest,
    files: [...manifest.files, ...excluded.map((file) => `!${file}`)],
    pi: { ...manifest.pi, extensions: [...manifest.pi.extensions, ...extraEntries] },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(fixtureManifest));
  for (const file of excluded) expect(existsSync(join(dir, file)), `${file} still exists in the source tree`).toBe(true);

  return runNpm(dir, "run check:pack");
}

function expectMissing(result: ReturnType<typeof checkPack>, file: string) {
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain("check:pack FAILED (1 issue(s)):");
  expect(result.output).toContain(`required package file is missing: ${file}`);
}

describe("packed extension runtime closure", { timeout: packTestTimeoutMs }, () => {
  let dir: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "drawme pack closure-"));
    for (const path of ["src", "assets", "docs", "example", "README.md", "CHANGELOG.md", "LICENSE", "SECURITY.md", "tsconfig.json"]) {
      cpSync(join(root, path), join(dir, path), { recursive: true });
    }
    mkdirSync(join(dir, "scripts"));
    for (const script of ["check-package-contents.mjs", "package-closure.mjs"]) {
      cpSync(join(root, "scripts", script), join(dir, "scripts", script));
    }
    // Resolve the installed compiler without another install or touching the checkout's sources.
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "junction");
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts the normal package using the real npm dry-run manifest", () => {
    const result = checkPack(dir!);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("check:pack OK");
  });

  it.each([
    "src/animate.ts",
    "src/animation.ts",
    "src/motion.ts",
    "src/storyboard.ts",
    "src/svgexport.ts",
  ])("rejects a pack-list-only omission of %s", (file) => {
    expectMissing(checkPack(dir!, [file]), file);
  });

  it("scans additional declared entries without evaluating them or requiring their type-only files", () => {
    writeFileSync(join(dir!, entry), `
      import type { Shape } from "./pack-fixture-types";
      export type { Shape };
      export const load = () => import("./pack-fixture-bridge");
      throw new Error("The pack gate must not evaluate extension code");
    `);
    writeFileSync(join(dir!, "src/pack-fixture-bridge.ts"), 'export { load } from "./pack-fixture-runtime";\n');
    writeFileSync(join(dir!, runtimeModule), 'export { load } from "./pack-fixture";\n');
    writeFileSync(join(dir!, typeModule), "export type Shape = { id: string };\n");

    const result = checkPack(dir!, [typeModule], [`./${entry}`]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("check:pack OK");
    const pack = runNpm(dir!, "pack --dry-run --json");
    expect(pack.status, pack.output).toBe(0);
    const [listing] = JSON.parse(pack.stdout) as { files: { path: string }[] }[];
    expect(listing.files.map(({ path }) => path)).not.toContain(typeModule);
    expectMissing(checkPack(dir!, [typeModule, runtimeModule], [`./${entry}`]), runtimeModule);
  });
});
