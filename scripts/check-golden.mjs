#!/usr/bin/env node
// Golden check: the bundled upstream assets (the vendored draw.io shape index and
// the authoring references DrawMe ships and reads) are immutable data. This
// computes a single SHA-256 over every file under assets/ (path + content) and
// compares it to the committed baseline, failing if a shipped asset drifted or
// was tampered with. Run `--update` after an intentional refresh. Local-only.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const GOLDEN_DIR = join(ROOT, "assets");
const BASELINE = join(ROOT, ".golden.sha256");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function computeHash() {
  if (!existsSync(GOLDEN_DIR)) {
    console.error(`error: golden assets not found at ${relative(ROOT, GOLDEN_DIR)}`);
    process.exit(2);
  }
  const files = walk(GOLDEN_DIR)
    .map((p) => relative(GOLDEN_DIR, p).split(sep).join("/"))
    .sort();
  const manifest = createHash("sha256");
  for (const rel of files) {
    manifest.update(rel);
    manifest.update("\0");
    manifest.update(createHash("sha256").update(readFileSync(join(GOLDEN_DIR, rel))).digest("hex"));
    manifest.update("\n");
  }
  return { hash: manifest.digest("hex"), count: files.length };
}

const { hash, count } = computeHash();

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE, hash + "\n");
  console.log(`golden baseline written (${count} files): ${hash}`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error("error: no golden baseline. Run `npm run check:golden -- --update` to create it.");
  process.exit(1);
}

const expected = readFileSync(BASELINE, "utf8").trim();
if (expected !== hash) {
  console.error(`golden check FAILED: bundled assets/ changed.\n  expected ${expected}\n  actual   ${hash}`);
  console.error("If this change was intentional, run `npm run check:golden -- --update`.");
  process.exit(1);
}
console.log(`golden check OK (${count} files): ${hash}`);
