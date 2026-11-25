/** Verify draw.io PNG exports, repairing only the known truncated `-e` IEND tail. */
import { readFile, writeFile } from "node:fs/promises";
import { crc32, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A complete, valid IEND chunk: length(0) + "IEND" + CRC 0xAE426082. */
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
/** The bare length field draw.io leaves behind when it truncates. */
const LEN_FIELD = Buffer.alloc(4);
// Enough for the export pixel budget even at 16-bit RGBA plus one filter byte per row.
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const PIXEL_LAYOUTS: Readonly<Partial<Record<number, { channels: number; depths: readonly number[] }>>> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

interface PngChecks {
  size?: (width: number, height: number) => void;
  preview?: boolean;
}

function badPng(): Error {
  return new Error("draw.io output is not a complete PNG");
}

function pngHeader(data: Buffer) {
  if (!data.subarray(0, SIGNATURE.length).equals(SIGNATURE) || data.length < 33 ||
    data.readUInt32BE(8) !== 13 || data.toString("latin1", 12, 16) !== "IHDR" ||
    crc32(data.subarray(12, 29)) !== data.readUInt32BE(29)) throw badPng();
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  const depth = data[24], color = data[25], interlace = data[28];
  const layout = PIXEL_LAYOUTS[color];
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !layout?.depths.includes(depth) ||
    data[26] !== 0 || data[27] !== 0 || interlace > 1) throw badPng();
  return { width, height, depth, color, interlace, bitsPerPixel: depth * layout.channels };
}

type Header = ReturnType<typeof pngHeader>;

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const dl = Math.abs(estimate - left), da = Math.abs(estimate - above), du = Math.abs(estimate - upperLeft);
  if (dl <= da && dl <= du) return left;
  return da <= du ? above : upperLeft;
}

/** Inflate every declared row and validate its PNG filter and sample layout. */
function verifyPixels(header: Header, chunks: Buffer[], paletteEntries: number): void {
  const { width, height, depth, color, interlace, bitsPerPixel } = header;
  const passes = (interlace ? ADAM7 : [[0, 0, 1, 1]]).flatMap(([x, y, dx, dy]) => {
    const columns = Math.ceil((width - x) / dx), rows = Math.ceil((height - y) / dy);
    return columns > 0 && rows > 0 ? [{ columns, rows, stride: Math.ceil(columns * bitsPerPixel / 8) }] : [];
  });
  const expected = passes.reduce((total, pass) => total + pass.rows * (1 + pass.stride), 0);
  if (expected > MAX_DECODED_BYTES) throw new Error(`draw.io PNG exceeds the ${MAX_DECODED_BYTES} byte decoded image limit`);
  const compressed = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  let decoded: Buffer;
  try {
    // Node verifies the zlib checksum. Cap output and reject trailing compressed data as well.
    const { buffer, engine } = inflateSync(compressed, { info: true, maxOutputLength: expected }) as unknown as {
      buffer: Buffer; engine: { bytesWritten: number };
    };
    if (engine.bytesWritten !== compressed.length || buffer.length !== expected) throw badPng();
    decoded = buffer;
  } catch {
    throw badPng();
  }
  let offset = 0;
  for (const { columns, rows, stride } of passes) {
    for (let row = 0; row < rows; row++) {
      const filter = decoded[offset++];
      if (filter > 4) throw badPng();
      // Filters 0–4 always reconstruct an in-range byte modulo 256. Every bit pattern is
      // a valid sample for non-indexed colors. Indexed rows must be reconstructed to check PLTE.
      if (color === 3) verifyIndexedRow(decoded, offset, row === 0, columns, stride, depth, filter, paletteEntries);
      offset += stride;
    }
  }
}

function verifyIndexedRow(
  data: Buffer, start: number, first: boolean, columns: number, stride: number,
  depth: number, filter: number, paletteEntries: number,
): void {
  const mask = (1 << depth) - 1;
  for (let i = 0; i < stride; i++) {
    const left = i > 0 ? data[start + i - 1] : 0;
    const above = first ? 0 : data[start + i - stride - 1];
    const upperLeft = first || i === 0 ? 0 : data[start + i - stride - 2];
    const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? (left + above) >> 1
      : filter === 4 ? paeth(left, above, upperLeft) : 0;
    const byte = (data[start + i] + predictor) & 0xff;
    data[start + i] = byte;
    // Ignore unused padding samples at the end of a packed row.
    for (let bit = 0; bit < 8 && i * 8 + bit < columns * depth; bit += depth) {
      if (((byte >> (8 - depth - bit)) & mask) >= paletteEntries) throw badPng();
    }
  }
}

/** Verify all pre-tail chunks and pixels before accepting or supplying IEND. */
function pngEndOffset(data: Buffer, checks?: PngChecks): number {
  const header = pngHeader(data);
  checks?.size?.(header.width, header.height);
  const imageData: Buffer[] = [];
  let paletteEntries = 0;
  let transparency = false;
  let startedImageData = false;
  let pastImageData = false;
  let offset = 33; // signature + checked IHDR
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    if (type === "IEND") break; // The caller checks the whole canonical IEND, including its CRC.
    const end = offset + 8 + size;
    if (size > 0x7fffffff || end + 4 > data.length || !/^[a-zA-Z]{2}[A-Z][a-zA-Z]$/.test(type) ||
      crc32(data.subarray(offset + 4, end)) !== data.readUInt32BE(end)) throw badPng();
    const payload = data.subarray(offset + 8, end);
    if (type === "IDAT") {
      if (pastImageData || (header.color === 3 && !paletteEntries)) throw badPng();
      startedImageData = true;
      if (size) imageData.push(payload);
    } else {
      if (startedImageData) pastImageData = true;
      if (type === "PLTE") {
        const maxEntries = header.color === 3 ? 1 << header.depth : 256;
        if (pastImageData || transparency || paletteEntries || header.color === 0 || header.color === 4 ||
          size < 3 || size % 3 !== 0 || size / 3 > maxEntries) throw badPng();
        paletteEntries = size / 3;
      } else if (type === "tRNS") {
        if (pastImageData || transparency || !validTransparency(header, payload, paletteEntries)) throw badPng();
        transparency = true;
      } else if (/^[A-Z]/.test(type)) {
        throw badPng(); // Unknown critical chunk or repeated IHDR.
      } else if (checks?.preview && ["tEXt", "iTXt", "zTXt"].includes(type) &&
        payload.toString("latin1", 0, 13) === "mxGraphModel\0") {
        throw new Error("draw.io PNG preview contains editable diagram XML");
      }
    }
    offset = end + 4;
  }
  if (!imageData.length) throw badPng();
  verifyPixels(header, imageData, paletteEntries);
  return offset;
}

function validTransparency({ color, depth }: Header, payload: Buffer, paletteEntries: number): boolean {
  if (color === 3) return payload.length > 0 && payload.length <= paletteEntries;
  if (payload.length !== (color === 0 ? 2 : color === 2 ? 6 : -1)) return false;
  for (let offset = 0; offset < payload.length; offset += 2) {
    if (payload.readUInt16BE(offset) >= 1 << depth) return false;
  }
  return true;
}

/** Validate a PNG, returning a repaired copy only for an embedded PNG missing its IEND tail. */
export function repairPngBuffer(data: Buffer, embedded = true, checks?: PngChecks): Buffer | null {
  const end = pngEndOffset(data, checks);
  const tail = data.subarray(end);
  if (tail.equals(IEND)) return null;
  if (!embedded || (tail.length !== 0 && !tail.equals(LEN_FIELD))) throw badPng();
  return Buffer.concat([data.subarray(0, end), IEND]);
}

/** Verify the PNG and return whether its truncated tail had to be repaired. */
export async function repairPng(path: string, embedded = true, checks?: PngChecks): Promise<boolean> {
  const fixed = repairPngBuffer(await readFile(path), embedded, checks);
  if (!fixed) return false;
  await writeFile(path, fixed);
  return true;
}
