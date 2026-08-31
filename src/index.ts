/**
 * DrawMe — a native Pi extension that turns natural-language descriptions into
 * `.drawio` diagrams and exports them to PNG/SVG/PDF/JPG via the draw.io desktop
 * CLI. It exposes the authoring workflow as plain commands and model-callable
 * tools.
 *
 * Tools:    drawio_check · drawio_export · drawio_validate · drawio_fit_canvas
 *           drawio_from_mermaid · drawio_layout · drawio_shapesearch
 *           drawio_explain · drawio_open
 * Commands: /drawme · /drawme-check · /drawme-export
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import {
  applyLayout,
  convertMermaid,
  exportDiagram,
  openFile,
  resolveBinary,
  type ExportFormat,
  type ExportOptions,
  type LayoutPreset,
} from "./drawio";
import { validateFile } from "./validate";
import { fitCanvasFile } from "./fitcanvas";
import { searchShapes } from "./shapesearch";
import { explainFile } from "./explain";
import { drawmeWorkflow } from "./workflow";

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
  width: Type.Optional(Type.Number({ description: "Target width in px; overrides scale. Preview uses 2000" })),
  transparent: Type.Optional(Type.Boolean({ description: "Transparent background (PNG only)" })),
  border: Type.Optional(Type.Number({ description: "Border in px (default 10)" })),
  pageIndex: Type.Optional(Type.Number({ description: "1-based page to export from a multi-page file" })),
  embed: Type.Optional(
    Type.Boolean({ description: "Embed diagram XML for an editable output. Default: on for final PNG/SVG/PDF, off for preview" }),
  ),
  binary: Type.Optional(Type.String({ description: "Explicit path to the draw.io binary" })),
});
export type DrawioExportInput = Static<typeof exportParams>;

const textResult = (text: string, details: unknown = {}) => ({ content: [{ type: "text" as const, text }], details });

/**
 * Whether the active model accepts image blocks. Unknown models fail open
 * (attach the image) like Pi's built-in read tool; the provider layer replaces
 * unsupported images with a text placeholder, so failing open is always safe.
 */
function modelSupportsImages(ctx: ExtensionContext | undefined): boolean {
  return ctx?.model?.input.includes("image") ?? true;
}

async function exportResult(text: string, result: Awaited<ReturnType<typeof exportDiagram>>, attachImage: boolean) {
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/png" }
  )[] = [{ type: "text", text }];
  const imageAttached = result.mode === "preview" && result.format === "png" && attachImage;
  if (imageAttached) {
    const png = await readFile(result.output);
    content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  }
  return { content, details: { ...result, imageAttached } };
}

export default function drawme(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "drawio_check",
    label: "draw.io: check CLI",
    description:
      "Detect the draw.io desktop CLI: returns the binary path, version, and whether it supports Mermaid import / the --layout pass (both need v30+). Call before exporting.",
    promptSnippet: "Check whether the draw.io CLI is available before exporting a diagram.",
    parameters: Type.Object({ binary: Type.Optional(Type.String({ description: "Explicit binary path to test first" })) }),
    async execute(_id, params) {
      const info = await resolveBinary(params.binary);
      if (!info.available) {
        return textResult(
          "draw.io CLI not found. Install with `brew install --cask drawio` (macOS) or from " +
            "https://github.com/jgraph/drawio-desktop/releases. You can still author .drawio XML without it.",
          info,
        );
      }
      return textResult(
        `draw.io available: ${info.binary}\nversion: ${info.version} (major ${info.major})\n` +
          `Mermaid import / --layout: ${info.supportsMermaid ? "supported (v30+)" : "unsupported (needs v30+)"}`,
        info,
      );
    },
  });

  pi.registerTool({
    name: "drawio_export",
    label: "draw.io: export",
    description:
      "Export a .drawio file to PNG/SVG/PDF/JPG via the draw.io CLI. A successful mode:'preview' PNG is clean, width-capped, and never embedded; when the current model can view images it is attached to the tool result for visual review, and the result text always states whether it was attached. Each successful preview removes the prior preview artifact for the same source, leaving only the latest file; a replacement preview asks for a fixed/not-fixed/regressed verdict against the prior image. mode:'final' creates the deliverable (embedded editable output; truncated PNG IEND is repaired) and removes the remaining preview.",
    promptSnippet:
      "Export a .drawio to PNG/SVG/PDF/JPG (mode:'preview' attaches the review image when the current model can view images — the result text says so — and removes the previous preview file; mode:'final' creates the deliverable and cleans the remaining preview).",
    parameters: exportParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        const r = await exportDiagram(params as ExportOptions);
        const canView = modelSupportsImages(ctx);
        const lines = [`Exported ${r.output}`, `format=${r.format} mode=${r.mode} embed=${r.embed}`];
        if (r.repaired) lines.push("(repaired truncated -e PNG IEND chunk)");
        if (r.removedPreviews.length > 0) lines.push(`Removed preview artifact(s): ${r.removedPreviews.join(", ")}`);
        if (r.previewCleanupWarnings.length > 0) {
          lines.push(`Preview cleanup warning(s): ${r.previewCleanupWarnings.join("; ")}`);
        }
        const versionSuffix = r.version ? ` (${r.version})` : "";
        lines.push(`binary=${r.binary}${versionSuffix}`);
        if (r.mode === "preview" && r.format === "png") {
          if (!canView) {
            lines.push(
              "Preview image NOT attached: the current model cannot view images. Do not describe or judge the render; review structurally with drawio_validate and drawio_explain, and share the exported path so the user can view it.",
            );
          } else if (r.replacedPreview) {
            lines.push(
              "Preview image attached below. It replaces the previous preview, whose image is still visible earlier in this conversation: compare the two at each finding you addressed and record a verdict — fixed, not fixed, or regressed — before editing further.",
            );
          } else {
            lines.push("Preview image attached below. Critique it against the current review pass's checklist before editing the source.");
          }
        }
        return exportResult(lines.join("\n"), r, canView);
      } catch (e) {
        return textResult(`Export failed: ${(e as Error).message}`, { error: (e as Error).message });
      }
    },
  });

  pi.registerTool({
    name: "drawio_validate",
    label: "draw.io: validate",
    description:
      "Structurally lint a .drawio file: errors for dangling endpoints, duplicate/reserved ids, broken parents, and missing/malformed vertex or edge geometry; actionable warnings for overlap, page/containment bounds, conservative readability defects, explicit routes through shapes or across edges, edge labels likely overlapping shapes, labels sitting on their own line, and auto-routed edges (no waypoints) whose routing cannot be checked — give every edge pinned anchors and explicit waypoints so route checks engage. Reports observations and a readability score. Deterministic and does not launch draw.io. Compressed pages cannot be linted and are reported as skipped. Fix boundary/margin/empty-space warnings (and make room for overlapping elements) by spreading elements and running drawio_fit_canvas — never by shrinking content. Run after every source edit and before exporting.",
    promptSnippet: "Lint a .drawio after every source edit and before exporting.",
    parameters: Type.Object({ input: Type.String({ description: "Path to the .drawio file" }) }),
    async execute(_id, params) {
      const r = await validateFile(params.input);
      const lines = [
        `Errors (${r.errors.length}):`,
        ...(r.errors.length > 0 ? r.errors.map((error) => `- ${error}`) : ["- none"]),
        `Actionable warnings (${r.warnings.length}):`,
        ...(r.warnings.length > 0 ? r.warnings.map((warning) => `- ${warning}`) : ["- none"]),
        `Informational observations (${r.observations.length}):`,
        ...(r.observations.length > 0 ? r.observations.map((observation) => `- ${observation}`) : ["- none"]),
        `Readability score: ${r.score.total} (route-through=${r.score.through}, crossings=${r.score.crossings}, overlaps=${r.score.overlaps}; lower is better for variants of this graph)`,
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
    async execute(_id, params) {
      try {
        const r = await fitCanvasFile(params);
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
      "Convert Mermaid text to a native .drawio (structure + automatic layout) via the CLI. Best for standard diagram types (flowchart, sequence, class, state, ER, gantt, mindmap) with no custom styling. Requires draw.io v30+ (check with drawio_check). Provide `mermaid` (inline text) or `input` (a .mmd path).",
    promptSnippet: "Convert Mermaid text into a native .drawio with automatic layout (needs draw.io v30+).",
    parameters: Type.Object({
      mermaid: Type.Optional(Type.String({ description: "Inline Mermaid diagram text" })),
      input: Type.Optional(Type.String({ description: "Path to a .mmd file (alternative to `mermaid`)" })),
      output: Type.Optional(Type.String({ description: "Output .drawio path" })),
      binary: Type.Optional(Type.String({ description: "Explicit path to the draw.io binary" })),
    }),
    async execute(_id, params) {
      try {
        const r = await convertMermaid(params);
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
      "Re-place nodes and route edges in a .drawio using an ELK layout preset via the CLI — for large or graph-heavy diagrams you don't want to hand-place. Requires draw.io v30+. Writes a sibling <name>.layout.drawio by default (pass `output` to overwrite the input).",
    promptSnippet: "Auto-lay-out a large .drawio with an ELK preset (needs draw.io v30+).",
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
      binary: Type.Optional(Type.String({ description: "Explicit path to the draw.io binary" })),
    }),
    async execute(_id, params) {
      try {
        const r = await applyLayout({
          input: params.input,
          preset: params.preset as LayoutPreset,
          output: params.output,
          binary: params.binary,
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
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }),
    async execute(_id, params) {
      const matches = searchShapes(params.query, params.limit ?? 10);
      if (matches.length === 0) return textResult(`No shapes matched "${params.query}".`, { matches });
      const lines = matches.map((m) => `${m.title}  (${m.w}x${m.h})\n  ${m.style}`);
      return textResult(lines.join("\n"), { matches });
    },
  });

  pi.registerTool({
    name: "drawio_explain",
    label: "draw.io: explain",
    description:
      "Describe an existing .drawio as structured Markdown (components grouped by container, relations with edge-label verbs, per page). Useful for a README/PR summary or to read a diagram back before editing. No draw.io CLI needed. Compressed pages cannot be described.",
    promptSnippet: "Describe an existing .drawio as Markdown (components + relations).",
    parameters: Type.Object({ input: Type.String({ description: "Path to the .drawio file" }) }),
    async execute(_id, params) {
      try {
        const md = await explainFile(params.input);
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
      "Open a .drawio source or an exported file in the OS default application (draw.io desktop for .drawio) so the user can fine-tune it.",
    promptSnippet: "Open a .drawio or exported file in the desktop app.",
    parameters: Type.Object({ path: Type.String({ description: "File to open" }) }),
    async execute(_id, params) {
      try {
        const r = await openFile(params.path);
        return textResult(`Opened ${params.path} (${r.opener})`, r);
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
          mermaidAuthoring: cli.supportsMermaid ? await readReference("mermaid-authoring.md") : null,
        }),
      );
    },
  });

  pi.registerCommand("drawme-check", {
    description: "Check whether the draw.io CLI is available",
    handler: async (_args, ctx) => {
      const info = await resolveBinary();
      ctx.ui.notify(
        info.available ? `draw.io ${info.version} — ${info.binary}` : "draw.io CLI not found (macOS: brew install --cask drawio)",
        info.available ? "info" : "error",
      );
    },
  });

  pi.registerCommand("drawme-export", {
    description: "Export a .drawio file: /drawme-export <file> [png|svg|pdf|jpg]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.ui.notify("Usage: /drawme-export <file> [png|svg|pdf|jpg]", "info");
        return;
      }
      const [input, format = "png"] = parts;
      try {
        const r = await exportDiagram({ input, format: format as ExportFormat, mode: "final" });
        ctx.ui.notify(`Exported ${r.output}${r.repaired ? " (repaired PNG)" : ""}`, "info");
      } catch (e) {
        ctx.ui.notify(`Export failed: ${(e as Error).message}`, "error");
      }
    },
  });
}
