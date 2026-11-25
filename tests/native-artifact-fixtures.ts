import assert from "node:assert/strict";
import { inflateRawSync, inflateSync } from "node:zlib";
import { DOMParser, onErrorStopParsing } from "@xmldom/xmldom";

export function parseXml(xml: string) {
  return new DOMParser({ onError: onErrorStopParsing }).parseFromString(xml, "text/xml");
}

/** Read the delivered file independently of DrawMe's PNG validation and repair. */
export function readPng(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  const chunks: { name: string; data: Buffer }[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const name = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 8 + size;
    assert.ok(end + 4 <= bytes.length, `complete PNG ${name} chunk`);
    chunks.push({ name, data: bytes.subarray(offset + 8, end) });
    offset = end + 4;
    if (name === "IEND") {
      assert.equal(offset, bytes.length, "IEND must terminate the PNG");
      break;
    }
  }
  assert.equal(chunks.at(-1)?.name, "IEND", "complete PNG IEND chunk");
  const [header] = chunks;
  assert.equal(header.name, "IHDR");
  return { chunks, width: header.data.readUInt32BE(0), height: header.data.readUInt32BE(4) };
}

type Png = ReturnType<typeof readPng>;

/** Decode draw.io's PNG text value and, if needed, its compressed diagram envelopes. */
export function editableModels({ chunks }: Png) {
  return chunks.flatMap(({ name, data }) => {
    if (!["zTXt", "tEXt", "iTXt"].includes(name)) return [];
    const keywordEnd = data.indexOf(0);
    if (data.toString("latin1", 0, keywordEnd) !== "mxGraphModel") return [];
    let payload = data.subarray(keywordEnd + 1);
    if (name === "zTXt") {
      assert.equal(payload[0], 0, "zTXt compression method");
      payload = inflateSync(payload.subarray(1));
    } else if (name === "iTXt") {
      const [compressed, method] = payload;
      assert.equal(method, 0, "iTXt compression method");
      // Skip the language tag and translated keyword.
      const languageEnd = payload.indexOf(0, 2);
      const translationEnd = payload.indexOf(0, languageEnd + 1);
      assert.ok(languageEnd >= 2 && translationEnd > languageEnd, "complete iTXt fields");
      payload = payload.subarray(translationEnd + 1);
      if (compressed) payload = inflateSync(payload);
    }
    const text = payload.toString("utf8").trim();
    const xml = /^%3c/i.test(text) ? decodeURIComponent(text) : text;
    const doc = parseXml(xml);
    return [
      ...Array.from(doc.getElementsByTagName("mxGraphModel")),
      ...Array.from(doc.getElementsByTagName("diagram")).flatMap((page) => {
        if (page.getElementsByTagName("mxGraphModel").length) return [];
        const encoded = page.textContent?.trim();
        assert.ok(encoded, "editable page contains a graph model");
        const model = decodeURIComponent(inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8"));
        return Array.from(parseXml(model).getElementsByTagName("mxGraphModel"));
      }),
    ];
  });
}

/** Count solid interior colors in the renderer's noninterlaced 8-bit RGB/RGBA storyboard. */
export function countPngColors({ chunks, width, height }: Png, colors: readonly number[]) {
  const header = chunks[0].data;
  assert.equal(header[8], 8, "storyboard sample depth");
  assert.equal(header[12], 0, "noninterlaced storyboard");
  assert.ok(header[9] === 2 || header[9] === 6, "truecolor storyboard");
  const channels = header[9] === 6 ? 4 : 3;
  const stride = width * channels;
  const pixels = inflateSync(Buffer.concat(chunks.filter(({ name }) => name === "IDAT").map(({ data }) => data)));
  assert.equal(pixels.length, height * (stride + 1));
  const counts = new Map(colors.map((color) => [color, 0]));
  let prior = Buffer.alloc(stride);
  for (let row = 0; row < pixels.length; row += stride + 1) {
    const filter = pixels[row];
    assert.ok(filter <= 4, "PNG row filter");
    const current = pixels.subarray(row + 1, row + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = prior[x];
      const diagonal = x >= channels ? prior[x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up :
        filter === 3 ? (left + up) >> 1 : paeth(left, up, diagonal);
      current[x] = (current[x] + predictor) & 255;
    }
    for (let x = 0; x < stride; x += channels) {
      if (channels === 4 && current[x + 3] !== 255) continue;
      const color = current.readUIntBE(x, 3);
      const count = counts.get(color);
      if (count !== undefined) counts.set(color, count + 1);
    }
    prior = current;
  }
  return colors.map((color) => counts.get(color)!);
}

/** Read baseline or progressive JPEG frame dimensions from the real output. */
export function jpegFrame(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 2).toString("hex"), "ffd8", "JPEG SOI");
  assert.equal(bytes.subarray(-2).toString("hex"), "ffd9", "JPEG EOI");
  for (let offset = 2; offset + 4 < bytes.length;) {
    assert.equal(bytes[offset++], 0xff, "JPEG segment marker");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) break;
    const length = bytes.readUInt16BE(offset);
    assert.ok(length >= 2 && offset + length <= bytes.length, "JPEG segment length");
    if (marker === 0xc0 || marker === 0xc2) {
      assert.ok(length >= 8, "JPEG frame length");
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  assert.fail("JPEG did not have a baseline or progressive frame");
}

function paeth(left: number, up: number, diagonal: number) {
  const estimate = left + up - diagonal;
  const a = Math.abs(estimate - left), b = Math.abs(estimate - up), c = Math.abs(estimate - diagonal);
  return a <= b && a <= c ? left : b <= c ? up : diagonal;
}
