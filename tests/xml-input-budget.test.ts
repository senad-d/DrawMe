import { constants } from "node:fs";
import { appendFile, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createValidationBudget, ValidationBudgetExceeded } from "../src/validation-budget";
import { DEFAULT_MAX_XML_BYTES, DiagramXmlTooLargeError, readDiagramXml } from "../src/xml-input";

vi.mock("node:fs/promises", { spy: true });
const openFile = vi.mocked(open);
const XML = '<diagram name="é"/>';
const XML_BYTES = Buffer.byteLength(XML);

let dir: string;
let input: string;

describe("readDiagramXml", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "drawme-xml-"));
    input = join(dir, "diagram.drawio");
    await writeFile(input, XML);
  });

  afterEach(async () => {
    openFile.mockReset();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns regular UTF-8 files, including ones exactly at the byte limit", async () => {
    expect(DEFAULT_MAX_XML_BYTES).toBe(16 * 1024 * 1024);
    await expect(readDiagramXml(input)).resolves.toBe(XML);
    await expect(readDiagramXml(input, XML_BYTES)).resolves.toBe(XML);
  });

  it("rejects an already oversized file before opening it, counting bytes rather than characters", async () => {
    await expect(readDiagramXml(input, XML.length)).rejects.toBeInstanceOf(DiagramXmlTooLargeError);
    expect(openFile).not.toHaveBeenCalled();
  });

  it("rejects non-regular input before opening it, using a nonblocking directory fixture", async () => {
    await expect(readDiagramXml(dir)).rejects.toThrow(/not a regular file/);
    expect(openFile).not.toHaveBeenCalled();
  });

  it.each(["non-regular", "oversized"] as const)("rejects a %s opened handle before reading and closes it", async (kind) => {
    // Simulate the opened file differing from the path preflight without a timing race.
    const openedStats = kind === "non-regular" ? await stat(dir) : await stat(input);
    if (kind === "oversized") openedStats.size += 1;
    const file = await open(input, "r");
    const read = vi.spyOn(file, "read");
    vi.spyOn(file, "stat").mockResolvedValueOnce(openedStats);
    openFile.mockResolvedValueOnce(file);

    try {
      const error = kind === "non-regular" ? /not a regular file/ : DiagramXmlTooLargeError;
      await expect(readDiagramXml(input, XML_BYTES)).rejects.toThrow(error);
      expect(openFile).toHaveBeenCalledWith(input, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      expect(read).not.toHaveBeenCalled();
      expect(file.fd).toBe(-1);
    } finally {
      await file.close();
    }
  });

  it("reads at most limit plus one byte when a regular file grows after the handle stat", async () => {
    const limit = XML_BYTES + 4;
    const file = await open(input, "r");
    const openedStats = await file.stat();
    const read = vi.spyOn(file, "read");
    vi.spyOn(file, "stat").mockImplementationOnce(async () => {
      await appendFile(input, " ".repeat(64));
      return openedStats;
    });
    openFile.mockResolvedValueOnce(file);

    try {
      await expect(readDiagramXml(input, limit)).rejects.toBeInstanceOf(DiagramXmlTooLargeError);
      const reads = await Promise.all(read.mock.results.map(({ value }) => value));
      expect(reads.reduce((bytes, result) => bytes + result.bytesRead, 0)).toBe(limit + 1);
      expect(file.fd).toBe(-1);
    } finally {
      await file.close();
    }
  });

  it("rejects an invalid byte limit before opening the input", async () => {
    await expect(readDiagramXml(input, Number.NaN)).rejects.toThrow(RangeError);
    expect(openFile).not.toHaveBeenCalled();
  });
});

describe("validation budget", () => {
  it("stops work before an overdraw, keeping unused capacity and the separate diagnostic allowance", () => {
    const budget = createValidationBudget(3, 1);
    budget.work(2);
    expect(() => budget.work(2)).toThrow(ValidationBudgetExceeded);
    budget.work();
    expect(() => budget.work()).toThrow(/work budget/);
    expect(() => budget.diagnostic()).not.toThrow();
  });

  it("stops diagnostics at their own limit without consuming work", () => {
    const budget = createValidationBudget(1, 1);
    budget.diagnostic();
    expect(() => budget.diagnostic()).toThrow(ValidationBudgetExceeded);
    expect(() => budget.diagnostic()).toThrow(/diagnostics budget/);
    expect(() => budget.work()).not.toThrow();
    expect(() => budget.work()).toThrow(ValidationBudgetExceeded);
  });

  it("does not let invalid counts increase or disable the budget", () => {
    expect(() => createValidationBudget(Number.NaN, 1)).toThrow(RangeError);
    expect(() => createValidationBudget(1, -1)).toThrow(RangeError);
    const budget = createValidationBudget(0, 0);
    expect(() => budget.work(-1)).toThrow(RangeError);
    expect(() => budget.work(0)).not.toThrow();
    expect(() => budget.work()).toThrow(ValidationBudgetExceeded);
  });
});
