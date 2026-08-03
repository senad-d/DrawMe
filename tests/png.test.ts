import { describe, it, expect } from "vitest";
import { repairPngBuffer } from "../src/png";

const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

describe("repairPngBuffer", () => {
  it("appends a full IEND chunk when it is entirely missing", () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
    const fixed = repairPngBuffer(data);
    expect(fixed).not.toBeNull();
    expect(fixed!.subarray(fixed!.length - 12).equals(IEND)).toBe(true);
    // original bytes are preserved before the appended chunk
    expect(fixed!.subarray(0, data.length).equals(data)).toBe(true);
  });

  it("replaces a bare trailing length field with a full IEND chunk (the draw.io -e case)", () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const truncated = Buffer.concat([body, Buffer.from([0x00, 0x00, 0x00, 0x00])]);
    const fixed = repairPngBuffer(truncated);
    expect(fixed).not.toBeNull();
    expect(fixed!.equals(Buffer.concat([body, IEND]))).toBe(true);
    // exactly one IEND, not the truncated field plus a chunk
    expect(fixed!.length).toBe(body.length + 12);
  });

  it("is a no-op when the file already ends with a valid IEND chunk", () => {
    const data = Buffer.concat([Buffer.from([0x89, 0x50]), IEND]);
    expect(repairPngBuffer(data)).toBeNull();
  });
});
