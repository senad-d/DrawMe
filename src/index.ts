/**
 * DrawMe — a native Pi extension that turns natural-language descriptions into
 * `.drawio` diagrams and exports them to PNG/SVG/PDF/JPG via the draw.io desktop
 * CLI, including verified animated SVGs. It exposes the authoring workflow as plain commands and model-callable
 * tools.
 *
 * Tools:    drawio_check · drawio_export · drawio_animate · drawio_validate
 *           drawio_fit_canvas · drawio_from_mermaid · drawio_layout · drawio_shapesearch
 *           drawio_explain · drawio_open
 * Commands: /drawme · /drawme-check · /drawme-export
 */
import type { ExtensionAPI, ExtensionContext, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DOMParser } from "@xmldom/xmldom";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve, sep, win32 } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import {
  applyLayout,
  convertMermaid,
  exportDiagram,
  openFile,
  resolveBinary,
  type ExportFormat,
} from "./drawio";
import { diagramPages, pageModel, readDiagramXml } from "./diagram-files";
import type { DomEl } from "./dom";
import { readRasterFile } from "./png";
import { validateFile } from "./validate";
import { fitCanvasFile } from "./fitcanvas";
import { searchShapes } from "./shapesearch";
import { explainFile } from "./explain";
import { drawmeWorkflow, rendererStatus } from "./workflow";
import { animateDiagram } from "./animate";
import { MOTION_EFFECTS, readStoredMotion, SLIDE_DIRECTIONS } from "./motion";

const HERE = dirname(fileURLToPath(import.meta.url));
const REF_DIR = resolve(HERE, "..", "assets", "references");

const FORMAT = Type.Union([Type.Literal("png"), Type.Literal("svg"), Type.Literal("pdf"), Type.Literal("jpg")]);
const MODE = Type.Union([Type.Literal("preview"), Type.Literal("final")]);

const exportParams = Type.Object({
  input: Type.String({ description: "Path to the .drawio source file" }),
  format: Type.Optional(FORMAT),
  mode: Type.Optional(MODE),
  output: Type.Optional(Type.String({ description: "Output path; defaults next to the input" })),
  scale: Type.Optional(Type.Number({ description: "Raster scale for a final PNG/JPG (default 2)" })),
  width: Type.Optional(Type.Number({ description: "Target width in px; overrides scale. Raster limits can reduce it; previews cap both axes at 2000px. SVG padding is added separately." })),
  transparent: Type.Optional(Type.Boolean({ description: "Transparent background (PNG only)" })),
  border: Type.Optional(Type.Number({ description: "Outer margin in px around the content (default 40, matching drawio_fit_canvas)" })),
  pageIndex: Type.Optional(Type.Integer({ minimum: 1, description: "1-based page to export from a multi-page file" })),
  embed: Type.Optional(
    Type.Boolean({ description: "Embed diagram XML in final PNG/SVG/PDF (default on); never for previews or JPG" }),
  ),
  animated: Type.Optional(
    Type.Boolean({
      description:
        "Require a verified final animated SVG. Defaults format to SVG; preserves connector flow and compiles portable page fade/visibility/wait sequences.",
    }),
  ),
});
export type DrawioExportInput = Static<typeof exportParams>;

const motionStep = Type.Object({
  effect: Type.Union(MOTION_EFFECTS.map((effect) => Type.Literal(effect)), {
    description:
      "fadeIn/fadeOut/dim change opacity; popIn and slideIn reveal hidden shapes; drawIn draws a hidden solid connector from source to target; highlight glows a visible cell briefly; travel sends a dot along a visible connector; wait pauses",
  }),
  cells: Type.Optional(Type.Array(Type.String(), { description: "Cell ids the effect targets (not used by wait)" })),
  duration: Type.Optional(Type.Number({ description: "Effect length in ms; required for wait. Defaults: 500–1400 by effect" })),
  stagger: Type.Optional(Type.Number({ description: "Start offset in ms between consecutive cells of this step, for a cascade" })),
  parallel: Type.Optional(Type.Boolean({ description: "Start together with the previous step instead of after it" })),
  direction: Type.Optional(
    Type.Union(SLIDE_DIRECTIONS.map((direction) => Type.Literal(direction)), { description: "slideIn movement direction (default up)" }),
  ),
  color: Type.Optional(Type.String({ description: "Hex accent for highlight and travel (default #2563eb)" })),
  value: Type.Optional(Type.Number({ description: "Target opacity 0–1 for dim (default 0.25)" })),
});

const animateParams = Type.Object({
  input: Type.String({ description: "Path to the .drawio source file" }),
  steps: Type.Optional(
    Type.Array(motionStep, { description: "Motion steps in order. Omit to re-export the motion already stored on the page" }),
  ),
  loop: Type.Optional(Type.Boolean({ description: "Repeat the sequence (default true)" })),
  hold: Type.Optional(Type.Number({ description: "Pause in ms on the final state before a loop restarts (default 1600)" })),
  pageIndex: Type.Optional(Type.Integer({ minimum: 1, description: "1-based page to animate (default 1)" })),
  output: Type.Optional(Type.String({ description: "Animated SVG path (default <name>.animated.svg next to the input)" })),
  storyboard: Type.Optional(
    Type.Boolean({ description: "Render a persistent storyboard PNG next to the SVG, sampling up to 12 visual batches (default true)" }),
  ),
});

const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text }], details });

function sessionPath(path: string, ctx: ExtensionContext | undefined): string;
function sessionPath(path: string | undefined, ctx: ExtensionContext | undefined): string | undefined;
function sessionPath(path: string | undefined, ctx: ExtensionContext | undefined): string | undefined {
  if (!path) return path;
  const cwd = ctx?.cwd ?? process.cwd();
  if (process.platform === "win32") {
    // A single leading separator supplies a root but no drive/share. Resolve
    // that operand against the session, not the process's current drive.
    if (win32.isAbsolute(path) && win32.parse(path).root.length > 1) return path;
    const absolute = win32.resolve(cwd, path);
    return /[\\/]$/.test(path) && !absolute.endsWith(win32.sep) ? absolute + win32.sep : absolute;
  }
  // Don't collapse '..' across symlinked directories or drop a trailing separator.
  return isAbsolute(path) ? path : `${cwd.endsWith(sep) ? cwd : cwd + sep}${path}`;
}

function modelSupportsImages(ctx: ExtensionContext | undefined): boolean {
  const input = ctx?.model?.input;
  return Array.isArray(input) && input.includes("image");
}

async function verifiedImage(path: string, digest: string | undefined) {
  if (!digest) throw new Error("missing verified image digest");
  const png = await readRasterFile(path);
  if (createHash("sha256").update(png).digest("hex") !== digest) {
    throw new Error("the exported image changed after verification");
  }
  return { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" };
}

type PreviewReceipt = { source: string; pageIndex: number; sha256: string };
type SessionMessage = ProjectedSessionEntry["messages"][number];

function attachedPreview(message: SessionMessage) {
  if (message.role !== "toolResult" || message.toolName !== "drawio_export" || message.isError) return;
  const details = message.details as { error?: unknown; imageAttached?: boolean; previewReceipt?: Partial<PreviewReceipt> } | undefined;
  const receipt = details?.previewReceipt;
  if (details?.error !== undefined || details?.imageAttached !== true || !receipt ||
      typeof receipt.source !== "string" || typeof receipt.pageIndex !== "number" ||
      typeof receipt.sha256 !== "string" || !receipt.sha256) return;
  return { message, receipt };
}

function hasVisiblePreview(ctx: ExtensionContext | undefined, source: string, pageIndex: number): boolean {
  try {
    const pairs = ctx?.sessionManager?.buildSessionProjection().entries ?? [];
    for (const { sourceEntry, messages } of pairs) {
      if (sourceEntry.type !== "message") continue;
      const stored = attachedPreview(sourceEntry.message);
      if (!stored || stored.receipt.source !== source || stored.receipt.pageIndex !== pageIndex) continue;
      const original = stored.message.content.find((block) => block.type === "image" && block.data && block.mimeType);
      if (original?.type !== "image") continue;
      // Pi may have resized/re-encoded the original. Compare the projected
      // image to the stored attachment, not to its raw PNG export digest.
      for (const candidate of messages) {
        const projected = attachedPreview(candidate);
        if (projected && projected.message.toolCallId === stored.message.toolCallId &&
            projected.receipt.source === source && projected.receipt.pageIndex === pageIndex &&
            projected.receipt.sha256 === stored.receipt.sha256 &&
            projected.message.content.some((block) =>
              block.type === "image" && block.mimeType === original.mimeType && block.data === original.data)) return true;
      }
    }
  } catch {
    // Treat an unavailable projection like a session without a prior image.
  }
  return false;
}

const EXPORT_USAGE = "Usage: /drawme-export <file> [png|svg|animated-svg|pdf|jpg]. " +
  "animated-svg is for native draw.io sequences or connector flow. For stored DrawMe motion, call drawio_animate with the input file and omit steps.";

async function hasStoredFirstPageMotion(input: string): Promise<boolean> {
  const xml = await readDiagramXml(input);
  const root = new DOMParser({ onError: () => { throw new Error("input is not well-formed draw.io XML"); } })
    .parseFromString(xml, "text/xml").documentElement as unknown as DomEl | null;
  const first = root && diagramPages(root)[0];
  const model = first && pageModel(first);
  return Boolean(model && readStoredMotion(model)?.trim());
}

export default function drawme(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "drawio_check",
    label: "draw.io: check CLI",
    description:
      "Detect the draw.io desktop CLI: reports its binary path, version, and whether it supports Mermaid import and ELK layout. Call before exporting.",
    promptSnippet: "Check whether the draw.io CLI is available before exporting a diagram.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const info = await resolveBinary(undefined, signal);
      return textResult(rendererStatus(info), info);
    },
  });

  pi.registerTool({
    name: "drawio_export",
    label: "draw.io: export",
    description:
      "Export a .drawio file to PNG/SVG/PDF/JPG. Set animated:true for a verified final SVG from native page sequences or connector flow, or use drawio_animate for stored DrawMe motion. A preview PNG is unembedded and capped at 2000px on both axes. The result says whether a verified image is attached; compare only when the prior same-page image is still visible. Successful exports may retire files still owned by a tracked preview of the same source, including other pages. Final PNG/SVG/PDF are editable by default; JPG is not. Final rasters are subject to the pixel budget, SVG width excludes padding, and PDF retains the print page bounds.",
    promptSnippet:
      "Export a .drawio to PNG/SVG/PDF/JPG; set animated:true for a verified final animated SVG. Preview mode attaches a PNG for visual review when supported.",
    parameters: exportParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        signal?.throwIfAborted();
        const { format, mode, scale, width, transparent, border, pageIndex, embed, animated } = params;
        const input = sessionPath(params.input, ctx);
        const output = sessionPath(params.output, ctx);
        const canView = modelSupportsImages(ctx);
        // Remember the source identity before the render, but let exportDiagram
        // diagnose an invalid input. Only issue a receipt after checking it again.
        const source = mode === "preview" && canView ? await realpath(input).catch(() => undefined) : undefined;
        const r = await exportDiagram({ input, output, format, mode, scale, width, transparent, border, pageIndex, embed, animated, signal });
        const lines = [`Exported ${r.output}`, `format=${r.format} mode=${r.mode} embed=${r.embed} animated=${r.animated}`];
        if (r.animation) {
          lines.push(
            `Animation verified: ${r.animation.connectorFlows} connector flow(s), ${r.animation.sequenceSteps} page step(s)` +
              (r.animation.sequenceCompiled ? ` (${r.animation.sequenceDurationMs}ms sequence compiled)` : ""),
          );
        }
        if (r.repaired) lines.push("(repaired truncated -e PNG IEND chunk)");
        if (r.removedPreviews.length > 0) lines.push(`Removed preview artifact(s): ${r.removedPreviews.join(", ")}`);
        if (r.previewCleanupWarnings.length > 0) {
          lines.push(`Preview cleanup warning(s): ${r.previewCleanupWarnings.join("; ")}`);
        }
        const versionSuffix = r.version ? ` (${r.version})` : "";
        lines.push(`binary=${r.binary}${versionSuffix}`);
        if (r.mode === "preview" && r.format === "png") {
          if (canView) {
            const sha256 = r.previewSha256;
            if (!source || source !== await realpath(input)) throw new Error("the preview source could not be verified");
            if (!sha256) throw new Error("missing verified image digest");
            const image = await verifiedImage(r.output, sha256);
            const previewReceipt: PreviewReceipt = { source, pageIndex: pageIndex ?? 1, sha256 };
            lines.push(hasVisiblePreview(ctx, source, previewReceipt.pageIndex)
              ? "Preview image attached below. A prior preview for this page is still visible in this conversation: compare the images and record a verdict — fixed, not fixed, or regressed."
              : "Preview image attached below. Critique it against the current review pass's checklist before editing the source.");
            return {
              content: [{ type: "text" as const, text: lines.join("\n") }, image],
              details: { ...r, imageAttached: true, previewReceipt },
            };
          }
          lines.push(
            "Preview image NOT attached: the current model cannot view images or its image support is unknown. Do not judge the render; use drawio_validate and drawio_explain, and share the path for the user to view.",
          );
        }
        return textResult(lines.join("\n"), { ...r, imageAttached: false });
      } catch (e) {
        return textResult(`Export failed: ${(e as Error).message}`, { error: (e as Error).message, imageAttached: false });
      }
    },
  });

  pi.registerTool({
    name: "drawio_animate",
    label: "draw.io: animate",
    description:
      "Animate an existing .drawio page and export a verified standalone animated SVG with a reduced-motion fallback. Pass 1–200 ordered motion steps; hold, duration, and stagger are limited to 60000ms each and the pre-hold sequence to 300000ms. Cells whose first effect is an entrance start hidden. Valid motion is stored on the page root cell (a source edit); omit steps to re-export it. The optional persistent storyboard PNG samples up to 12 visual batches: parallel steps share a frame and standalone waits add no frame. It shows order and visibility, not playback, and is attached only if verified and the model supports images. Persistent flowAnimation connectors are kept. Effects play in browsers and SVG image embeds, not in draw.io itself.",
    promptSnippet:
      "Add motion to a .drawio page (draw-in connectors, pop/slide entrances, highlights, travelling dots, cascades) and export a verified animated SVG with a storyboard.",
    parameters: animateParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const { steps, loop, hold, pageIndex, storyboard } = params;
        const r = await animateDiagram({
          input: sessionPath(params.input, ctx), output: sessionPath(params.output, ctx),
          steps, loop, hold, pageIndex, storyboard, signal,
        });
        const playback = r.loop ? `loop every ${r.durationMs}ms` : "plays once";
        const lines = [
          `Animated ${r.output} (page '${r.page}')`,
          `Animation verified: ${r.steps} step(s), ${r.animatedCells} animated cell(s), ${r.drawnConnectors} drawn connector(s), ${r.travellingDots} travelling dot(s), ${r.connectorFlows} connector flow(s); sequence ${r.sequenceMs}ms, ${playback}`,
          r.saved
            ? `Stored the motion on the page root cell of ${r.source}. This is a source edit: run drawio_validate.`
            : `Re-used the motion stored in ${r.source}.`,
        ];
        let image: Awaited<ReturnType<typeof verifiedImage>> | undefined;
        if (r.storyboard) {
          const sampled =
            r.storyboardFramesTotal !== r.storyboardFrames ? ` (sampled from ${r.storyboardFramesTotal} visual batches)` : "";
          lines.push(`Storyboard: ${r.storyboard}, ${r.storyboardFrames} frame(s)${sampled}`);
          if (modelSupportsImages(ctx)) {
            try {
              image = await verifiedImage(r.storyboard, r.storyboardSha256);
              lines.push("Storyboard attached below. Check each frame's caption, order and visibility. This is not a playback check.");
            } catch {
              lines.push("Storyboard NOT attached: the exported image could not be verified");
            }
          } else {
            lines.push("Storyboard NOT attached: the current model cannot view images or its image support is unknown. Check the step order structurally instead.");
          }
        }
        const versionLabel = r.version ? ` (${r.version})` : "";
        lines.push(`binary=${r.binary}${versionLabel}`);
        const result = textResult(lines.join("\n"), { ...r, imageAttached: Boolean(image) });
        return image ? { ...result, content: [...result.content, image] } : result;
      } catch (e) {
        return textResult(`Animate failed: ${(e as Error).message}`, { error: (e as Error).message, imageAttached: false });
      }
    },
  });

  pi.registerTool({
    name: "drawio_validate",
    label: "draw.io: validate",
    description:
      "Structurally lint a .drawio file: errors for dangling endpoints, duplicate/reserved ids, broken parents, and missing/malformed vertex or edge geometry; actionable warnings for overlap, page/containment bounds, conservative readability defects, explicit routes through shapes or across edges, pinned anchors facing away from the next route direction, edge labels likely overlapping shapes, labels sitting on their own line, labels landing on a bend of their own connector or on another routed connector, and auto-routed edges (no waypoints) whose routing cannot be checked. Auto-routed edges whose direct path pierces a shape are called out as preview-review observations. Give every edge facing-side anchors and explicit waypoints so deterministic route checks engage. Reports observations and a readability score. Deterministic and does not launch draw.io. Compressed pages cannot be linted and are reported as skipped. Fix boundary/margin/empty-space warnings (and make room for overlapping elements) by spreading elements and running drawio_fit_canvas — never by shrinking content. Run after every source edit and before exporting.",
    promptSnippet: "Lint a .drawio after every source edit and before exporting.",
    parameters: Type.Object({ input: Type.String({ description: "Path to the .drawio file" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = await validateFile(sessionPath(params.input, ctx));
      const lines = [
        ...(r.incomplete ? ["Validation incomplete: treat this as blocking; do not preview or export."] : []),
        `Errors (${r.errors.length}):`,
        ...(r.errors.length > 0 ? r.errors.map((error) => `- ${error}`) : ["- none"]),
        `Actionable warnings (${r.warnings.length}):`,
        ...(r.warnings.length > 0 ? r.warnings.map((warning) => `- ${warning}`) : ["- none"]),
        `Informational observations (${r.observations.length}):`,
        ...(r.observations.length > 0 ? r.observations.map((observation) => `- ${observation}`) : ["- none"]),
        `Readability score: ${r.score.total} (route-through=${r.score.through}, crossings=${r.score.crossings}, overlaps=${r.score.overlaps}, anchors=${r.score.anchors}; lower is better for variants of this graph)`,
        `${r.errors.length} error(s), ${r.warnings.length} unresolved warning(s)`,
      ];
      return textResult(lines.join("\n"), r);
    },
  });

  pi.registerTool({
    name: "drawio_fit_canvas",
    label: "draw.io: fit canvas",
    description:
      "Resize each page's canvas to fit its content: sets pageWidth/pageHeight to the content bounding box plus a margin (default 40px) and shifts content so it starts exactly at that margin. Grows cramped pages and tightens oversized ones without changing element sizes or relative positions. Use when validation reports boundary, outer-margin, or empty-space warnings, or when elements need more room — spread elements apart, then fit the canvas; never shrink or cram elements to fit a page. Deterministic, no draw.io CLI. Skips compressed pages and intentional infinite canvases (page=\"0\"). Writes in place unless `output` is given; treat the result as a source edit and validate it.",
    promptSnippet:
      "Fit each page's canvas to its content plus a margin (default 40px) — enlarge the page instead of cramming elements; validate after.",
    parameters: Type.Object({
      input: Type.String({ description: "Path to the .drawio file" }),
      margin: Type.Optional(Type.Number({ description: "Outer margin in px between content and page edge (default 40)" })),
      output: Type.Optional(Type.String({ description: "Output path (default: overwrite the input)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const r = await fitCanvasFile({ input: sessionPath(params.input, ctx), margin: params.margin, output: sessionPath(params.output, ctx) });
        const lines = r.pages.map((page) => {
          if (page.status === "skipped") return `page '${page.page}': skipped (${page.reason ?? "unknown"})`;
          const beforeText =
            page.before?.width !== undefined && page.before?.height !== undefined
              ? `${page.before.width}x${page.before.height}`
              : "unset";
          const afterText = `${page.after!.width}x${page.after!.height}`;
          if (page.status === "unchanged") return `page '${page.page}': already fitted (${afterText})`;
          const shiftText =
            page.shift && (page.shift.dx !== 0 || page.shift.dy !== 0)
              ? `, content shifted by (${page.shift.dx}, ${page.shift.dy})`
              : "";
          return `page '${page.page}': ${beforeText} → ${afterText} (margin ${r.margin}px${shiftText})`;
        });
        lines.push(
          r.changed
            ? `Wrote ${r.output}. This is a source edit: run drawio_validate next, then re-export the preview.`
            : "No changes were needed.",
        );
        return textResult(lines.join("\n"), r);
      } catch (e) {
        return textResult(`Fit canvas failed: ${(e as Error).message}`, { error: (e as Error).message });
      }
    },
  });

  pi.registerTool({
    name: "drawio_from_mermaid",
    label: "draw.io: from Mermaid",
    description:
      "Convert Mermaid text to a native .drawio (structure + automatic layout) via the CLI. Best for standard diagram types with no custom styling. Requires draw.io v30.2.4 or later (check with drawio_check). Provide exactly one of `mermaid` (inline text) and `input` (a .mmd path).",
    promptSnippet: "Convert Mermaid text into a native .drawio with automatic layout (needs draw.io v30.2.4 or later).",
    parameters: Type.Object({
      mermaid: Type.Optional(Type.String({ description: "Inline Mermaid diagram text" })),
      input: Type.Optional(Type.String({ description: "Path to a .mmd file (alternative to `mermaid`)" })),
      output: Type.Optional(Type.String({ description: "Output .drawio path" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const r = await convertMermaid({
          mermaid: params.mermaid, input: sessionPath(params.input?.trim() ? params.input : undefined, ctx),
          output: sessionPath(params.output, ctx), cwd: ctx?.cwd,
        });
        const versionSuffix = r.version ? ` (${r.version})` : "";
        return textResult(`Converted Mermaid → ${r.output}\nbinary=${r.binary}${versionSuffix}`, r);
      } catch (e) {
        return textResult(`Mermaid conversion failed: ${(e as Error).message}`, { error: (e as Error).message });
      }
    },
  });

  pi.registerTool({
    name: "drawio_layout",
    label: "draw.io: auto-layout",
    description:
      "Re-place nodes and route edges on the first page using an ELK layout preset. Requires draw.io v30.2.4 or later. Writes a sibling <name>.layout.drawio by default (pass `output` to overwrite the input).",
    promptSnippet: "Auto-lay-out a large .drawio with an ELK preset (needs draw.io v30.2.4 or later).",

    parameters: Type.Object({
      input: Type.String({ description: "Path to the .drawio file" }),
      preset: Type.Union([
        Type.Literal("verticalFlow"),
        Type.Literal("horizontalFlow"),
        Type.Literal("verticalTree"),
        Type.Literal("horizontalTree"),
        Type.Literal("radialTree"),
        Type.Literal("organic"),
      ]),
      output: Type.Optional(Type.String({ description: "Output path (default: sibling .layout.drawio)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const r = await applyLayout({
          input: sessionPath(params.input, ctx),
          preset: params.preset,
          output: sessionPath(params.output, ctx),
        });
        return textResult(`Laid out (${r.preset}) → ${r.output}`, r);
      } catch (e) {
        return textResult(`Layout failed: ${(e as Error).message}`, { error: (e as Error).message });
      }
    },
  });

  pi.registerTool({
    name: "drawio_shapesearch",
    label: "draw.io: shape search",
    description:
      "Find the exact official draw.io style= string for a shape by keyword (e.g. 'aws lambda', 'uml actor', 'k8s pod'). Covers 10k+ AWS/Azure/GCP/Cisco/Kubernetes/UML/BPMN/network shapes from a bundled index. Use this instead of guessing a style= when a diagram needs a specific vendor or notation shape.",
    promptSnippet: "Look up the exact official style= string for a draw.io shape by keyword.",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords, e.g. 'aws lambda' or 'uml actor'" }),
      limit: Type.Optional(Type.Integer({ minimum: 0, description: "Max results (default 10)" })),
    }),
    async execute(_id, params) {
      try {
        const matches = searchShapes(params.query, params.limit);
        if (matches.length === 0) return textResult(`No shapes matched "${params.query}".`, { matches });
        const lines = matches.map((m) => `${m.title}  (${m.w}x${m.h})\n  ${m.style}`);
        return textResult(lines.join("\n"), { matches });
      } catch (e) {
        return textResult(`Shape search failed: ${(e as Error).message}`, { error: (e as Error).message });
      }
    },
  });

  pi.registerTool({
    name: "drawio_explain",
    label: "draw.io: explain",
    description:
      "Describe an existing .drawio as structured Markdown (components grouped by container, relations with edge-label verbs, per page). Useful for a README/PR summary or to read a diagram back before editing. No draw.io CLI needed. Compressed pages cannot be described.",
    promptSnippet: "Describe an existing .drawio as Markdown (components + relations).",
    parameters: Type.Object({ input: Type.String({ description: "Path to the .drawio file" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const md = await explainFile(sessionPath(params.input, ctx));
        return textResult(md, { markdown: md });
      } catch (e) {
        return textResult(`Explain failed: ${(e as Error).message}`, { error: (e as Error).message });
      }
    },
  });

  pi.registerTool({
    name: "drawio_open",
    label: "draw.io: open",
    description:
      "Open a .drawio source or a PNG, SVG, PDF, or JPEG export in the OS default application so the user can review it or fine-tune the source.",
    promptSnippet: "Open a .drawio or supported export in the desktop app.",
    parameters: Type.Object({ path: Type.String({ description: "Path to an existing diagram or supported export" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const path = sessionPath(params.path, ctx);
        const r = await openFile(path);
        return textResult(`Opened ${path} (${r.opener})`, r);
      } catch (e) {
        return textResult(`Open failed: ${(e as Error).message}`, { error: (e as Error).message });
      }
    },
  });

  pi.registerCommand("drawme", {
    description: "Generate a .drawio diagram from a natural-language description",
    handler: async (args, ctx) => {
      const desc = args.trim();
      if (!desc) {
        ctx.ui.notify("Usage: /drawme <description of the diagram to create>", "info");
        return;
      }
      const readReference = async (name: string): Promise<string | null> => {
        try {
          return await readFile(resolve(REF_DIR, name), "utf8");
        } catch {
          return null;
        }
      };
      const cli = await resolveBinary();
      pi.sendUserMessage(
        drawmeWorkflow(desc, REF_DIR, cli, {
          diagramTypes: await readReference("diagram-types.md"),
          xmlAuthoring: await readReference("xml-authoring.md"),
          stylePresets: await readReference("style-presets.md"),
          mermaidAuthoring: cli.available && cli.supportsMermaid ? await readReference("mermaid-authoring.md") : null,
        }),
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("drawme-check", {
    description: "Check whether the draw.io CLI is available",
    handler: async (_args, ctx) => {
      const info = await resolveBinary();
      ctx.ui.notify(rendererStatus(info), info.available ? "info" : "error");
    },
  });

  pi.registerCommand("drawme-export", {
    description: EXPORT_USAGE,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0 || parts.length > 2) {
        ctx.ui.notify(EXPORT_USAGE, "info");
        return;
      }
      const [file, requestedFormat = "png"] = parts;
      const animated = requestedFormat === "animated-svg";
      const format = animated ? "svg" : requestedFormat;
      if (!["png", "svg", "pdf", "jpg"].includes(format)) {
        ctx.ui.notify(EXPORT_USAGE, "info");
        return;
      }
      const input = sessionPath(file, ctx);
      try {
        if (animated && await hasStoredFirstPageMotion(input)) {
          throw new Error(`the first page has stored DrawMe motion. Call drawio_animate with input ${JSON.stringify(input)} and omit steps to reuse it.`);
        }
        const r = await exportDiagram({ input, format: format as ExportFormat, mode: "final", animated });
        let status = "";
        if (r.animation) status = " (animation verified)";
        else if (r.repaired) status = " (repaired PNG)";
        ctx.ui.notify(`Exported ${r.output}${status}`, "info");
      } catch (e) {
        ctx.ui.notify(`Export failed: ${(e as Error).message}` +
          (animated ? " The animated-svg command exports native draw.io sequences or connector flow only." : ""), "error");
      }
    },
  });
}
