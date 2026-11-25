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
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import {
  applyLayout,
  convertMermaid,
  exportDiagram,
  openFile,
  resolveBinary,
  type DrawioInfo,
  type ExportFormat,
} from "./drawio";
import { validateFile } from "./validate";
import { fitCanvasFile } from "./fitcanvas";
import { searchShapes } from "./shapesearch";
import { explainFile } from "./explain";
import { cliCapabilities, drawmeWorkflow } from "./workflow";
import { animateDiagram } from "./animate";
import { MOTION_EFFECTS, SLIDE_DIRECTIONS } from "./motion";
import { repairPngBuffer } from "./png";
import { checkRasterSize } from "./export-size";

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
  width: Type.Optional(Type.Number({ description: "Target width in px; overrides scale, subject to raster and preview size limits" })),
  transparent: Type.Optional(Type.Boolean({ description: "Transparent background (PNG only)" })),
  border: Type.Optional(Type.Number({ description: "Outer margin in px around the content (default 40, matching drawio_fit_canvas)" })),
  pageIndex: Type.Optional(Type.Integer({ minimum: 1, description: "1-based page to export from a multi-page file" })),
  embed: Type.Optional(
    Type.Boolean({ description: "Embed diagram XML for an editable output. Default: on for final PNG/SVG/PDF, off for preview" }),
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
    Type.Boolean({ description: "Render a PNG storyboard with up to 12 sampled visual-batch frames next to the SVG (default true)" }),
  ),
});

const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text }], details });

function sessionPath(path: string, ctx: ExtensionContext | undefined): string {
  const cwd = ctx?.cwd;
  if (!cwd || !path || isAbsolute(path)) return path;
  if (process.platform === "win32" && /^[a-z]:/i.test(path)) {
    if (path.slice(0, 2).toLowerCase() !== cwd.slice(0, 2).toLowerCase()) {
      throw new Error(`use an absolute path for a drive other than the session drive: ${path}`);
    }
    path = path.slice(2) || ".";
  }
  // Preserve trailing separators and let the filesystem resolve '..' across symlinked parents.
  return `${cwd}${cwd.endsWith(sep) || cwd.endsWith("/") ? "" : sep}${path}`;
}

function sessionPaths<T extends { input?: string; output?: string }>(opts: T, ctx: ExtensionContext | undefined): T {
  return {
    ...opts,
    input: opts.input === undefined ? undefined : sessionPath(opts.input, ctx),
    output: opts.output === undefined ? undefined : sessionPath(opts.output, ctx),
  };
}

function modelSupportsImages(ctx: ExtensionContext | undefined): boolean {
  return ctx?.model?.input?.includes("image") === true;
}

function hasComparablePreview(ctx: ExtensionContext | undefined, source: string, pageIndex: number): boolean {
  const session = ctx?.sessionManager;
  const messages = session?.buildSessionProjection?.().messages ??
    session?.getBranch?.().flatMap((entry) => entry.type === "message" ? [entry.message] : []) ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "toolResult" || message.toolName !== "drawio_export" || message.isError) continue;
    const details = message.details as { mode?: string; format?: string; source?: string; pageIndex?: number; imageAttached?: boolean } | undefined;
    if (details?.source !== source) continue;
    if (details.mode === "final") return false;
    if (details.mode === "preview" && details.pageIndex === pageIndex) {
      // Pi can resize a PNG attachment to JPEG in history without changing the PNG export receipt.
      return details.format === "png" && details.imageAttached === true &&
        message.content.some((block) => block.type === "image" && !!block.data &&
          (block.mimeType === "image/png" || block.mimeType === "image/jpeg"));
    }
  }
  return false;
}

async function readImage(path: string, mode: "preview" | "final", width?: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error(`attachment is not a regular file: ${path}`);
    const png = await file.readFile({ signal });
    repairPngBuffer(png, false, { preview: true, size: (w, h) => checkRasterSize({ input: path, width }, mode, w, h) });
    return { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" as const };
  } finally {
    await file.close();
  }
}

function receipt(text: string, details: object, image?: Awaited<ReturnType<typeof readImage>>) {
  const result = textResult(text, { ...details, imageAttached: image !== undefined });
  return { ...result, content: image ? [...result.content, image] : result.content };
}

function unavailableCli(info: DrawioInfo): string {
  return `draw.io CLI unavailable. ${info.reason ?? "Install with `brew install --cask drawio` (macOS) or from https://github.com/jgraph/drawio-desktop/releases."}`;
}

const COMMAND_ANIMATION_GUIDANCE =
  "animated-svg only supports native draw.io page sequences or connector flow. For stored DrawMe motion (drawmeMotion), use drawio_animate and omit steps.";
const EXPORT_COMMAND_USAGE = `Usage: /drawme-export <file> [png|svg|animated-svg|pdf|jpg]. ${COMMAND_ANIMATION_GUIDANCE}`;

export default function drawme(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "drawio_check",
    label: "draw.io: check CLI",
    description:
      "Detect the draw.io desktop CLI: returns its binary path, version, and support for Mermaid import and ELK layout (both need draw.io 30.2.4 or later). Call before exporting.",
    promptSnippet: "Check whether the draw.io CLI is available before exporting a diagram.",
    parameters: Type.Object({}),
    async execute() {
      const info = await resolveBinary();
      if (!info.available) {
        return textResult(
          `${unavailableCli(info)} You can still author .drawio XML without it.`,
          info,
        );
      }
      return textResult(
        `draw.io available: ${info.binary}\nversion: ${info.version ?? "unknown"}\n${cliCapabilities(info)}`,
        info,
      );
    },
  });

  pi.registerTool({
    name: "drawio_export",
    label: "draw.io: export",
    description:
      "Export a .drawio file to PNG/SVG/PDF/JPG via the draw.io CLI. Set animated:true for a verified final SVG: persistent flowAnimation connectors are preserved and portable page visibility/opacity/fade/wait sequences are compiled into standalone SVG CSS with a reduced-motion fallback. Animated export rejects static output and unsupported sequence effects. A successful mode:'preview' PNG is size-capped on both axes and never embedded; it is attached for visual review only when the current model supports images. The result states whether an image was attached. Compare only with a prior attached PNG of the same source and page in the current conversation. Successful previews and finals can retire superseded files still tracked and owned by previews of the same source. mode:'final' creates the deliverable (editable embedding by default except for JPG, with repair for a truncated embedded PNG tail). SVG output is pinned to the authored colors, including in dark-mode viewers.",
    promptSnippet:
      "Export a .drawio to PNG/SVG/PDF/JPG; set animated:true for a verified final animated SVG. Preview mode attaches a PNG for visual review when supported.",
    parameters: exportParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      let delivered: object | undefined;
      try {
        // Tool arguments can contain undeclared properties. Never forward internal options from them.
        const options = { ...sessionPaths(params, ctx), binary: undefined, height: undefined, signal };
        const r = await exportDiagram(options);
        const source = await realpath(options.input);
        const pageIndex = options.pageIndex ?? 1;
        const details = { ...r, source, pageIndex };
        delivered = { ...details, imageAttached: false };
        const image = r.mode === "preview" && r.format === "png" && modelSupportsImages(ctx)
          ? await readImage(r.output, "preview", options.width, signal) : undefined;
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
          if (!image) {
            lines.push(
              "Preview image NOT attached: the current model cannot view images or image support is unknown. Do not describe or judge the render; review structurally with drawio_validate and drawio_explain. Report the path only if the file still exists when you finish.",
            );
          } else if (hasComparablePreview(ctx, source, pageIndex)) {
            lines.push(
              "Preview image attached below. Compare it with the previous attached preview of this page in this conversation: record a verdict — fixed, not fixed, or regressed — for each finding you addressed before editing further.",
            );
          } else {
            lines.push("Preview image attached below. Critique it against the current review pass's checklist before editing the source.");
          }
        }
        return receipt(lines.join("\n"), details, image);
      } catch (e) {
        return textResult(`Export failed: ${(e as Error).message}`, { ...delivered, error: (e as Error).message });
      }
    },
  });

  pi.registerTool({
    name: "drawio_animate",
    label: "draw.io: animate",
    description:
      "Animate an existing .drawio page and export a verified standalone animated SVG. Pass ordered motion steps (fadeIn, fadeOut, dim, popIn, slideIn, drawIn, highlight, travel, wait) with cell ids, optional duration, stagger, parallel, direction, and color. Cells whose first effect is an entrance start hidden. The steps are validated against the page, stored on the page root cell (a source edit), compiled to CSS keyframes and SMIL connector dots with a reduced-motion fallback, and injected into a draw.io SVG export. Omit steps to re-export the stored motion after layout edits. By default a storyboard PNG shows up to 12 sampled visual-batch end states as captioned frames; parallel steps share a batch and standalone waits have no tile. It is attached when the model supports images. The storyboard is static: it proves order and visibility, not easing. Effects play in browsers and SVG image embeds; draw.io itself does not play them. Persistent flowAnimation connectors are kept. highlight and travel default to the page theme's accent, and the SVG keeps the authored theme colors in every viewer.",
    promptSnippet:
      "Add motion to a .drawio page (draw-in connectors, pop/slide entrances, highlights, travelling dots, cascades) and export a verified animated SVG with a storyboard.",
    parameters: animateParams,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const r = await animateDiagram({ ...sessionPaths(params, ctx), binary: undefined, signal });
        const image = r.storyboard && modelSupportsImages(ctx)
          ? await readImage(r.storyboard, "final", 2000, signal) : undefined;
        const playback = r.loop ? `loop every ${r.durationMs}ms` : "plays once";
        const lines = [
          `Animated ${r.output} (page '${r.page}')`,
          `Animation verified: ${r.steps} step(s), ${r.animatedCells} animated cell(s), ${r.drawnConnectors} drawn connector(s), ${r.travellingDots} travelling dot(s), ${r.connectorFlows} connector flow(s); sequence ${r.sequenceMs}ms, ${playback}`,
          r.saved
            ? `Stored the motion on the page root cell of ${r.source}. This is a source edit: run drawio_validate.`
            : `Re-used the motion stored in ${r.source}.`,
        ];
        if (r.storyboard) {
          const sampled =
            r.storyboardFramesTotal !== r.storyboardFrames ? ` (sampled from ${r.storyboardFramesTotal} visual batches)` : "";
          lines.push(`Storyboard: ${r.storyboard}, ${r.storyboardFrames} frame(s)${sampled}`);
          if (image) {
            lines.push(
              "Storyboard attached below. Check each frame's caption against the intended order: the right cells visible, hidden, dimmed, or accented at each step, and nothing appearing before what it depends on.",
            );
          } else {
            lines.push("Storyboard NOT attached: the current model cannot view images or image support is unknown. Check the step order structurally instead.");
          }
        }
        const versionLabel = r.version ? ` (${r.version})` : "";
        lines.push(`binary=${r.binary}${versionLabel}`);
        return receipt(lines.join("\n"), r, image);
      } catch (e) {
        return textResult(`Animate failed: ${(e as Error).message}`, { error: (e as Error).message });
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
        ...(r.incomplete ? ["Validation incomplete: partial results only; do not treat this diagram as clean."] : []),
        `Errors (${r.errors.length}):`,
        ...(r.errors.length > 0 ? r.errors.map((error) => `- ${error}`) : ["- none"]),
        `Actionable warnings (${r.warnings.length}):`,
        ...(r.warnings.length > 0 ? r.warnings.map((warning) => `- ${warning}`) : ["- none"]),
        `Informational observations (${r.observations.length}):`,
        ...(r.observations.length > 0 ? r.observations.map((observation) => `- ${observation}`) : ["- none"]),
        `${r.incomplete ? "Partial readability score" : "Readability score"}: ${r.score.total} (route-through=${r.score.through}, crossings=${r.score.crossings}, overlaps=${r.score.overlaps}, anchors=${r.score.anchors}${r.incomplete ? "" : "; lower is better for variants of this graph"})`,
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
        const r = await fitCanvasFile(sessionPaths(params, ctx));
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
      "Convert Mermaid text to a native .drawio (structure + automatic layout) via the CLI. Best for standard diagram types (flowchart, sequence, class, state, ER, gantt, mindmap) with no custom styling. Requires draw.io 30.2.4 or later (check with drawio_check). Provide exactly one of `mermaid` (inline text) or `input` (a .mmd path).",
    promptSnippet: "Convert Mermaid text into a native .drawio with automatic layout (needs draw.io 30.2.4 or later).",
    parameters: Type.Object({
      mermaid: Type.Optional(Type.String({ description: "Inline Mermaid diagram text" })),
      input: Type.Optional(Type.String({ description: "Path to a .mmd file (alternative to `mermaid`)" })),
      output: Type.Optional(Type.String({ description: "Output .drawio path" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const options = sessionPaths(params, ctx);
        const output = options.output ?? (options.input === undefined && ctx?.cwd ? sessionPath("diagram.drawio", ctx) : undefined);
        const r = await convertMermaid({ ...options, output, binary: undefined });
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
      "Re-place nodes and route edges in a .drawio using an ELK layout preset via the CLI — for large or graph-heavy diagrams you don't want to hand-place. Requires draw.io 30.2.4 or later. Writes a sibling <name>.layout.drawio by default (pass `output` to overwrite the input).",
    promptSnippet: "Auto-lay-out a large .drawio with an ELK preset (needs draw.io 30.2.4 or later).",
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
        const r = await applyLayout({ ...sessionPaths(params, ctx), binary: undefined });
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
    execute(_id, params) {
      const matches = searchShapes(params.query, params.limit ?? 10);
      if (matches.length === 0) return Promise.resolve(textResult(`No shapes matched "${params.query}".`, { matches }));
      const lines = matches.map((m) => `${m.title}  (${m.w}x${m.h})\n  ${m.style}`);
      return Promise.resolve(textResult(lines.join("\n"), { matches }));
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
          mermaidAuthoring: cli.supportsMermaid ? await readReference("mermaid-authoring.md") : null,
        }),
        { deliverAs: "followUp" },
      );
    },
  });

  pi.registerCommand("drawme-check", {
    description: "Check the draw.io CLI version and whether it supports Mermaid import and ELK layout",
    handler: async (_args, ctx) => {
      const info = await resolveBinary();
      ctx.ui.notify(
        info.available ? `draw.io ${info.version ?? "unknown"} — ${info.binary}\n${cliCapabilities(info)}` : unavailableCli(info),
        info.available ? "info" : "error",
      );
    },
  });

  pi.registerCommand("drawme-export", {
    description: `Export a .drawio file. ${EXPORT_COMMAND_USAGE}`,
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.ui.notify(EXPORT_COMMAND_USAGE, "info");
        return;
      }
      const [input, requestedFormat = "png"] = parts;
      const animated = requestedFormat === "animated-svg";
      const format = animated ? "svg" : requestedFormat;
      if (!["png", "svg", "pdf", "jpg"].includes(format)) {
        ctx.ui.notify(EXPORT_COMMAND_USAGE, "info");
        return;
      }
      try {
        const r = await exportDiagram({ input: sessionPath(input, ctx), format: format as ExportFormat, mode: "final", animated });
        let status = "";
        if (r.animation) status = " (animation verified)";
        else if (r.repaired) status = " (repaired PNG)";
        ctx.ui.notify(`Exported ${r.output}${status}`, "info");
      } catch (e) {
        ctx.ui.notify(`Export failed: ${(e as Error).message}${animated ? `\n${COMMAND_ANIMATION_GUIDANCE}` : ""}`, "error");
      }
    },
  });
}
