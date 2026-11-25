import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairPng, repairPngBuffer } from "../src/png";
import { TINY_PNG } from "./fixtures";

const PNG = Buffer.from(TINY_PNG, "base64");

it("repairs a valid embedded PNG with the existing one-argument file API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drawme-repair-png-"));
  try {
    const path = join(dir, "embedded.png");
    await writeFile(path, PNG.subarray(0, -8));
    expect(await repairPng(path)).toBe(true);
    expect(await readFile(path)).toEqual(PNG);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("repairPngBuffer", () => {
  it("appends a full IEND chunk when it is entirely missing", () => {
    expect(repairPngBuffer(PNG.subarray(0, -12))).toEqual(PNG);
  });

  it("replaces a bare trailing length field with a full IEND chunk (the draw.io -e case)", () => {
    expect(repairPngBuffer(PNG.subarray(0, -8))).toEqual(PNG);
  });

  it("is a no-op when the file already ends with a valid IEND chunk", () => {
    expect(repairPngBuffer(PNG)).toBeNull();
  });

  it("does not repair a truncated unembedded PNG", () => {
    expect(() => repairPngBuffer(PNG.subarray(0, -8), false)).toThrow("not a complete PNG");
  });
});
