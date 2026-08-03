#!/usr/bin/env node
// Format check: enforces LF line endings, no trailing whitespace, a single final
// newline, and valid JSON across the project's authored text files. Bundled
// upstream assets (assets/, example/) and generated files are excluded. Local-only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// Directories walked recursively for *.ts / *.mjs / *.js / *.md.
const SCAN_DIRS = ["src", "tests", "scripts"];
// Individual root files checked as-is.
const ROOT_FILES = [
  "package.json",
  "tsconfig.json",
  "eslint.config.js",
  "vitest.config.ts",
  "README.md",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
];
const SCAN_EXTS = new Set([".ts", ".mjs", ".js", ".md"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile() && SCAN_EXTS.has(extname(name))) out.push(p);
  }
  return out;
}

const files = [];
for (const d of SCAN_DIRS) {
  const abs = join(ROOT, d);
  try {
    if (statSync(abs).isDirectory()) files.push(...walk(abs));
  } catch {
    // directory absent — skip
  }
}
for (const f of ROOT_FILES) {
  const abs = join(ROOT, f);
  try {
    if (statSync(abs).isFile()) files.push(abs);
  } catch {
    // file absent — skip
  }
}

const issues = [];
for (const abs of files) {
  const rel = relative(ROOT, abs).split(sep).join("/");
  const text = readFileSync(abs, "utf8");
  if (text.includes("\r")) issues.push(`${rel}: contains CR (expected LF line endings)`);
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (/[ \t]$/.test(line)) issues.push(`${rel}:${i + 1}: trailing whitespace`);
  });
  if (text.length > 0 && !text.endsWith("\n")) issues.push(`${rel}: missing final newline`);
  if (text.endsWith("\n\n")) issues.push(`${rel}: multiple trailing blank lines`);
  if (extname(abs) === ".json") {
    try {
      JSON.parse(text);
    } catch (e) {
      issues.push(`${rel}: invalid JSON (${e.message})`);
    }
  }
}

if (issues.length) {
  console.error(`format:check FAILED (${issues.length} issue(s)):`);
  for (const i of issues) console.error(`  ${i}`);
  process.exit(1);
}
console.log(`format:check OK (${files.length} files)`);
