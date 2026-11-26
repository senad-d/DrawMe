import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lexer, walkTokens } from "marked"; // The Markdown lexer shipped via Pi's locked TUI dependency.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../package.json";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const fileExists = (path: string) => statSync(join(root, path), { throwIfNoEntry: false })?.isFile() === true;
const normalizeRepo = (url: string) => url.replace(/^git\+/, "").replace(/\.git$/, "");
const repository = new URL(normalizeRepo(manifest.repository.url));
const packageBase = new URL("https://installed-drawme.invalid/");
const piDist = new URL(".", import.meta.resolve("@earendil-works/pi-coding-agent"));
// This is the same parser called by the installed DefaultPackageManager, without running an install.
const { parseGitUrl } = await import(new URL("utils/git.js", piDist).href) as {
  parseGitUrl(source: string): { repo: string } | null;
};

const packArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
const npmTimeoutMs = 15_000;
const checkerTimeoutMs = 20_000;
const testTimeoutMs = 30_000;
let npmCli: string;
let packedPaths: Set<string>;

beforeAll(() => {
  const cli = process.env.npm_execpath;
  if (!cli || !isAbsolute(cli) || !/\.[cm]?js$/i.test(cli)) {
    throw new Error("Run through npm test to locate the installed npm CLI on every platform.");
  }
  npmCli = cli;
  const result = spawnSync(process.execPath, [npmCli, "--offline", ...packArgs], {
    cwd: root, encoding: "utf8", timeout: npmTimeoutMs, killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const inventory = JSON.parse(result.stdout) as [{ files: { path: string }[] }];
  packedPaths = new Set(inventory[0].files.map(({ path }) => path));
}, testTimeoutMs);

function targets(doc: string): string[] {
  const links: string[] = [];
  walkTokens(lexer(doc), (token) => {
    if (token.type === "link" || token.type === "image") links.push(token.href);
    if (token.type !== "html") return;
    // Marked leaves raw HTML as text. Extract from open tags only; tokenize complete
    // attributes so that e.g. a title containing `src=...` is not treated as a URL.
    const html = token.raw.replace(/<!--[\s\S]*?-->/g, "");
    for (const [tag] of html.matchAll(/<[a-z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
      for (const [, name, double, single, bare] of tag.matchAll(/\s+([^\s="'<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
        const value = double ?? single ?? bare;
        if (/^(?:href|src)$/i.test(name) && value !== undefined) links.push(value);
      }
    }
  });
  return links;
}

function brokenLinks(page: string, doc: string, shipped: ReadonlySet<string>): string[] {
  return targets(doc).flatMap((target) => {
    const url = new URL(target, new URL(page, packageBase));
    if (url.origin === packageBase.origin) {
      return shipped.has(decodeURIComponent(url.pathname.slice(1))) ? [] : [`${page}: ${target} is not in the npm package`];
    }
    if (!url.pathname.startsWith(`${repository.pathname}/`)) return [];
    const tail = url.pathname.slice(repository.pathname.length + 1);
    let repoFile: string | undefined;
    if (url.hostname === "raw.githubusercontent.com") {
      repoFile = tail.match(/^[^/]+\/(.+)$/)?.[1];
    } else if (url.origin === repository.origin) {
      const workflow = tail.match(/^actions\/workflows\/(.+?)(?:\/badge\.svg)?$/)?.[1];
      repoFile = workflow ? `.github/workflows/${workflow}` : tail.match(/^(?:blob|raw)\/[^/]+\/(.+)$/)?.[1];
    } else {
      return [];
    }
    const path = repoFile && decodeURIComponent(repoFile);
    return path && !path.split(/[\\/]/).some((part) => part === "..") && fileExists(path)
      ? [] : [`${page}: ${target} has no local repository file`];
  });
}

function section(doc: string, heading: string): string {
  const lines = doc.split("\n");
  const start = lines.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const sameOrHigher = new RegExp(`^#{1,${heading.indexOf(" ")}} `);
  const end = lines.findIndex((line, index) => index > start && sameOrHigher.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

function installRepo(doc: string): string | undefined {
  const source = doc.match(/`pi install (git:[^`\s]+)`/)?.[1];
  return source ? parseGitUrl(source)?.repo : undefined;
}

describe("installed guidance", () => {
  it("gives Pi a Git source whose actual clone URL is the canonical repository", () => {
    const repo = installRepo(section(read("README.md"), "## Installation"));
    expect(repo, "README Git installation command must parse with the installed Pi").toBeDefined();
    expect(normalizeRepo(repo!)).toBe(repository.href);
    // A GitHub URL is not enough: the parsed clone destination must name the right repository.
    const wrongRepo = installRepo("`pi install git:https://github.com/example/DrawMe.git`");
    expect(wrongRepo).toBeDefined();
    expect(normalizeRepo(wrongRepo!)).not.toBe(repository.href);
  });

  it("keeps installed README links, images and same-repository URLs resolvable offline", () => {
    expect(packedPaths.has("README.md")).toBe(true);
    const pages = ["README.md", "example/README.md"].filter((page) => packedPaths.has(page));
    expect(pages.flatMap((page) => brokenLinks(page, read(page), packedPaths))).toEqual([]);
  });

  it("detects an unpacked relative render in both Markdown and HTML without treating code as navigation", () => {
    const doc = `
[See render][render]

[render]: drawme-architecture.drawio.png

<img title="example src='not-a-link'" src='drawme-architecture.drawio.png'>

[Up](../README.md#examples) and \`[Illustration](not-a-link)\`
`;
    const absent = new Set(["README.md", "example/README.md"]);
    expect(brokenLinks("example/README.md", doc, absent)).toEqual([
      "example/README.md: drawme-architecture.drawio.png is not in the npm package",
      "example/README.md: drawme-architecture.drawio.png is not in the npm package",
    ]);
    absent.add("example/drawme-architecture.drawio.png");
    expect(brokenLinks("example/README.md", doc, absent)).toEqual([]);
  });

  it("discloses local rendering and hosted-provider access to requests and attached images before installation", () => {
    const opening = read("README.md").split(/^## Quick Start\s*$/m)[0];
    expect(opening).toMatch(/\*\*Privacy:\*\*[^\n]*\brenders? and exports? locally\b/i);
    expect(opening).toMatch(/\*\*Privacy:\*\*[^\n]*\brequests\b[^\n]*\battached preview or storyboard images\b[^\n]*\bhosted model\b[^\n]*\bprovider can receive\b/i);
    expect(opening).not.toMatch(/\bentirely on (?:your|the user's) (?:machine|computer)\b/i);
  });

  it("documents the actual ordered validation gate, assets scope and a runnable single-test path", () => {
    const gate = manifest.scripts.validate.split(/\s*&&\s*/);
    const gateLabels = gate.map((command) => command.replace(/^npm (?:run )?/, ""));
    for (const path of ["README.md", "CLAUDE.md"]) {
      const doc = read(path);
      const gateComment = doc.match(/^npm run validate\s+# ([^\n]+)/m)?.[1];
      expect(gateComment?.split(": ").at(-1)?.split(/\s*→\s*/), path).toEqual(gateLabels);
      expect(doc, path).toMatch(/^npm run check:golden\s+# .*?(?:bundled )?assets\b/m);
    }
    const contributorGate = section(read("CONTRIBUTING.md"), "## The validation gate");
    expect(Array.from(contributorGate.matchAll(/^\d+\. `(npm [^`]+)`/gm), ([, command]) => command)).toEqual(gate);
    expect(contributorGate).toMatch(/SHA-256[^\n]*paths and contents[^\n]*bundled `assets\/`/i);
    const commands = read("CLAUDE.md");
    const testPaths = Array.from(commands.matchAll(/^npx vitest run (tests\/\S+\.test\.ts)$/gm), ([, path]) => path);
    expect(testPaths.length).toBeGreaterThan(0);
    for (const path of testPaths) expect(fileExists(path), path).toBe(true);
  });

  it("marks the shipped obsolete review checklist as historical before the old instructions and links the live workflow", () => {
    const path = "docs/visual-review-implementation-tasks.md";
    if (!packedPaths.has(path)) return; // The alternate contract is to omit the checklist from the release.
    const opening = read(path).split(/^## /m)[0];
    expect(opening).toMatch(/\bhistorical\b[^\n]*\bnot current instructions\b/i);
    expect(targets(opening)).toContain("../README.md#the-drawme-workflow");
    const workflow = section(read("README.md"), "## The /drawme Workflow");
    expect(workflow).toMatch(/at most eight[^\n]*correction retries total/i);
    expect(workflow).toMatch(/never pauses for approval/i);
  });

  it("documents the public width-only option and the distinct raster, SVG and PDF sizing rules", () => {
    const exportDoc = section(read("docs/reference.md"), "### `drawio_export`");
    expect(exportDoc).toMatch(/^\| `width` \|[^\n]*Replaces raster `scale`[^\n]*no public `height` option/m);
    expect(exportDoc).not.toMatch(/^\| `height` \|/m);
    expect(exportDoc).toMatch(/6,000,000 pixels, including the border[^\n]*explicit width can be reduced/i);
    expect(exportDoc).toMatch(/previews preserve aspect ratio[^\n]*2000 × 2000 px[^\n]*explicit width/i);
    expect(exportDoc).toMatch(/\*\*SVG:\*\*[^\n]*adds `border` pixels on each side[^\n]*width applies before padding/i);
    expect(exportDoc).toMatch(/\*\*PDF:\*\*[^\n]*retains the authored print-page bounds[^\n]*instead of cropping/i);
    const current = section(read("CHANGELOG.md"), "## [Unreleased]");
    expect(current).toMatch(/public export tool accepts `width`, not `height`/i);
    expect(current).toMatch(/including the border[^\n]*6,000,000 pixels[^\n]*when a width is requested/i);
  });

  it.each([
    ["docs/reference.md", "### `drawio_animate`"],
    ["assets/references/xml-authoring.md", "### Motion with `drawio_animate`"],
  ])("states finite motion limits, valid dim/fade and visual-batch storyboard sampling in %s", (path, heading) => {
    const motion = section(read(path), heading);
    expect(motion).toMatch(/\b1[–-]200 steps\b/);
    expect(motion).toMatch(/\b(?:duration[s]?\b[^\n]*at most 60,000 ms)[^\n]*\bwaits?\b[^\n]*\bzero\b/i);
    expect(motion).toMatch(/(?:`stagger`[^\n]*`hold`|`hold`[^\n]*`stagger`)[^\n]*0[–-]60,000 ms/);
    expect(motion).toMatch(/before the (?:final )?hold[^\n]*300,000 ms/i);
    expect(motion).toMatch(/\bfadeIn`?[^\n]*visible but dimmed cell[^\n]*full opacity/i);
    expect(motion).toMatch(/\bvisual batches\b/);
    expect(motion).toMatch(/at most 12[^\n]*\bfirst and last\b/);
    expect(motion).toMatch(/parallel steps share a frame[^\n]*standalone waits (?:advance time without adding frames|add none)/i);
  });
});

describe("release gate on the installed file set", { concurrent: false }, () => {
  let fixture: string | undefined;

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "drawme installed pack "));
    fixture = dir;
    // Keep the whole working source tree, even when individual modules are excluded from npm's files.
    await cp(join(root, "src"), join(dir, "src"), { recursive: true });
    for (const path of packedPaths) {
      if (path.startsWith("src/")) continue;
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await cp(join(root, path), join(dir, path));
    }
    await mkdir(join(dir, "scripts"));
    for (const script of ["check-package-contents.mjs", "pack-closure.mjs"]) {
      await cp(join(root, "scripts", script), join(dir, "scripts", script));
    }
    const typescript = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
    await mkdir(join(dir, "node_modules"));
    await symlink(typescript, join(dir, "node_modules", "typescript"), "junction");
    // The real checker invokes npm. Bound that subprocess before the checker timeout so
    // a timeout cannot leave a live npm child, and implement no fake inventory or checker.
    await writeFile(join(dir, "scripts", "npm-offline.mjs"), `
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] !== "pack" || args.slice(1).sort().join(" ") !== "--dry-run --ignore-scripts --json") {
  throw new Error("Expected a script-free pack dry run");
}
execFileSync(process.execPath, [${JSON.stringify(npmCli)}, "--offline", ...args], {
  stdio: "inherit", timeout: ${npmTimeoutMs}, killSignal: "SIGKILL",
});
`);
  }, testTimeoutMs);

  afterAll(async () => {
    if (fixture) await rm(fixture, { recursive: true, force: true });
  }, testTimeoutMs);

  async function runGate(files: string[]) {
    const dir = fixture!;
    await writeFile(join(dir, "package.json"), JSON.stringify({ ...manifest, files }));
    const result = spawnSync(process.execPath, ["scripts/check-package-contents.mjs"], {
      cwd: dir,
      env: { ...process.env, npm_execpath: join(dir, "scripts", "npm-offline.mjs") },
      encoding: "utf8", timeout: checkerTimeoutMs, killSignal: "SIGKILL",
    });
    expect(result.error).toBeUndefined();
    return { code: result.status, output: result.stdout + result.stderr };
  }

  it("passes with the real package allowlist", async () => {
    const { code, output } = await runGate(manifest.files);
    expect(code, output).toBe(0);
    expect(output).toMatch(/check:pack OK \(\d+ files\)/);
  }, testTimeoutMs);

  it.each(["src/animate.ts", "src/motion.ts", "src/storyboard.ts", "src/svgexport.ts"])(
    "rejects omitting %s from the tarball without deleting it from source",
    async (missing) => {
      expect(packedPaths.has(missing)).toBe(true);
      const { code, output } = await runGate([...packedPaths].filter((path) => path !== missing));
      expect(statSync(join(fixture!, missing)).isFile()).toBe(true);
      expect(code, output).toBe(1);
      expect(output).toContain("check:pack FAILED (1 issue(s))");
      expect(output).toContain(`runtime package file is missing: ${missing}`);
    }, testTimeoutMs,
  );
});
