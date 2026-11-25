import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import manifest from "../package.json";
import { compileMotion, type MotionCell } from "../src/motion";
import { sampleFrames } from "../src/storyboard";
import { AUTOMATIC_CORRECTION_LIMIT, drawmeWorkflow } from "../src/workflow";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readme = read("README.md");
const exampleIndex = read("example/README.md");
const repository = "https://github.com/senad-d/DrawMe";
const workflow = drawmeWorkflow("a login flow", "assets/references", { available: true }, {
  diagramTypes: null, xmlAuthoring: null, stylePresets: null, mermaidAuthoring: null,
});

function linkTargets(markdown: string): string[] {
  // The two READMEs use inline Markdown links and HTML href/src attributes.
  return Array.from(markdown.matchAll(/\]\(([^\s)]+)\)|\b(?:href|src)=["']([^"']+)["']/g), ([, inline, html]) => inline ?? html);
}

it("discloses hosted model access to requests and image attachments before installation", () => {
  const firstInstall = readme.search(/^\s*(?:brew install|pi install)\b/m);
  expect(firstInstall).toBeGreaterThan(0);
  const introduction = readme.slice(0, firstInstall);
  const notice = introduction.match(/^>\s*\*\*Privacy:\*\*\s*([^\n]+(?:\n>[^\n]+)*)/m)?.[1] ?? "";
  expect(notice).toMatch(/draw\.io.*renders locally/i);
  expect(notice).toMatch(/diagram request.*tool results.*attached preview and storyboard images.*configured model provider/is);
  expect(notice).toMatch(/hosted provider.*(?:leave|sent outside) your machine/is);
  expect(introduction).not.toMatch(/runs entirely on your machine|entire workflow (?:is|runs) (?:entirely )?local/i);
});

it("installs from the canonical GitHub repository according to the installed Pi parser", async () => {
  const source = readme.match(/`pi install (git:[^`\s]+)`/)?.[1];
  expect(source, "the Git install command in the README").toBeDefined();
  // Pi's public package exports do not expose this parser. Resolve the installed entry,
  // then use the same dist module that Pi's package manager imports, without installing.
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { parseGitUrl } = await import(new URL("./utils/git.js", entry).href) as {
    parseGitUrl: (value: string) => { repo: string } | null;
  };
  expect(parseGitUrl(source!)?.repo).toBe(repository);
});

it("keeps README links valid in the npm pack and locates repository-only example media", () => {
  // A fixed command also invokes npm.cmd on Windows; no paths or doc text are interpolated.
  const output = execSync("npm --offline --ignore-scripts run --silent pack:dry-run", {
    cwd: root, encoding: "utf8", timeout: 15_000,
  });
  const [pack] = JSON.parse(output) as { files: { path: string }[] }[];
  const files = new Set(pack.files.map(({ path }) => path));
  const sources = [...files].filter((path) => path.startsWith("example/") && path.endsWith(".drawio"));
  expect(sources).toContain("example/drawme-installation-guide.drawio");
  const renders = [...sources.map((path) => `${path}.png`), "example/event-driven-orders.animated.svg", "example/event-driven-orders.storyboard.png"];
  for (const [path, markdown] of [["README.md", readme], ["example/README.md", exampleIndex]]) {
    const targets = linkTargets(markdown);
    const relativeFiles = targets.filter((target) => !/^(?:[\w+.-]+:|\/\/|#)/.test(target))
      .map((target) => {
        const file = decodeURIComponent(target.split(/[?#]/)[0]);
        return posix.isAbsolute(file) ? file : posix.join(posix.dirname(path), file);
      });
    expect(relativeFiles.filter((target) => !files.has(target)), `${path} links omitted by npm pack`).toEqual([]);
    expect(relativeFiles, `${path} leads to editable sources`).toEqual(expect.arrayContaining(sources));

    for (const target of renders) {
      expect(files.has(target), `${target} belongs in the repository, not the package`).toBe(false);
      expect(existsSync(join(root, target)), `${target} exists in the repository`).toBe(true);
      expect(targets, `${path} links to the repository copy of ${target}`).toContain(`${repository}/blob/main/${target}`);
    }
  }
  // npm can include the nested README automatically; keep the link valid without relying on that.
  expect(linkTargets(readme)).toContain(`${repository}/blob/main/example/README.md`);
}, 20_000);

it("describes the renderer cutoff, unavailable diagnostic and native WSL route in first-use prose", () => {
  for (const [name, text] of [["README.md", readme], ["example/README.md", exampleIndex]]) {
    const check = text.split("\n").find((line) => line.includes("`/drawme-check`") && line.includes("Mermaid import")) ?? "";
    expect(check, name).toMatch(/path.*version.*Mermaid import and ELK layout.*(?:unavailable|unsupported)/i);
    expect(text, name).toMatch(/30\.2\.4 or later/i);
    expect(text, name).toMatch(/WSL[^.\n]*native Linux[^.\n]*\bdraw\.io\b/i);
  }
  expect(readme).toMatch(/older than 30\.2\.4 reports both features as unsupported;.*ordinary export/i);
  expect(exampleIndex).toMatch(/ordinary rendering and export do not.*WSL requires native Linux draw\.io, not the Windows executable/i);
});

it("distinguishes vision attachments and transcript history from process-local preview files", () => {
  const vision = readme.split("\n").find((line) => line.startsWith("- **Vision-aware previews:**")) ?? "";
  expect(vision).toMatch(/attach the image only when the active model declares image support/i);
  expect(vision).toMatch(/text-only models and models with unknown image support use structural review/i);
  expect(readme).toMatch(/comparable prior attachment for the same source and page on the current conversation branch/i);
  for (const [name, text] of [["README.md", readme], ["example/README.md", exampleIndex], ["/drawme workflow", workflow]]) {
    const cleanup = text.split("\n").find((line) => line.includes("across restarts")) ?? "";
    expect(cleanup, name).toMatch(/(?:current|this) process/i);
    expect(cleanup, name).toContain("per source");
    expect(cleanup, name).toContain("not per page or across restarts");
    expect(cleanup, name).toMatch(/transcript attachments? (?:are separate from|for review; don't assume the) (?:those )?files?/i);
  }
  expect(exampleIndex).toMatch(/without an attached image, use structural review.*rendered inspection was skipped/i);
  expect(workflow).toMatch(/Image NOT attached.*unknown.*review structurally instead.*rendered inspection was skipped/i);
});

it("describes storyboard sampling in visual batches rather than one tile per motion step", () => {
  const animateRow = readme.split("\n").find((line) => line.startsWith("| `drawio_animate` |")) ?? "";
  const limit = animateRow.match(/up to (\d+) visual batches/i)?.[1];
  expect(limit).toBe("12");
  expect(animateRow).toMatch(/parallel steps share a frame/i);
  expect(animateRow).toMatch(/standalone waits do not get a frame/i);

  const cells = new Map<string, MotionCell>(Array.from({ length: 14 }, (_, index) => [
    `node-${index}`, { kind: "vertex", style: "", parent: null },
  ]));
  const { errors, compiled } = compileMotion({ loop: false, steps: [
    { effect: "fadeIn", cells: ["node-0"], duration: 100 },
    { effect: "fadeIn", cells: ["node-1"], duration: 100, parallel: true },
    { effect: "wait", duration: 75 },
    ...Array.from(cells.keys()).slice(2).map((id) => ({ effect: "fadeIn" as const, cells: [id], duration: 100 })),
  ] }, cells);
  expect(errors).toEqual([]);
  const frames = compiled!.frames;
  expect(frames).toHaveLength(13);
  expect([frames[0].opacity.get("node-0"), frames[0].opacity.get("node-1")]).toEqual([1, 1]);
  expect(frames.slice(0, 2).map(({ time }) => time)).toEqual([100, 275]);
  const sampled = sampleFrames(frames);
  expect(sampled).toHaveLength(Number(limit));
  expect([sampled[0], sampled.at(-1)]).toEqual([frames[0], frames.at(-1)]);
});

it("lists the actual four validation stages and an existing single-test command", () => {
  const contributor = read("CONTRIBUTING.md");
  const claude = read("CLAUDE.md");
  const gate = manifest.scripts.validate.split(/\s*&&\s*/);
  expect(gate).toEqual(["npm run check:golden", "npm run lint", "npm test", "npm run check:pack"]);
  expect(manifest.scripts.lint.split(/\s*&&\s*/)).toEqual(["npm run typecheck", "npm run lint:eslint", "npm run format:check"]);
  expect(manifest.scripts.test).toBe("vitest run");
  const gateSection = contributor.split("## The validation gate\n")[1]?.split("\n## ")[0] ?? "";
  expect(Array.from(gateSection.matchAll(/^\d+\. `(npm [^`]+)`/gm), ([, command]) => command)).toEqual(gate);
  for (const [doc, text] of [["README.md", readme], ["CLAUDE.md", claude]]) {
    const commands = text.split("\n").filter((line) => /^npm run (?:validate|check:pack)\b/.test(line));
    expect(commands, doc).toContainEqual(expect.stringMatching(/npm run validate.*golden check \+ lint \+ tests \+ pack check/i));
    expect(commands, doc).toContainEqual(expect.stringMatching(/npm run check:pack.*dry-run contents and runtime import closure/i));
  }
  const testPath = claude.match(/^npx vitest run (tests\/\S+\.test\.ts)\s*$/m)?.[1];
  expect(testPath && existsSync(join(root, testPath)), `documented test path: ${testPath}`).toBe(true);
  for (const text of [readme, contributor, claude]) {
    expect(text).toMatch(/SHA-256 integrity of (?:file )?paths and contents under `?assets\//i);
  }
});

it("covers asset paths and contents, not working-tree prose, with the golden checker", () => {
  const dir = mkdtempSync(join(tmpdir(), "drawme golden scope "));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const script = "scripts/check-golden.mjs";
  expect(manifest.scripts["check:golden"]).toBe(`node ${script}`);
  mkdirSync(join(dir, "scripts"));
  copyFileSync(join(root, script), join(dir, script));
  mkdirSync(join(dir, "assets", "references"), { recursive: true });
  const asset = join(dir, "assets", "references", "toy.md");
  writeFileSync(asset, "one\n");
  const check = (...args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8", timeout: 5_000 });
    if (result.error) throw result.error;
    return result;
  };
  expect(check("--update").status).toBe(0);
  writeFileSync(join(dir, "README.md"), "outside assets\n");
  expect(check().status).toBe(0);
  renameSync(asset, `${asset}.renamed`);
  const renamed = check();
  expect(renamed.status).toBe(1);
  expect(renamed.stderr).toContain("golden check FAILED: bundled assets/ changed.");
  renameSync(`${asset}.renamed`, asset);
  writeFileSync(asset, "two\n");
  const modified = check();
  expect(modified.status).toBe(1);
  expect(modified.stderr).toContain("golden check FAILED: bundled assets/ changed.");
});

it("labels the old retry and approval checklist as historical before giving any instructions", () => {
  const archive = read("docs/visual-review-implementation-tasks.md");
  const [titleAndNotice] = archive.split(/^## /m);
  expect(titleAndNotice).toMatch(/^# .*\(Historical\)/m);
  expect(titleAndNotice).toMatch(/^> .*not current workflow guidance.*retry counts and human approval gate.*obsolete/im);
  const retryCount = AUTOMATIC_CORRECTION_LIMIT === 8 ? "(?:8|eight)" : String(AUTOMATIC_CORRECTION_LIMIT);
  expect(titleAndNotice).toMatch(new RegExp(`up to ${retryCount} correction retries in total`, "i"));
  expect(titleAndNotice).toMatch(/does not require human approval before final export/i);
  expect(linkTargets(titleAndNotice)).toContain("../README.md#the-drawme-workflow");
  expect(workflow).toMatch(/No human gate.*never pause to ask for approval/i);
});
