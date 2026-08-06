#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const issues = [];

if (packageJson.private === true) {
  issues.push("package.json must not set private to true");
}
if (!packageJson.keywords?.includes("pi-package")) {
  issues.push("package.json keywords must include pi-package");
}
if (!packageJson.pi?.extensions?.includes("./src/index.ts")) {
  issues.push("package.json pi.extensions must include ./src/index.ts");
}
if (typeof packageJson.pi?.image !== "string" || packageJson.pi.image.length === 0) {
  issues.push("package.json pi.image must provide gallery preview media");
}

const packArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
const npmExecPath = process.env.npm_execpath;
let output;
try {
  output = npmExecPath
    ? execFileSync(process.execPath, [npmExecPath, ...packArgs], {
        cwd: ROOT,
        encoding: "utf8",
      })
    : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", packArgs, {
        cwd: ROOT,
        encoding: "utf8",
      });
} catch (error) {
  console.error("check:pack FAILED: npm pack --dry-run did not complete");
  if (error instanceof Error) console.error(error.message);
  process.exit(1);
}

let packResult;
try {
  const parsed = JSON.parse(output);
  packResult = Array.isArray(parsed) ? parsed[0] : undefined;
} catch {
  issues.push("npm pack --dry-run did not return valid JSON");
}

const packedFiles = new Set(packResult?.files?.map((file) => file.path) ?? []);
const requiredFiles = [
  "package.json",
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CHANGELOG.md",
  "tsconfig.json",
  "docs/reference.md",
  "assets/data/SHAPE-INDEX-NOTICE.md",
  "assets/data/shape-index.json.gz",
  "assets/references/diagram-types.md",
  "assets/references/mermaid-authoring.md",
  "assets/references/troubleshooting.md",
  "assets/references/xml-authoring.md",
  "example/drawme-how-it-works.drawio",
  "example/drawme-installation-guide.drawio",
  "example/git-graph-example.drawio",
  "src/dom.ts",
  "src/drawio.ts",
  "src/explain.ts",
  "src/fitcanvas.ts",
  "src/geometry.ts",
  "src/index.ts",
  "src/png.ts",
  "src/shapesearch.ts",
  "src/validate.ts",
  "src/workflow.ts",
];

for (const file of requiredFiles) {
  if (!packedFiles.has(file)) issues.push(`required package file is missing: ${file}`);
}

const forbiddenPaths = [".env", ".github/", ".pi/", "coverage/", "node_modules/", "tests/"];
for (const file of packedFiles) {
  if (forbiddenPaths.some((path) => file === path || file.startsWith(path))) {
    issues.push(`forbidden package file is present: ${file}`);
  }
}

if (issues.length > 0) {
  console.error(`check:pack FAILED (${issues.length} issue(s)):`);
  for (const issue of issues) console.error(`  ${issue}`);
  process.exit(1);
}

console.log(`check:pack OK (${packedFiles.size} files)`);
