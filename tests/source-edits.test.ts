import { readlinkSync, realpathSync, statSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { fitCanvasFile } from "../src/fitcanvas";
import { withSourceEdits } from "../src/source-edits";
import { DEFAULT_MAX_XML_BYTES, readDiagramXml } from "../src/xml-input";

// Metadata uses the real filesystem but settles within one event-loop turn.
// That lets the contender reach a held lock without sleeps or scheduler guesses.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    realpath: async (path: string) => realpathSync.native(path),
    readlink: async (path: string) => readlinkSync(path),
    stat: async (...args: Parameters<typeof fs.stat>) =>
      args[1]?.bigint ? statSync(args[0], { bigint: true }) : fs.stat(...args),
  };
});

vi.mock("../src/xml-input", async (importOriginal) => {
  const xml = await importOriginal<typeof import("../src/xml-input")>();
  return { ...xml, readDiagramXml: vi.fn(xml.readDiagramXml) };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawme source edits-"));
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function diagram(width: number): string {
  return `<diagram name="Plan"><mxGraphModel page="1"><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" parent="1" vertex="1"><mxGeometry x="40" y="40" width="${width}" height="50" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram>`;
}

async function hardLink(target: string, alias: string, ctx: TestContext): Promise<void> {
  try {
    await link(target, alias);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "ENOSYS" || code === "EPERM") {
      ctx.skip(`fixture filesystem does not support hard links (${code})`);
    }
    throw error;
  }
  const { dev, ino } = await stat(target, { bigint: true });
  expect(await stat(alias, { bigint: true })).toMatchObject({ dev, ino });
}

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

function pauseEdit(paths: string[], commit: () => Promise<void>, signal?: AbortSignal) {
  const entered = barrier();
  const proceed = barrier();
  const done = withSourceEdits(paths, async () => {
    entered.release();
    await proceed.reached;
    await commit();
  }, signal);
  return { entered: Promise.race([entered.reached, done]), release: proceed.release, done };
}

describe("editable-source transactions", () => {
  it.for(["same name", "symlink", "hard link"])("fits the committed diagram through the %s without blocking disjoint edits", async (route, ctx) => {
    const junctionNeeded = route === "symlink" && process.platform === "win32";
    const parent = junctionNeeded ? join(dir, "actual") : dir;
    if (junctionNeeded) await mkdir(parent);
    const source = join(parent, "plan.drawio");
    const other = join(dir, "other.drawio");
    await writeFile(source, diagram(50));
    await writeFile(other, diagram(70));
    let alias = source;
    if (junctionNeeded) {
      // Directory junctions do not require privileged file-symlink creation.
      const junction = join(dir, "linked");
      await symlink(parent, junction, "junction");
      alias = join(junction, "plan.drawio");
    } else if (route === "symlink") {
      alias = join(dir, "linked.drawio");
      await symlink("plan.drawio", alias);
    } else if (route === "hard link") {
      alias = join(dir, "linked.drawio");
      await hardLink(source, alias, ctx);
    }
    const { dev, ino } = await stat(source, { bigint: true });
    const holder = pauseEdit([source], () => writeFile(source, diagram(150)));
    await holder.entered;
    const fit = fitCanvasFile({ input: alias });
    const independent = fitCanvasFile({ input: other });
    try {
      await nextTurn();
      expect(readDiagramXml).toHaveBeenCalledWith(other);
      expect(readDiagramXml).not.toHaveBeenCalledWith(alias);
      await expect(independent).resolves.toMatchObject({ changed: true });
      expect(await readFile(source, "utf8")).toBe(diagram(50));
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, fit, independent]);
    }
    await expect(holder.done).resolves.toBeUndefined();
    expect((await fit).pages).toMatchObject([{ page: "Plan", after: { width: 230, height: 130 } }]);
    expect(await readFile(source, "utf8")).toContain('pageWidth="230"');
    expect(await stat(source, { bigint: true })).toMatchObject({ dev, ino });
    expect(await stat(alias, { bigint: true })).toMatchObject({ dev, ino });
    if (route === "symlink" && !junctionNeeded) expect((await lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it("reserves an absent explicit fit destination by its resolved parent and basename", async () => {
    const folder = join(dir, "real folder");
    const linked = join(dir, "linked folder");
    await mkdir(folder);
    await symlink(folder, linked, "junction");
    const source = join(dir, "source.drawio");
    const target = join(folder, "output.drawio");
    let alias = join(linked, "output.drawio");
    if (process.platform !== "win32") {
      // An existing final symlink can still point to an absent file.
      const dangling = join(dir, "dangling.drawio");
      await symlink(alias, dangling);
      alias = dangling;
    }
    await writeFile(source, diagram(100));
    // Both absent names resolve to one path key and must not self-deadlock.
    const holder = pauseEdit([target, alias], () => writeFile(target, diagram(200)));
    await holder.entered;
    const fit = fitCanvasFile({ input: source, output: alias });
    try {
      await nextTurn();
      expect(readDiagramXml).not.toHaveBeenCalledWith(source);
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, fit]);
    }
    await expect(holder.done).resolves.toBeUndefined();
    await expect(fit).resolves.toMatchObject({ output: alias, changed: true });
    expect(await readFile(target, "utf8")).toContain('pageWidth="180"');
    expect(await readFile(source, "utf8")).toBe(diagram(100));
  });

  it("fits opposite input/output pairs without deadlock or swapping stale snapshots", async () => {
    const a = join(dir, "a.drawio");
    const b = join(dir, "b.drawio");
    await writeFile(a, diagram(50));
    await writeFile(b, diagram(100));
    const results = await Promise.all([
      fitCanvasFile({ input: a, output: b }),
      fitCanvasFile({ input: b, output: a }),
    ]);
    expect(results.map(({ changed }) => changed).sort()).toEqual([false, true]);
    expect(await readFile(a, "utf8")).toBe(await readFile(b, "utf8"));
  });

  it("reacquires the new inode before starting an edit that queued on a replaced file", async (ctx) => {
    const target = join(dir, "target.drawio");
    const replacement = join(dir, "replacement.drawio");
    const alias = join(dir, "replacement-link.drawio");
    await writeFile(target, diagram(50));
    await writeFile(replacement, diagram(100));
    await hardLink(replacement, alias, ctx);
    const first = pauseEdit([target], () => rename(replacement, target));
    await first.entered;
    const fit = fitCanvasFile({ input: target });
    const second = pauseEdit([alias], () => writeFile(alias, diagram(200)));
    try {
      // Fit has queued using the old identity, while the replacement's inode is held separately.
      await second.entered;
      await nextTurn();
      first.release();
      await first.done;
      await nextTurn();
      expect(readDiagramXml).not.toHaveBeenCalledWith(target);
    } finally {
      first.release();
      second.release();
      await Promise.allSettled([first.done, second.done, fit]);
    }
    await expect(second.done).resolves.toBeUndefined();
    expect((await fit).pages[0].after?.width).toBe(280);
    expect(await readFile(alias, "utf8")).toContain('pageWidth="280"');
  });

  it("aborts a queued edit promptly without blocking other keys or releasing its holder", async () => {
    const a = join(dir, "a.drawio");
    const b = join(dir, "b.drawio");
    const holder = pauseEdit([b], () => writeFile(b, diagram(50)));
    await holder.entered;
    const controller = new AbortController();
    const action = vi.fn(async () => {});
    const aborted = withSourceEdits([a, b], action, controller.signal);
    const fit = fitCanvasFile({ input: b });
    try {
      await nextTurn();
      controller.abort(new Error("stop queued edit"));
      await expect(aborted).rejects.toThrow("stop queued edit");
      await expect(withSourceEdits([a], async () => "available")).resolves.toBe("available");
      expect(action).not.toHaveBeenCalled();
      expect(readDiagramXml).not.toHaveBeenCalledWith(b);
    } finally {
      controller.abort();
      holder.release();
      await Promise.allSettled([holder.done, aborted, fit]);
    }
    await expect(fit).resolves.toMatchObject({ changed: true });
  });

  it("keeps a running edit locked until it throws on abort and then allows fit", async () => {
    const input = join(dir, "plan.drawio");
    await writeFile(input, diagram(50));
    const controller = new AbortController();
    const holder = pauseEdit([input], async () => controller.signal.throwIfAborted(), controller.signal);
    await holder.entered;
    const fit = fitCanvasFile({ input });
    try {
      controller.abort(new Error("stop running edit"));
      await nextTurn();
      expect(readDiagramXml).not.toHaveBeenCalledWith(input);
    } finally {
      holder.release();
      await Promise.allSettled([holder.done, fit]);
    }
    await expect(holder.done).rejects.toThrow("stop running edit");
    await expect(fit).resolves.toMatchObject({ changed: true });
  });

  it("rejects oversized XML before modifying an existing destination", async () => {
    const input = join(dir, "too-big.drawio");
    const output = join(dir, "existing.drawio");
    await writeFile(input, diagram(50));
    await truncate(input, DEFAULT_MAX_XML_BYTES + 1);
    await writeFile(output, diagram(100));

    await expect(fitCanvasFile({ input, output })).rejects.toThrow("byte limit");
    expect(await readFile(output, "utf8")).toBe(diagram(100));
  });
});
