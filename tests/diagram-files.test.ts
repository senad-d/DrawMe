import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { constants } from "node:fs";
import {
  appendFile, link, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, truncate, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DOMParser } from "@xmldom/xmldom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VALIDATION_LIMITS, ValidationStop, createValidationBudget, diagramPages, pageModel,
  readDiagramXml, withDiagramFiles,
} from "../src/diagram-files";
import { type DomEl, attr } from "../src/dom";
import { fitCanvasFile } from "../src/fitcanvas";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open), realpath: vi.fn(fs.realpath) };
});

const disk = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "drawme-intake-"));
});
afterEach(async () => {
  vi.resetAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

/** Wait for a cancellable call to finish resolving its filesystem identities. */
async function waitUntilQueued(signal: AbortSignal): Promise<void> {
  await expect.poll(() => getEventListeners(signal, "abort").length).toBe(1);
}

const BARE = `<mxGraphModel page="1"><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<UserObject id="authored" label="Wrapped"><mxCell vertex="1" parent="1"><mxGeometry x="5" y="-10" width="100" height="50" as="geometry"/></mxCell></UserObject>
</root></mxGraphModel>`;

function rootOf(xml: string): DomEl {
  return new DOMParser().parseFromString(xml, "text/xml").documentElement as unknown as DomEl;
}

describe("diagram intake", () => {
  it("uses a UTF-8 byte ceiling and rejects oversized files before open", async () => {
    const input = join(dir, "utf8.drawio");
    await writeFile(input, "é");
    await expect(readDiagramXml(input, 1)).rejects.toThrow("1 byte limit");
    expect(open).not.toHaveBeenCalled();
    await expect(readDiagramXml(input, 2)).resolves.toBe("é");
  });

  it("rejects a directory without opening it", async () => {
    await expect(readDiagramXml(dir, 16)).rejects.toThrow("not a regular file");
    expect(open).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects a FIFO without waiting for a writer", async () => {
    const input = join(dir, "pipe.drawio");
    await promisify(execFile)("mkfifo", [input]);
    await expect(readDiagramXml(input, 16)).rejects.toThrow("not a regular file");
    expect(open).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("checks the descriptor when a regular input is replaced by a FIFO", async () => {
    const input = join(dir, "replaced.drawio");
    await writeFile(input, "ok");
    vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
      await rename(input, join(dir, "original.drawio"));
      await promisify(execFile)("mkfifo", [input]);
      // Fail without an actual blocking open if the nonblocking flag is lost.
      expect(Number(flags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
      return disk.open(path, flags, mode);
    });
    await expect(readDiagramXml(input, 16)).rejects.toThrow("not a regular file");
  });

  it("checks the opened descriptor and closes it if the file grew before open", async () => {
    const input = join(dir, "grew.drawio");
    await writeFile(input, "ok");
    const fd = await disk.open(input, "r");
    const close = vi.spyOn(fd, "close");
    vi.mocked(open).mockImplementationOnce(async () => {
      await appendFile(input, "more");
      return fd;
    });
    try {
      await expect(readDiagramXml(input, 4)).rejects.toThrow("4 byte limit");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await fd.close();
    }
  });

  it("reads only one extra byte when a file grows after descriptor stat", async () => {
    const input = join(dir, "growing.drawio");
    await writeFile(input, "ok");
    const fd = await disk.open(input, "r");
    const originalStat = fd.stat.bind(fd);
    const originalRead = fd.read.bind(fd);
    const close = vi.spyOn(fd, "close");
    vi.spyOn(fd, "stat").mockImplementationOnce(async () => {
      const beforeGrowth = await originalStat();
      await appendFile(input, "0123456789");
      return beforeGrowth;
    });
    let bytesRead = 0;
    vi.spyOn(fd, "read").mockImplementation((async (...args: Parameters<typeof originalRead>) => {
      const result = await originalRead(...args);
      bytesRead += result.bytesRead;
      return result;
    }) as typeof fd.read);
    vi.mocked(open).mockResolvedValueOnce(fd);
    try {
      await expect(readDiagramXml(input, 4)).rejects.toThrow("4 byte limit");
      expect(bytesRead).toBe(5);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await fd.close();
    }
  });

  it("resolves bare and wrapped models without discarding unreadable page wrappers", () => {
    const bare = rootOf(BARE);
    expect(diagramPages(bare)).toEqual([bare]);
    expect(pageModel(bare)).toBe(bare);
    const single = rootOf(`<diagram name="Only">${BARE}</diagram>`);
    expect(diagramPages(single)).toEqual([single]);
    expect(pageModel(single)?.tagName).toBe("mxGraphModel");

    const pages = diagramPages(rootOf(`<mxfile>
      <diagram name="Compressed">encoded</diagram><diagram name="Normal">${BARE}</diagram><diagram name="Empty"/>
    </mxfile>`));
    expect(pages.map((page) => attr(page, "name"))).toEqual(["Compressed", "Normal", "Empty"]);
    expect(pages.map((page) => pageModel(page)?.tagName ?? null)).toEqual([null, "mxGraphModel", null]);
    expect(diagramPages(rootOf("<mxfile/>"))).toEqual([]);
  });
});

describe("validation budgets", () => {
  it("allows the exact cumulative work limit and stops subsequent work and findings", () => {
    const accept = vi.fn();
    const budget = createValidationBudget({ ...DEFAULT_VALIDATION_LIMITS, maxWork: 3 }, accept);
    budget.work(2);
    budget.work();
    expect(() => budget.work()).toThrow(ValidationStop);
    expect(() => budget.finding("warning", "not admitted")).toThrow("work limit");
    expect(accept).not.toHaveBeenCalled();
  });

  it("retains only the admitted findings and bounds each message before emission", () => {
    const accept = vi.fn();
    const budget = createValidationBudget({ ...DEFAULT_VALIDATION_LIMITS, maxDiagnostics: 2 }, accept);
    budget.finding("observation", "first");
    budget.finding("warning", "x".repeat(600) + "unretained", "through");
    expect(() => budget.finding("error", "not admitted")).toThrow(ValidationStop);
    expect(() => budget.work()).toThrow("diagnostic limit");
    expect(accept.mock.calls).toEqual([
      ["observation", "first", undefined],
      ["warning", "x".repeat(511) + "…", "through"],
    ]);
  });
});

describe("diagram file transactions", () => {
  it("serializes an existing hard link without blocking an unrelated file", async () => {
    const input = join(dir, "source.drawio");
    const alias = join(dir, "hardlink.drawio");
    await writeFile(input, "before");
    await link(input, alias);
    const entered = latch();
    const finish = latch();
    const owner = withDiagramFiles([input], undefined, async () => {
      entered.release();
      await finish.promise;
      await writeFile(input, "after");
    });
    await entered.promise;
    const waiting = new AbortController();
    const action = vi.fn(() => readFile(alias, "utf8"));
    const waiter = withDiagramFiles([alias, alias], waiting.signal, action);
    try {
      await waitUntilQueued(waiting.signal);
      await expect(withDiagramFiles([join(dir, "independent.drawio")], undefined, async () => "free"))
        .resolves.toBe("free");
      expect(action).not.toHaveBeenCalled();
    } finally {
      finish.release();
      await Promise.allSettled([owner, waiter]);
    }
    await expect(waiter).resolves.toBe("after");
    expect(getEventListeners(waiting.signal, "abort")).toEqual([]);
  });

  it("queues a future destination reached through a symlinked parent", async () => {
    const parent = join(dir, "actual");
    const alias = join(dir, "alias");
    await mkdir(parent);
    await symlink(parent, alias, "junction");
    const target = join(parent, "new.drawio");
    const aliasedTarget = join(alias, "new.drawio");
    const entered = latch();
    const finish = latch();
    const owner = withDiagramFiles([target], undefined, async () => {
      entered.release();
      await finish.promise;
      await writeFile(target, "created");
    });
    await entered.promise;
    const waiting = new AbortController();
    const waiter = withDiagramFiles([aliasedTarget], waiting.signal, () => readFile(aliasedTarget, "utf8"));
    try {
      await waitUntilQueued(waiting.signal);
    } finally {
      finish.release();
      await Promise.allSettled([owner, waiter]);
    }
    await expect(waiter).resolves.toBe("created");
  });

  it("aborts a queued reservation promptly without letting a successor pass its owner", async () => {
    const input = join(dir, "source.drawio");
    const extra = join(dir, "extra.drawio");
    const entered = latch();
    const finish = latch();
    const owner = withDiagramFiles([input], undefined, async () => {
      entered.release();
      await finish.promise;
    });
    await entered.promise;
    const cancel = new AbortController();
    const queuedAction = vi.fn(async () => "not run");
    const queued = withDiagramFiles([input, extra], cancel.signal, queuedAction);
    const later = new AbortController();
    const successorAction = vi.fn(async () => "ran");
    let successor: Promise<string> | undefined;
    try {
      await waitUntilQueued(cancel.signal);
      successor = withDiagramFiles([input], later.signal, successorAction);
      await waitUntilQueued(later.signal);
      const aborted = expect(queued).rejects.toMatchObject({ name: "AbortError" });
      cancel.abort();
      await aborted;
      expect(queuedAction).not.toHaveBeenCalled();
      expect(getEventListeners(cancel.signal, "abort")).toEqual([]);
      await expect(withDiagramFiles([extra], undefined, async () => "released")).resolves.toBe("released");
      expect(successorAction).not.toHaveBeenCalled();
    } finally {
      finish.release();
      await Promise.allSettled([owner, queued, successor]);
    }
    await expect(successor).resolves.toBe("ran");
  });

  it("coordinates opposite-order transactions and releases their keys after an action fails", async () => {
    const a = join(dir, "a.drawio");
    const b = join(dir, "b.drawio");
    const calls: string[] = [];
    const entered = latch();
    const finish = latch();
    const first = withDiagramFiles([a, b], undefined, async () => {
      calls.push("first");
      entered.release();
      await finish.promise;
      throw new Error("action failed");
    });
    await entered.promise;
    const waiting = new AbortController();
    const second = withDiagramFiles([b, a], waiting.signal, async () => { calls.push("second"); });
    try {
      await waitUntilQueued(waiting.signal);
      expect(calls).toEqual(["first"]);
    } finally {
      finish.release();
      await Promise.allSettled([first, second]);
    }
    await expect(first).rejects.toThrow("action failed");
    await expect(second).resolves.toBeUndefined();
    expect(calls).toEqual(["first", "second"]);
  });
});

describe("fit file boundary", () => {
  it("refuses an oversized source before changing an existing output", async () => {
    const input = join(dir, "oversized.drawio");
    const output = join(dir, "existing.drawio");
    await writeFile(input, BARE);
    await truncate(input, DEFAULT_VALIDATION_LIMITS.maxBytes + 1);
    await writeFile(output, "prior contents");

    await expect(fitCanvasFile({ input, output })).rejects.toThrow("byte limit");
    expect(await readFile(output, "utf8")).toBe("prior contents");
  });

  it("fits a single diagram wrapper through an explicit hard link without rewriting the source or wrapper IDs", async () => {
    const input = join(dir, "input.drawio");
    const output = join(dir, "output.drawio");
    const alias = join(dir, "existing.drawio");
    const xml = `<diagram name="Only">${BARE}</diagram>`;
    await writeFile(input, xml);
    await writeFile(alias, "previous contents");
    await link(alias, output);
    const { ino } = await stat(alias, { bigint: true });

    await expect(fitCanvasFile({ input, output })).resolves.toMatchObject({
      input, output, changed: true, pages: [{ page: "Only", status: "fitted", after: { width: 180, height: 130 } }],
    });
    expect(await readFile(input, "utf8")).toBe(xml);
    expect((await stat(output, { bigint: true })).ino).toBe(ino);
    const fitted = await readFile(alias, "utf8");
    expect(fitted).toContain('pageWidth="180"');
    expect(fitted).toContain('<UserObject id="authored" label="Wrapped"><mxCell vertex="1"');
  });

  it("reads a source only after a transaction holding its hard-link alias finishes editing", async () => {
    const input = join(dir, "source.drawio");
    const alias = join(dir, "editing.drawio");
    await writeFile(input, "");
    await link(input, alias);
    const entered = latch();
    const finish = latch();
    const owner = withDiagramFiles([alias], undefined, async () => {
      entered.release();
      await finish.promise;
      await writeFile(alias, BARE);
    });
    await entered.promise;

    const resolving = latch();
    vi.mocked(realpath).mockImplementation(async (...args) => {
      if (args[0] === input) resolving.release();
      return disk.realpath(...args);
    });
    const fit = fitCanvasFile({ input });
    try {
      // Without the shared boundary, fit tries to parse the old, empty source.
      await Promise.race([fit, resolving.promise]);
    } finally {
      finish.release();
      await Promise.allSettled([owner, fit]);
    }
    await expect(fit).resolves.toMatchObject({ changed: true });
    expect(await readFile(alias, "utf8")).toContain('pageWidth="180"');
  });
});
