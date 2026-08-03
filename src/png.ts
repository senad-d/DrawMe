/**
 * Repair the truncated IEND chunk in draw.io `-e` PNG exports.
 *
 * draw.io's CLI emits `-e` (embedded-XML) PNGs with the 4-byte IEND length
 * field present but the trailing 8 bytes of "IEND" type + CRC missing, so strict
 * PNG decoders and vision APIs reject the file (draw.io-desktop issue #8).
 * SVG/PDF are unaffected. Ported 1:1 from the skill's `scripts/repair_png.py`.
 *
 * Idempotent: a no-op once the file already ends with a valid IEND chunk, so it
 * is safe to run unconditionally after every `-e` PNG export. Local-only, no
 * network.
 */
import { readFile, writeFile } from "node:fs/promises";

/** A complete, valid IEND chunk: length(0) + "IEND" + CRC 0xAE426082. */
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
/** The bare 4-byte length field draw.io leaves behind when it truncates. */
const LEN_FIELD = Buffer.from([0x00, 0x00, 0x00, 0x00]);

/**
 * Return a repaired copy of `data`, or `null` if it already ends with a valid
 * IEND chunk (no change needed). Pure — no filesystem access, for easy testing.
 */
export function repairPngBuffer(data: Buffer): Buffer | null {
  if (data.length >= IEND.length && data.subarray(data.length - IEND.length).equals(IEND)) {
    return null;
  }
  const body =
    data.length >= LEN_FIELD.length && data.subarray(data.length - LEN_FIELD.length).equals(LEN_FIELD)
      ? data.subarray(0, data.length - LEN_FIELD.length)
      : data;
  return Buffer.concat([body, IEND]);
}

/** Repair the PNG at `path` in place. Returns true if the file was changed. */
export async function repairPng(path: string): Promise<boolean> {
  const fixed = repairPngBuffer(await readFile(path));
  if (!fixed) return false;
  await writeFile(path, fixed);
  return true;
}
