import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { planExport, verifyStagedArtifact } from "../src/export-policy";
import { repairPng, repairPngBuffer } from "../src/png";
import { TINY_PNG } from "./fixtures";

const PNG = Buffer.from(TINY_PNG, "base64");
const SIGNATURE = PNG.subarray(0, 8);
const IEND = PNG.subarray(-12);

function chunk(type: string, content: Buffer): Buffer {
  const data = Buffer.alloc(content.length + 12);
  data.writeUInt32BE(content.length);
  data.write(type, 4, "ascii");
  content.copy(data, 8);
  data.writeUInt32BE(crc32(data.subarray(4, -4)), data.length - 4);
  return data;
}

function ihdr(width = 1, height = 1, depth = 8, color = 0, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width);
  data.writeUInt32BE(height, 4);
  data.set([depth, color, 0, 0, interlace], 8);
  return chunk("IHDR", data);
}

function image(pixels: Buffer, header = ihdr(), ...beforeData: Buffer[]): Buffer {
  return Buffer.concat([SIGNATURE, header, ...beforeData, chunk("IDAT", deflateSync(pixels)), IEND]);
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

  it("does not mistake empty artifacts or other signatures for a PNG", () => {
    expect(() => repairPngBuffer(Buffer.alloc(0))).toThrow("not a complete PNG");
    expect(() => repairPngBuffer(Buffer.concat([Buffer.from("NOT PNG!"), PNG.subarray(8)]))).toThrow("not a complete PNG");
  });

  it("rejects a failed chunk checksum despite an intact signature and IEND", () => {
    const corrupt = Buffer.from(PNG);
    corrupt[32] ^= 1; // Last byte of the IHDR checksum, not a dimension or flag.
    expect(() => repairPngBuffer(corrupt)).toThrow("not a complete PNG");
  });

  it("rejects partial, invalid, or extra IEND bytes rather than treating them as draw.io truncation", () => {
    expect(() => repairPngBuffer(PNG.subarray(0, -6))).toThrow("not a complete PNG");
    expect(() => repairPngBuffer(Buffer.concat([PNG, Buffer.alloc(1)]))).toThrow("not a complete PNG");
  });

  it.each([
    ["not a zlib stream", Buffer.from("bad IDAT")],
    ["incomplete scanline", deflateSync(Buffer.from([0]))],
    ["too much inflated data", deflateSync(Buffer.alloc(64 * 1024))],
    ["unknown row filter", deflateSync(Buffer.from([5, 0]))],
    ["extra bytes after the zlib stream", Buffer.concat([deflateSync(Buffer.from([0, 0])), Buffer.from("extra")])],
  ])("rejects checksum-valid IDAT with %s, even when IEND could be repaired", (_, payload) => {
    const body = Buffer.concat([SIGNATURE, ihdr(), chunk("IDAT", payload)]);
    expect(() => repairPngBuffer(Buffer.concat([body, IEND]))).toThrow("not a complete PNG");
    expect(() => repairPngBuffer(Buffer.concat([body, IEND.subarray(0, 4)]))).toThrow("not a complete PNG");
  });

  it("requires a single header, consecutive IDATs, and no unknown critical chunks", () => {
    const compressed = deflateSync(Buffer.from([0, 0]));
    const head = chunk("IDAT", compressed.subarray(0, 4));
    const tail = chunk("IDAT", compressed.subarray(4));
    const text = chunk("tEXt", Buffer.from("Comment\0noneditable"));
    for (const invalid of [[ihdr(), head, tail], [head, text, tail], [chunk("TEST", Buffer.alloc(0)), head, tail]]) {
      expect(() => repairPngBuffer(Buffer.concat([SIGNATURE, ihdr(), ...invalid, IEND]))).toThrow("not a complete PNG");
    }
    expect(repairPngBuffer(Buffer.concat([SIGNATURE, ihdr(), head, tail, IEND]))).toBeNull();
  });

  it("validates Adam7 scanlines at their pass dimensions and ignores empty passes", () => {
    // 5×5, 8-bit grayscale: row lengths (including the filter byte) across the seven passes.
    const passes = [2, 2, 3, 2, 2, 4, 3, 3, 3, 6, 6];
    const scanlines = Buffer.concat(passes.map(size => Buffer.alloc(size)));
    expect(repairPngBuffer(image(scanlines, ihdr(5, 5, 8, 0, 1)))).toBeNull();
    expect(() => repairPngBuffer(image(scanlines.subarray(0, -1), ihdr(5, 5, 8, 0, 1)))).toThrow("not a complete PNG");
    expect(repairPngBuffer(image(Buffer.alloc(2), ihdr(1, 1, 8, 0, 1)))).toBeNull();
  });

  it("checks legal bit depths and installed palette indexes, after unfiltering packed rows", () => {
    expect(repairPngBuffer(image(Buffer.alloc(18), ihdr(1, 2, 16, 6)))).toBeNull();
    expect(() => repairPngBuffer(image(Buffer.alloc(2), ihdr(1, 1, 1, 6)))).toThrow("not a complete PNG");
    const indexed = ihdr(3, 2, 2, 3);
    const rows = Buffer.from([0, 0b01_01_00_00, 2, 0]); // Up filter reconstructs an identical second row.
    const palette = chunk("PLTE", Buffer.from([255, 255, 255, 0, 0, 0]));
    expect(() => repairPngBuffer(image(rows, indexed))).toThrow("not a complete PNG");
    expect(repairPngBuffer(image(rows, indexed, palette))).toBeNull();
    rows[3] = 0b01_00_00_00; // Up filter now reconstructs first pixel of row 2 as out-of-range index 2.
    expect(() => repairPngBuffer(image(rows, indexed, palette))).toThrow("not a complete PNG");
  });

  it("bounds declared pixels even for a heavily packed image and the standalone repair API", () => {
    expect(() => repairPngBuffer(image(Buffer.alloc(2), ihdr(65536, 65536, 1)))).toThrow(/decode limit/);
  });
});

const preview = planExport({ input: "input.drawio", mode: "preview", embed: true });
const board = planExport({ input: "input.drawio", mode: "final", reviewRaster: true });
const final = planExport({ input: "input.drawio" });

async function withPngStage(action: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "drawme-png-stage-"));
  try {
    await action(join(dir, "artifact.png"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("staged PNGs", () => {
  it("receipts hash exactly the checked bytes and distinguish previews from persistent boards", async () => {
    await withPngStage(async path => {
      const data = image(Buffer.alloc(2000 * 2), ihdr(1, 2000), chunk("tEXt", Buffer.from("Comment\0ordinary text")));
      await writeFile(path, data);
      const sha256 = createHash("sha256").update(data).digest("hex");
      expect(await verifyStagedArtifact(preview, path)).toEqual({ repaired: false, previewSha256: sha256 });
      expect(await verifyStagedArtifact(board, path)).toEqual({ repaired: false, storyboardSha256: sha256 });
      expect(await verifyStagedArtifact(final, path)).toEqual({ repaired: false });
      expect(await readFile(path)).toEqual(data);
    });
  });

  it("refuses editable diagram text metadata on either review path, regardless of its PNG text encoding", async () => {
    await withPngStage(async path => {
      const xml = '<mxfile><diagram name="Private"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';
      const encoded = encodeURIComponent(xml);
      for (const metadata of [
        chunk("tEXt", Buffer.from(`mxGraphModel\0${xml}`)),
        chunk("zTXt", Buffer.concat([Buffer.from("mxGraphModel\0\0"), deflateSync(Buffer.from(encoded))])),
        chunk("iTXt", Buffer.from(`mxGraphModel\0\0\0\0\0${xml}`)),
      ]) {
        const data = image(Buffer.alloc(2), ihdr(), metadata);
        await writeFile(path, data);
        await expect(verifyStagedArtifact(preview, path)).rejects.toThrow(/editable diagram metadata/);
        await expect(verifyStagedArtifact(board, path)).rejects.toThrow(/editable diagram metadata/);
        expect(await verifyStagedArtifact(final, path)).toEqual({ repaired: false });
        expect(await readFile(path)).toEqual(data);
      }
    });
  });

  it("enforces both review axes on actual bytes when the source size was unknown", async () => {
    await withPngStage(async path => {
      for (const [width, height] of [[2001, 1], [1, 2001]]) {
        await writeFile(path, image(Buffer.alloc((width + 1) * height), ihdr(width, height)));
        await expect(verifyStagedArtifact(preview, path)).rejects.toThrow(/2000-pixel review limit/);
        await expect(verifyStagedArtifact(board, path)).rejects.toThrow(/2000-pixel review limit/);
      }
    });
  });

  it("enforces the actual final pixel budget before accepting a valid render", async () => {
    await withPngStage(async path => {
      const data = image(Buffer.alloc(3002 * 2000), ihdr(3001, 2000));
      await writeFile(path, data);
      await expect(verifyStagedArtifact(final, path)).rejects.toThrow(/6,000,000-pixel raster budget/);
      expect(await readFile(path)).toEqual(data);
    });
  });
});
