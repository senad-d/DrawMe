/**
 * DrawMe — a native Pi extension that turns natural-language descriptions into
 * `.drawio` diagrams and exports them to PNG/SVG/PDF/JPG via the draw.io desktop
 * CLI. It exposes the skill's workflow as plain commands + tools instead of a
 * skill, and does zero network I/O (see the audit note in the README).
 *
 * Tools:    drawio_check · drawio_export · drawio_validate
 * Commands: /drawme · /drawme-check · /drawme-export
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
      "Export a .drawio file to PNG/SVG/PDF/JPG via the draw.io CLI. Use mode:'preview' for a clean, width-capped PNG to self-check with vision (never embedded), and mode:'final' for the deliverable (embedded editable output; the truncated -e PNG IEND chunk is auto-repaired). Runs entirely locally.",
    promptSnippet: "Export a .drawio to PNG/SVG/PDF/JPG (mode:'preview' for self-check, mode:'final' for the deliverable).",
    parameters: exportParams,
    async execute(_id, params) {
      try {
        const r = await exportDiagram(params as ExportOptions);
        const lines = [`Exported ${r.output}`, `format=${r.format} mode=${r.mode} embed=${r.embed}`];
        if (r.repaired) lines.push("(repaired truncated -e PNG IEND chunk)");
        const versionSuffix = r.version ? ` (${r.version})` : "";
        lines.push(`binary=${r.binary}${versionSuffix}`);
        return textResult(lines.join("\n"), r);
      } catch (e) {
        return textResult(`Export failed: ${(e as Error).message}`, { error: (e as Error).message });
      }
    },
  });

  pi.registerTool({
    name: "drawio_validate",
    label: "draw.io: validate",
    description:
      "Structurally lint a .drawio file: errors for dangling edge endpoints, duplicate/reserved ids, broken parents, and missing geometry; warnings for overlapping nodes, off-canvas shapes, and edges that route through shapes or cross each other. Deterministic and does not launch draw.io. Run before exporting.",
    promptSnippet: "Lint a .drawio for structural errors before exporting.",
    parameters: Type.Object({ input: Type.String({ description: "Path to the .drawio file" }) }),
    async execute(_id, params) {
      const r = await validateFile(params.input);
      const lines = [
        ...r.warnings.map((w) => `warning: ${w}`),
        ...r.errors.map((e) => `error: ${e}`),
        `${r.errors.length} error(s), ${r.warnings.length} warning(s)`,
      ];
      return textResult(lines.join("\n"), r);
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
      "Find the exact official draw.io style= string for a shape by keyword (e.g. 'aws lambda', 'uml actor', 'k8s pod'). Covers 10k+ AWS/Azure/GCP/Cisco/Kubernetes/UML/BPMN/network shapes. Use this instead of guessing a style= when a diagram needs a specific vendor or notation shape. Local index, no network.",
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
      "Describe an existing .drawio as structured Markdown (components grouped by container, relations with edge-label verbs, per page). Useful for a README/PR summary or to read a diagram back before editing. Pure-local, no draw.io CLI needed.",
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
      "Open a .drawio source or an exported file in the OS default application (draw.io desktop for .drawio) so the user can fine-tune it. Local action, no network.",
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
      pi.sendUserMessage(drawmeWorkflow(desc, REF_DIR));
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
