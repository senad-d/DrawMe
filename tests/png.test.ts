import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { repairPng, repairPngBuffer } from "../src/png";
import { TINY_PNG } from "./fixtures";

const PNG = Buffer.from(TINY_PNG, "base64");

function chunk(type: string, data: Buffer): Buffer {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

function withScanlines(scanlines: number[]): Buffer {
  return Buffer.concat([PNG.subarray(0, 33), chunk("IDAT", deflateSync(Buffer.from(scanlines))), PNG.subarray(-12)]);
}

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

  it.each(["IHDR", "IDAT", "zTXt"])("rejects a bad %s CRC even when only the tail needs repair", (type) => {
    const data = type === "zTXt"
      ? Buffer.concat([PNG.subarray(0, -12), chunk(type, Buffer.concat([Buffer.from("mxGraphModel\0\0"), deflateSync("diagram")])), PNG.subarray(-12)])
      : Buffer.from(PNG);
    const start = data.indexOf(type);
    data[start + 4 + data.readUInt32BE(start - 4)] ^= 1; // flip only the CRC
    expect(() => repairPngBuffer(data)).toThrow("not a complete PNG");
    expect(() => repairPngBuffer(data.subarray(0, -8))).toThrow("not a complete PNG");
  });

  it("repairs the missing tail without changing valid compressed diagram metadata", () => {
    const xml = Buffer.from("<mxGraphModel><root/></mxGraphModel>");
    const text = chunk("zTXt", Buffer.concat([Buffer.from("mxGraphModel\0\0"), deflateSync(xml)]));
    const complete = Buffer.concat([PNG.subarray(0, -12), text, PNG.subarray(-12)]);
    expect(repairPngBuffer(complete.subarray(0, -8))).toEqual(complete);
  });

  it.each([
    { rule: "missing a declared pixel byte", scanlines: [0, 255] },
    { rule: "overflowing the declared pixel bytes", scanlines: [0, 255, 255, 0] },
    { rule: "using an invalid row filter", scanlines: [5, 255, 255] },
  ])("rejects CRC-valid IDAT $rule", ({ scanlines }) => {
    const data = withScanlines(scanlines);
    expect(() => repairPngBuffer(data)).toThrow("not a complete PNG");
    expect(() => repairPngBuffer(data.subarray(0, -8))).toThrow("not a complete PNG");
  });

  it("rejects malformed zlib data even if its PNG chunk CRC is correct", () => {
    const compressed = deflateSync(Buffer.from([0, 255, 255]));
    compressed[compressed.length - 1] ^= 1;
    const data = Buffer.concat([PNG.subarray(0, 33), chunk("IDAT", compressed), PNG.subarray(-12)]);
    expect(() => repairPngBuffer(data)).toThrow("not a complete PNG");
  });

  it("checks reconstructed palette indices, not just inflated length and filter tags", () => {
    const header = Buffer.from(PNG.subarray(16, 29));
    header.writeUInt32BE(2); // two indexed pixels per row
    header[9] = 3;
    const prefix = [PNG.subarray(0, 8), chunk("IHDR", header), chunk("PLTE", Buffer.alloc(6))];
    const indexed = (last: number) => Buffer.concat([
      ...prefix, chunk("IDAT", deflateSync(Buffer.from([1, 1, last]))), PNG.subarray(-12),
    ]);
    expect(repairPngBuffer(indexed(255))).toBeNull(); // Sub reconstructs [1, 0]
    expect(() => repairPngBuffer(indexed(1))).toThrow("not a complete PNG"); // [1, 2], outside the palette
  });

  it("validates Adam7 rows and split contiguous IDATs", () => {
    const header = Buffer.from(PNG.subarray(16, 29));
    header.writeUInt32BE(2);
    header.writeUInt32BE(2, 4);
    header[12] = 1;
    // 2×2 gray+alpha: separate one-pixel rows in passes 1 and 6, one two-pixel row in pass 7.
    const data = deflateSync(Buffer.alloc(3 + 3 + 5));
    const png = Buffer.concat([PNG.subarray(0, 8), chunk("IHDR", header),
      chunk("IDAT", data.subarray(0, 4)), chunk("IDAT", data.subarray(4)), PNG.subarray(-12)]);
    expect(repairPngBuffer(png)).toBeNull();
  });
});
