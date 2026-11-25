import { constants } from "node:fs";
import { open, stat, writeFile } from "node:fs/promises";
import { crc32, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const BARE_LENGTH = IEND.subarray(0, 4);
const MAX_RASTER_BYTES = 64 * 1024 * 1024;
// The repair API also accepts non-DrawMe PNGs. Independently bound its work even
// for packed pixels, which could otherwise represent hundreds of millions of samples.
const MAX_DECODE_PIXELS = 16 * 1024 * 1024;
const MODES: ReadonlyMap<number, readonly [channels: number, depths: readonly number[]]> = new Map([
  [0, [1, [1, 2, 4, 8, 16]]], [2, [3, [8, 16]]], [3, [1, [1, 2, 4, 8]]], [4, [2, [8, 16]]], [6, [4, [8, 16]]],
]);
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function badPng(): Error {
  return new Error("draw.io output is not a complete PNG");
}

/** Read a raster through one descriptor without following growth beyond its checked size. */
export async function readRasterFile(path: string): Promise<Buffer> {
  if (!(await stat(path)).isFile()) throw new Error("raster output is not a regular file");
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("raster output is not a regular file");
    if (info.size > MAX_RASTER_BYTES) throw new Error("raster output exceeds the 64 MiB file limit");
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error("raster output changed while being read");
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}

/** Indexed-color filters operate on packed bytes, not on individual indexes. */
function checkIndexes(
  pixels: Buffer, offset: number, previous: number | undefined, rowBytes: number,
  width: number, depth: number, entries: number, filter: number,
): void {
  const mask = (1 << depth) - 1;
  for (let i = 0; i < rowBytes; i++) {
    const left = i > 0 ? pixels[offset + i - 1] : 0;
    const above = previous === undefined ? 0 : pixels[previous + i];
    const corner = previous !== undefined && i > 0 ? pixels[previous + i - 1] : 0;
    const prediction = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above
      : filter === 3 ? (left + above) >> 1 : paeth(left, above, corner);
    const byte = (pixels[offset + i] + prediction) & 0xff;
    pixels[offset + i] = byte;
    for (let bit = 0; bit < 8 && i * 8 + bit < width * depth; bit += depth) {
      if (((byte >> (8 - depth - bit)) & mask) >= entries) throw badPng();
    }
  }
}

function checkPixels(
  compressed: Buffer, width: number, height: number, channels: number, depth: number,
  interlace: number, indexedEntries: number,
): void {
  const passes = (interlace === 1 ? ADAM7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const w = Math.ceil((width - x) / dx), h = Math.ceil((height - y) / dy);
    return { width: w, height: h, rowBytes: Math.ceil(w * channels * depth / 8) };
  }).filter(pass => pass.width > 0 && pass.height > 0);
  const extent = passes.reduce((sum, pass) => sum + (1 + pass.rowBytes) * pass.height, 0);
  if (extent > MAX_RASTER_BYTES) throw new Error("PNG scanlines exceed the decode limit");

  let pixels: Buffer;
  let consumed: number;
  try {
    // `info` exposes bytes consumed; inflate alone silently accepts junk past the zlib stream.
    const decoded = inflateSync(compressed, { maxOutputLength: extent, info: true }) as unknown as
      { buffer: Buffer; engine: { bytesWritten: number } };
    pixels = decoded.buffer;
    consumed = decoded.engine.bytesWritten;
  } catch {
    throw badPng();
  }
  if (pixels.length !== extent || consumed !== compressed.length) throw badPng();

  let offset = 0;
  for (const pass of passes) {
    let previous: number | undefined;
    for (let row = 0; row < pass.height; row++) {
      const filter = pixels[offset++];
      if (filter > 4) throw badPng();
      if (indexedEntries !== 0 && indexedEntries < (1 << depth)) {
        checkIndexes(pixels, offset, previous, pass.rowBytes, pass.width, depth, indexedEntries, filter);
      }
      previous = offset;
      offset += pass.rowBytes;
    }
  }
}

/** Join only the payloads in the already-validated contiguous range, without one allocation per IDAT. */
function imageData(data: Buffer, start: number, end: number, size: number): Buffer {
  if (end - start === size + 12) return data.subarray(start + 8, end - 4);
  const bytes = Buffer.allocUnsafe(size);
  let pos = 0;
  for (let chunk = start; chunk < end;) {
    const length = data.readUInt32BE(chunk);
    data.copy(bytes, pos, chunk + 8, chunk + 8 + length);
    pos += length;
    chunk += 12 + length;
  }
  return bytes;
}

/** Recognize draw.io's declared XML metadata without inflating the private text itself. */
function isDiagramText(data: Buffer): boolean {
  const end = data.subarray(0, 80).indexOf(0);
  if (end < 1) return false;
  const keyword = data.toString("latin1", 0, end);
  return keyword === "mxGraphModel" || keyword === "mxfile";
}

/** Check framing, CRCs and image data; only draw.io's known missing IEND tail is repairable. */
export function inspectPng(
  data: Buffer, embedded: boolean, checkDimensions?: (width: number, height: number) => void,
): { fixed: Buffer | null; hasEditableDiagram: boolean } {
  if (data.length > MAX_RASTER_BYTES) throw new Error("PNG exceeds the 64 MiB file limit");
  if (data.length < 33 || !data.subarray(0, 8).equals(SIGNATURE) || data.readUInt32BE(8) !== 13 ||
    data.toString("latin1", 12, 16) !== "IHDR" || crc32(data.subarray(12, 29)) !== data.readUInt32BE(29)) throw badPng();

  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  const [depth, color, compression, filter, interlace] = data.subarray(24, 29);
  const mode = MODES.get(color);
  if (!width || !height || !mode || !mode[1].includes(depth) || compression !== 0 || filter !== 0 || interlace > 1) throw badPng();
  checkDimensions?.(width, height);
  if (width * height > MAX_DECODE_PIXELS) throw new Error("PNG dimensions exceed the decode limit");

  let offset = 33, idatStart = -1, idatEnd = -1, idatBytes = 0, paletteEntries = 0;
  let hasEditableDiagram = false;
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    const next = offset + 12 + size;
    if (type === "IEND") break; // Full signature and CRC checked with the tail below.
    if (next > data.length || !/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type) ||
      crc32(data.subarray(offset + 4, next - 4)) !== data.readUInt32BE(next - 4)) throw badPng();

    if (type === "IDAT") {
      if (idatStart < 0) idatStart = offset;
      else if (idatEnd !== offset) throw badPng();
      idatEnd = next;
      idatBytes += size;
    } else if (type === "PLTE") {
      if (idatStart >= 0 || paletteEntries || color === 0 || color === 4 || size === 0 || size % 3 !== 0 ||
        size > 3 * (color === 3 ? 1 << depth : 256)) throw badPng();
      paletteEntries = size / 3;
    } else if (type[0] === type[0].toUpperCase()) {
      throw badPng(); // Duplicate IHDR or an unrecognized critical chunk.
    } else if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      hasEditableDiagram ||= isDiagramText(data.subarray(offset + 8, next - 4));
    }
    offset = next;
  }
  if (idatBytes === 0 || (color === 3 && paletteEntries === 0)) throw badPng();
  const tail = data.subarray(offset);
  const complete = tail.equals(IEND);
  // draw.io-desktop issue #8: the CLI can omit IEND or leave only its length field.
  if (!complete && (!embedded || (tail.length !== 0 && !tail.equals(BARE_LENGTH)))) throw badPng();
  if (!complete && offset + IEND.length > MAX_RASTER_BYTES) throw new Error("repaired PNG would exceed the 64 MiB file limit");
  checkPixels(imageData(data, idatStart, idatEnd, idatBytes), width, height, mode[0], depth, interlace, color === 3 ? paletteEntries : 0);
  return { fixed: complete ? null : Buffer.concat([data.subarray(0, offset), IEND]), hasEditableDiagram };
}

/** Return a repaired copy if needed, or null if the input was already complete. */
export function repairPngBuffer(data: Buffer, embedded = true): Buffer | null {
  return inspectPng(data, embedded).fixed;
}

/** Verify the PNG and return whether its truncated tail had to be repaired. */
export async function repairPng(path: string, embedded = true): Promise<boolean> {
  const fixed = repairPngBuffer(await readRasterFile(path), embedded);
  if (!fixed) return false;
  await writeFile(path, fixed);
  return true;
}
