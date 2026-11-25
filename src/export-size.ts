import type { ExportMode, ExportOptions } from "./drawio";

/** Includes both margins on both axes. */
export const MAX_FINAL_RASTER_PIXELS = 6_000_000;
const DEFAULT_PREVIEW_SIDE = 2000;
const MAX_PREVIEW_SIDE = 2576;

type Size = { width: number; height: number };
type Axis = keyof Size;

function sizeOf(width?: number, height?: number): Size | undefined {
  if (width === undefined || height === undefined || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  // A horizontal/vertical connector can span only one axis; the renderer still needs a pixel on the other.
  if (width <= 0 && height <= 0) return undefined;
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

function longSideLimit(opts: ExportOptions, mode: ExportMode): number {
  if (mode !== "preview") return Infinity;
  return opts.width != null || opts.height != null ? MAX_PREVIEW_SIDE : DEFAULT_PREVIEW_SIDE;
}

export function checkRasterSize(opts: ExportOptions, mode: ExportMode, width: number, height: number): void {
  const side = longSideLimit(opts, mode);
  if (width > side || height > side) throw new Error(`draw.io raster exceeds the ${side}px preview limit (${width}×${height})`);
  if (width * height > MAX_FINAL_RASTER_PIXELS) {
    throw new Error(`draw.io raster exceeds the ${MAX_FINAL_RASTER_PIXELS} pixel budget (${width}×${height})`);
  }
}

/** The requested scale, lowered so the bordered raster stays within MAX_FINAL_RASTER_PIXELS. */
export function cappedScale(scale: number, margin: number, contentWidth?: number, contentHeight?: number): number {
  const content = sizeOf(contentWidth, contentHeight);
  if (!content) return scale;
  const area = (content.width + 2 * margin) * (content.height + 2 * margin);
  const max = Math.sqrt(MAX_FINAL_RASTER_PIXELS / area);
  return scale <= max ? scale : Math.floor(max * 100) / 100 || max;
}

function dimensionFlag(value: number): number {
  const px = Math.floor(value);
  if (!Number.isSafeInteger(px) || px <= 0) throw new Error("export width and height must be finite and at least one pixel");
  return px;
}

function longerAxis(size?: Size): Axis {
  return size && size.height > size.width ? "height" : "width";
}

/** Fit one integer CLI dimension with a fixed output-pixel border and a measured aspect ratio. */
function fitAxis(requested: number, ratio: number, border: number, sideLimit: number): number {
  const margins = 2 * border;
  let low = margins + 1;
  let high = Math.min(requested, sideLimit, MAX_FINAL_RASTER_PIXELS);
  let result = 0;
  while (low <= high) {
    const axis = Math.floor((low + high) / 2);
    const otherSide = Math.ceil((axis - margins) * ratio) + margins;
    if (otherSide <= sideLimit && axis * otherSide <= MAX_FINAL_RASTER_PIXELS) {
      result = axis;
      low = axis + 1;
    } else {
      high = axis - 1;
    }
  }
  if (!result) throw new Error("export size or raster budget leaves no room for content inside the border");
  return result;
}

/** Use one axis only: draw.io derives the other, preserving aspect ratio. */
export function planExportSize(
  opts: ExportOptions, mode: ExportMode, raster: boolean, margin: number, args: string[],
  contentWidth?: number, contentHeight?: number,
): number {
  if (!Number.isFinite(margin) || margin < 0) throw new Error("export border must be finite and nonnegative");
  const explicitAxis = opts.width != null ? "width" : opts.height != null ? "height" : undefined;
  const explicitSize = explicitAxis ? dimensionFlag(opts[explicitAxis]!) : undefined;
  if (!raster) {
    if (explicitAxis) args.push(`--${explicitAxis}`, String(explicitSize));
    return margin;
  }

  const content = sizeOf(contentWidth, contentHeight);
  const longAxis = longerAxis(content);
  const requestedScale = opts.scale ?? 2;
  if (!explicitAxis && mode === "final" && (!Number.isFinite(requestedScale) || requestedScale <= 0)) {
    throw new Error("export scale must be finite and positive");
  }
  // The renderer accepts integer output-pixel borders with --width/--height.
  let border = Math.round(margin);
  let axis: Axis;
  let dimension: number;
  if (explicitAxis) {
    axis = explicitAxis;
    dimension = explicitSize!;
  } else if (mode === "preview") {
    axis = longAxis;
    dimension = DEFAULT_PREVIEW_SIDE;
  } else if (content || (contentWidth !== undefined && Number.isFinite(contentWidth) && contentWidth > 0)) {
    axis = longAxis;
    const scale = cappedScale(requestedScale, margin, contentWidth, contentHeight);
    border = Math.round(margin * scale);
    dimension = Math.max(1, Math.round((content?.[axis] ?? contentWidth!) * scale)) + 2 * border;
  } else {
    args.push("-s", String(requestedScale));
    return border;
  }
  if (content) {
    const sideLimit = longSideLimit(opts, mode);
    const ratio = content[axis === "width" ? "height" : "width"] / content[axis];
    const fitted = fitAxis(dimension, ratio, border, sideLimit);
    // When a cap binds, size by the longer axis so the Xvfb screen accounts for it too.
    if (fitted < dimension && axis !== longAxis) {
      dimension = fitAxis(Math.floor((fitted - 2 * border) * ratio + 2 * border), 1 / ratio, border, sideLimit);
      axis = longAxis;
    } else {
      dimension = fitted;
    }
  } else {
    // The staged header still enforces both limits when the graph is opaque or has no measurable bounds.
    dimension = Math.min(dimension, longSideLimit(opts, mode), MAX_FINAL_RASTER_PIXELS);
    if (dimension <= 2 * border) throw new Error("export size leaves no room for content inside the border");
  }
  args.push(`--${axis}`, String(dimension));
  return border;
}

/** Read the JPEG frame dimensions from an actual SOF segment, not merely its SOI/EOI magic. */
export function jpegSize(data: Buffer): Size | undefined {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) return undefined;
  let frame: Size | undefined;
  for (let offset = 2; offset < data.length - 2;) {
    if (data[offset++] !== 0xff) return undefined;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    // Reject standalone markers outside entropy-coded scan data.
    if (!marker || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9) || offset + 2 > data.length - 2) return undefined;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length - 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (frame || length < 11 || length !== 8 + 3 * data[offset + 7] || !data[offset + 7]) return undefined;
      const height = data.readUInt16BE(offset + 3), width = data.readUInt16BE(offset + 5);
      if (!width || !height) return undefined;
      frame = { width, height };
    }
    if (marker === 0xda) return length >= 8 && offset + length < data.length - 2 ? frame : undefined;
    offset += length;
  }
  return undefined;
}
