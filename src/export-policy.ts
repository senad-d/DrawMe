/** Export arguments and verification for private, not-yet-published artifacts. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { DEFAULT_FIT_MARGIN } from "./fitcanvas";
import { inspectPng, readRasterFile } from "./png";
import { cliPageIndex, LINUX_ROOT_RENDERER_REASON } from "./renderer";
import { finishSvgFile } from "./svgexport";

export type ExportFormat = "png" | "svg" | "pdf" | "jpg";
export type ExportMode = "preview" | "final";

export interface ExportOptions {
  input: string;
  format?: ExportFormat;
  mode?: ExportMode;
  output?: string;
  scale?: number;
  width?: number;
  height?: number;
  transparent?: boolean;
  border?: number;
  pageIndex?: number;
  embed?: boolean;
  /** Require and verify animation in a final SVG. */
  animated?: boolean;
  binary?: string;
  signal?: AbortSignal;
  /** Persistent final PNG with preview sizing and metadata restrictions. */
  reviewRaster?: boolean;
}

export interface ExportPlan {
  format: ExportFormat;
  mode: ExportMode;
  embed: boolean;
  animated: boolean;
  output: string;
  /** Export flags ending with `-o <output>`. The input path is appended after these. */
  args: string[];
  input: string;
  /** Flags that must go after the input path on Linux. */
  linuxExtra: string[];
  /** SVG only: padding to add after the renderer exports without a border. */
  svgMargin: number;
  reviewRaster?: boolean;
}

export const MAX_FINAL_RASTER_PIXELS = 6_000_000;
const MAX_REVIEW_SIDE = 2000;

type Axis = "width" | "height";
type ContentSize = Record<Axis, number>;

/** Derive a default output path next to the input, including the editable `.drawio.png` convention. */
export function deriveOutput(input: string, format: ExportFormat, embed: boolean, mode: ExportMode = "final"): string {
  const dir = dirname(input);
  const ext = extname(input);
  const base = ext ? basename(input).slice(0, -ext.length) : basename(input);
  if (mode === "preview") return join(dir, `${base}.preview.${format}`);
  if (format === "png" && embed) return join(dir, `${base}.drawio.png`);
  return join(dir, `${base}.${format}`);
}

function positive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/** Requested scale, reduced when the estimated bordered raster would exceed the pixel budget. */
export function cappedScale(scale: number, margin: number, contentWidth?: number, contentHeight?: number): number {
  if (!positive(contentWidth) || !positive(contentHeight)) return scale;
  const max = Math.sqrt(MAX_FINAL_RASTER_PIXELS) / Math.sqrt(contentWidth + 2 * margin) / Math.sqrt(contentHeight + 2 * margin);
  const roundedDown = Math.floor(max * 100) / 100;
  return Math.min(scale, roundedDown || max);
}

function validateOutputName(output: string, format: ExportFormat, plat: string): void {
  if (!output || output.endsWith("/") || (plat === "win32" && output.endsWith("\\"))) {
    throw new Error(`export destination must name a file: ${output}`);
  }
  const suffix = extname(output).toLowerCase();
  if (suffix && suffix !== `.${format}` && !(format === "jpg" && suffix === ".jpeg")) {
    throw new Error(`export destination suffix ${suffix} does not match the requested ${format.toUpperCase()} format: ${output}`);
  }
}

function otherAxis(axis: Axis): Axis {
  return axis === "width" ? "height" : "width";
}

/** Draw.io fits to one outer dimension, keeping the content aspect ratio inside its pixel border. */
function fitRaster(
  axis: Axis, wanted: number, border: number, content: ContentSize | undefined, review: boolean, args: string[],
): void {
  const sideLimit = review ? MAX_REVIEW_SIDE : MAX_FINAL_RASTER_PIXELS;
  const padding = 2 * border;
  const minimum = padding + 1;
  const oppositeSpan = (span: number, dim: Axis) => content
    ? Math.ceil((span - padding) * (content[otherAxis(dim)] / content[dim]) + padding)
    : minimum;
  const projected = oppositeSpan(wanted, axis);
  if (content && content[otherAxis(axis)] > content[axis] && (projected > sideLimit || projected * wanted > MAX_FINAL_RASTER_PIXELS)) {
    // When capping by the long side, pass it directly: Xvfb can size for it and
    // an inaccurate estimate of the short side cannot overshoot that long-side flag.
    const opposite = otherAxis(axis);
    // Floor the equivalent span so switching axes never enlarges the requested scale.
    wanted = Math.floor((wanted - padding) * (content[opposite] / content[axis]) + padding);
    axis = opposite;
  }
  let high = Math.min(wanted, sideLimit);
  let low = minimum;
  const fits = (span: number) => {
    const other = Math.max(minimum, oppositeSpan(span, axis));
    return other <= sideLimit && span * other <= MAX_FINAL_RASTER_PIXELS;
  };
  if (high < low || !fits(low)) throw new Error("raster border does not fit the output size budget; reduce the border or choose a larger size");
  // Test integer spans, including the rounded-up opposite side, rather than
  // assuming the rounded output will fit a continuous area estimate.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(mid)) low = mid;
    else high = mid - 1;
  }
  args.push(`--${axis}`, String(low));
}

function planSize(
  opts: ExportOptions, raster: boolean, review: boolean, margin: number, args: string[],
  width?: number, height?: number,
): number {
  const explicit = opts.width ?? opts.height;
  const axis = opts.width != null ? "width" : "height";
  if (explicit != null && !positive(explicit)) throw new Error(`${axis} must be a positive finite number`);
  if (opts.scale != null && !positive(opts.scale)) throw new Error("scale must be a positive finite number");
  if (!raster) {
    if (explicit != null) args.push(`--${axis}`, String(explicit));
    return margin;
  }

  const content = positive(width) && positive(height) ? { width, height } : undefined;
  const longest: Axis = content && content.height > content.width ? "height" : "width";
  const border = Math.floor(margin);
  if (explicit != null || review) {
    const wanted = explicit == null ? MAX_REVIEW_SIDE : Math.max(1, Math.floor(explicit));
    fitRaster(explicit == null ? longest : axis, wanted, border, content, review, args);
    return border;
  }

  const scale = cappedScale(opts.scale ?? 2, margin, width, height);
  const side = content?.[longest] ?? width;
  if (positive(side) && scale !== 1) {
    // With a dimension flag the draw.io border is in output pixels and even on
    // all sides; with -s and a nonunit scale draw.io's border is uneven.
    const scaledBorder = Math.round(margin * scale);
    const wanted = Math.max(2 * scaledBorder + 1, Math.round(side * scale + 2 * scaledBorder));
    fitRaster(longest, wanted, scaledBorder, content, false, args);
    return scaledBorder;
  }
  args.push("-s", String(scale));
  return border;
}

/** Build export arguments without accessing the filesystem or launching a renderer. */
export function planExport(
  opts: ExportOptions,
  plat: string = platform(),
  isRoot = false,
  contentWidth?: number,
  contentHeight?: number,
  version?: string,
): ExportPlan {
  const animated = opts.animated ?? false;
  const format = opts.format ?? (animated ? "svg" : "png");
  const mode = opts.mode ?? "final";
  if (animated && format !== "svg") throw new Error("animated export requires format='svg'");
  if (animated && mode !== "final") throw new Error("animated export requires mode='final'; use a PNG preview for review");
  if (opts.reviewRaster && (mode !== "final" || format !== "png")) throw new Error("reviewRaster requires a final PNG");
  const review = mode === "preview" || opts.reviewRaster === true;
  if (!review && format === "jpg" && opts.embed) throw new Error("JPG cannot embed editable diagram XML");
  const embed = !review && (opts.embed ?? format !== "jpg");
  const output = opts.output ?? deriveOutput(opts.input, format, embed, mode);
  validateOutputName(output, format, plat);
  if (plat === "linux" && isRoot) throw new Error(LINUX_ROOT_RENDERER_REASON);

  const margin = opts.border ?? DEFAULT_FIT_MARGIN;
  if (margin < 0 || !Number.isSafeInteger(Math.floor(margin))) throw new Error("border must be finite and nonnegative");
  const args = ["-x", "-f", format];
  if (embed) args.push("-e");
  const border = planSize(opts, format === "png" || format === "jpg", review, margin, args, contentWidth, contentHeight);
  args.push("-b", String(format === "svg" ? 0 : border));
  if (opts.transparent && format === "png") args.push("-t");
  if (opts.pageIndex != null) args.push("--page-index", String(cliPageIndex(version ?? "27.0.2", opts.pageIndex)));
  args.push("-o", output);
  const plan: ExportPlan = {
    format, mode, embed, animated, output, args, input: opts.input,
    linuxExtra: plat === "linux" ? ["--disable-gpu"] : [], svgMargin: format === "svg" ? margin : 0,
  };
  if (opts.reviewRaster) plan.reviewRaster = true;
  return plan;
}

function checkRasterDimensions(plan: ExportPlan, width: number, height: number, review: boolean): void {
  const format = plan.format.toUpperCase();
  if (review && Math.max(width, height) > MAX_REVIEW_SIDE) {
    throw new Error(`draw.io ${format} output (${width}×${height}) exceeds the ${MAX_REVIEW_SIDE}-pixel review limit on either side`);
  }
  if (width * height > MAX_FINAL_RASTER_PIXELS) {
    throw new Error(`draw.io ${format} output (${width}×${height}) exceeds the ${MAX_FINAL_RASTER_PIXELS.toLocaleString("en-US")}-pixel raster budget`);
  }
}

function incomplete(plan: ExportPlan): Error {
  return new Error(`draw.io output is not a complete ${plan.format.toUpperCase()}: ${plan.output}`);
}

/** Read the frame header before the first scan; unlike an SOI/EOI check this yields actual JPEG dimensions. */
function jpegDimensions(data: Buffer, plan: ExportPlan): ContentSize {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8 || data.readUInt16BE(data.length - 2) !== 0xffd9) throw incomplete(plan);
  let frame: ContentSize | undefined;
  const trailer = data.length - 2;
  for (let offset = 2; offset < trailer;) {
    if (data[offset++] !== 0xff) break;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (offset + 2 > trailer || marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd9)) break;
    const size = data.readUInt16BE(offset);
    const next = offset + size;
    if (size < 2 || next > trailer) break;
    if (marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // SOF: length, precision, height, width, count, 3 bytes per component.
      if (frame || size < 11 || size !== 8 + 3 * data[offset + 7]) break;
      const width = data.readUInt16BE(offset + 5), height = data.readUInt16BE(offset + 3);
      if (!width || !height) break;
      frame = { width, height };
    } else if (marker === 0xda) {
      // SOS: length, component count + selectors, then three scan parameters.
      if (frame && size >= 8 && size === 6 + 2 * data[offset + 2] && next < trailer) return frame;
      break;
    }
    offset = next;
  }
  throw incomplete(plan);
}

async function verifyPdf(path: string, plan: ExportPlan): Promise<void> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error(`draw.io output is not a regular file: ${plan.output}`);
    const { size } = info;
    const head = Buffer.alloc(5), tail = Buffer.alloc(Math.min(32, size));
    const start = await file.read(head, 0, head.length, 0);
    const end = await file.read(tail, 0, tail.length, size - tail.length);
    if (start.bytesRead !== head.length || end.bytesRead !== tail.length || head.toString("latin1") !== "%PDF-" ||
      !tail.toString("latin1").trimEnd().endsWith("%%EOF")) throw incomplete(plan);
  } finally {
    await file.close();
  }
}

/** Verify staged bytes before publication and hash the exact PNG buffer eligible for review. */
export async function verifyStagedArtifact(
  plan: ExportPlan, path: string,
): Promise<{ repaired: boolean; previewSha256?: string; storyboardSha256?: string }> {
  const file = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`draw.io reported no error but the output was not created: ${plan.output}`);
    throw error;
  });
  if (!file.isFile()) throw new Error(`draw.io output is not a regular file: ${plan.output}`);
  const review = plan.mode === "preview" || plan.reviewRaster === true;
  if (plan.format === "png") {
    const data = await readRasterFile(path);
    const { fixed, hasEditableDiagram } = inspectPng(data, plan.embed && !review,
      (width, height) => checkRasterDimensions(plan, width, height, review));
    if ((review || !plan.embed) && hasEditableDiagram) throw new Error("PNG output contains editable diagram metadata despite embedding being disabled");
    if (fixed) await writeFile(path, fixed);
    if (review) {
      const sha256 = createHash("sha256").update(data).digest("hex");
      return plan.mode === "preview" ? { repaired: false, previewSha256: sha256 } : { repaired: false, storyboardSha256: sha256 };
    }
    return { repaired: fixed !== null };
  }
  if (plan.format === "jpg") {
    const { width, height } = jpegDimensions(await readRasterFile(path), plan);
    checkRasterDimensions(plan, width, height, review);
  } else if (plan.format === "svg") {
    try {
      await finishSvgFile(path, plan.svgMargin);
    } catch (error) {
      throw new Error(`SVG post-processing failed: ${(error as Error).message}`, { cause: error });
    }
  } else {
    await verifyPdf(path, plan);
  }
  return { repaired: false };
}
