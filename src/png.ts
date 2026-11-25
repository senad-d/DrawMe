/**
 * Repair the truncated IEND chunk in draw.io `-e` PNG exports.
 *
 * draw.io's CLI can emit `-e` (embedded-XML) PNGs with the 4-byte IEND length
 * field present but the trailing 8 bytes of "IEND" type + CRC missing, so strict
 * PNG decoders and vision APIs reject the file (draw.io-desktop issue #8).
 * SVG/PDF are unaffected.
 *
 * Idempotent: a no-op once the file already ends with a valid IEND chunk, so it
 * is safe to run unconditionally after every `-e` PNG export.
 */
import { readFile, writeFile } from "node:fs/promises";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A complete, valid IEND chunk: length(0) + "IEND" + CRC 0xAE426082. */
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
/** The bare 4-byte length field draw.io leaves behind when it truncates. */
const LEN_FIELD = Buffer.from([0x00, 0x00, 0x00, 0x00]);

/** Find the IEND boundary without decoding image data. */
function pngEndOffset(data: Buffer): number {
  const badPng = () => new Error("draw.io output is not a complete PNG");
  if (!data.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw badPng();
  let offset = SIGNATURE.length;
  let hasImageData = false;
  while (offset + 12 <= data.length) {
    const size = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const next = offset + 12 + size;
    if (next > data.length || (offset === SIGNATURE.length && (type !== "IHDR" || size !== 13))) throw badPng();
    if (type === "IEND") break;
    if (type === "IDAT" && size > 0) hasImageData = true;
    offset = next;
  }
  if (!hasImageData) throw badPng();
  return offset;
}

/** Validate chunk boundaries, returning a repaired copy only for an embedded PNG missing its IEND tail. */
export function repairPngBuffer(data: Buffer, embedded = true): Buffer | null {
  const end = pngEndOffset(data);
  const tail = data.subarray(end);
  if (tail.equals(IEND)) return null;
  if (!embedded || (tail.length !== 0 && !tail.equals(LEN_FIELD))) throw new Error("draw.io output is not a complete PNG");
  return Buffer.concat([data.subarray(0, end), IEND]);
}

/** Verify the PNG and return whether its truncated tail had to be repaired. */
export async function repairPng(path: string, embedded = true): Promise<boolean> {
  const fixed = repairPngBuffer(await readFile(path), embedded);
  if (!fixed) return false;
  await writeFile(path, fixed);
  return true;
}
