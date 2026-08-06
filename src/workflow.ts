import type { DrawioInfo } from "./drawio";

/**
 * Maximum number of automatic source-correction retries across the visual
 * review. The initial critique pass and the final holistic confirmation do not
 * consume retries; one targeted edit → validation → replacement preview cycle
 * consumes one.
 */
export const AUTOMATIC_CORRECTION_LIMIT = 5;

/**
 * Reference file contents pre-loaded by the `/drawme` command handler so the
 * model starts with everything in context instead of reading files itself.
 * A null entry means the packaged file could not be read; the workflow then
 * falls back to a read-the-file instruction for that topic.
 */
export interface WorkflowReferences {
  diagramTypes: string | null;
  xmlAuthoring: string | null;
  /** Only provided when the CLI supports Mermaid conversion (v30+). */
  mermaidAuthoring: string | null;
}

function cliStatus(cli: DrawioInfo): string {
  if (!cli.available) {
    return (
      "1. **CLI status (already checked — do not call `drawio_check`)** — the draw.io CLI is NOT available. " +
      "Still author and validate the `.drawio` XML, tell the user how to install draw.io (macOS: `brew install --cask drawio`; other platforms: https://github.com/jgraph/drawio-desktop/releases) or open the source, and skip conversion, layout, previews, visual review, and exports."
    );
  }
  const features = cli.supportsMermaid
    ? "Mermaid conversion and the ELK auto-layout pass are available (v30+)."
    : "This is below v30: hand-author XML; Mermaid conversion and ELK auto-layout are NOT available.";
  return (
    `1. **CLI status (already checked — do not call \`drawio_check\`)** — draw.io ${cli.version ?? "?"} at \`${cli.binary ?? "?"}\`. ` +
    features
  );
}

function referenceSection(title: string, path: string, content: string | null): string[] {
  if (content === null) {
    return [`## Reference: ${title}`, "", `Could not be pre-loaded — read \`${path}\` before relying on it.`, ""];
  }
  return [`## Reference: ${title} (pre-loaded from \`${path}\`)`, "", content.trim(), ""];
}

/**
 * Builds the message the `/drawme` command injects to drive the diagram
 * workflow. It steers the model through authoring, deterministic validation,
 * a critique-first visual review, and autonomous final export — once started,
 * the run never pauses for human input. The CLI check result and the topic
 * references are embedded, so no upfront tool calls or file reads are needed;
 * only the rarely needed troubleshooting reference stays on-demand. The
 * preview tool result states whether the review image is attached, so the
 * review instructions branch on that signal rather than assuming vision.
 */
export function drawmeWorkflow(description: string, refDir: string, cli: DrawioInfo, refs: WorkflowReferences): string {
  const quoted = description.replaceAll("\n", "\n> ");
  const mermaidPlanning = refs.mermaidAuthoring !== null || cli.supportsMermaid
    ? " If it is a standard type with no custom styling, prefer concise Mermaid converted with `drawio_from_mermaid`; see the Mermaid authoring reference below."
    : "";
  return [
    "# DrawMe — create a diagram",
    "",
    "The user asked for this diagram:",
    "",
    `> ${quoted}`,
    "",
    "Produce a `.drawio` file and export it, following the workflow below. For anything that touches the draw.io CLI, use the DrawMe tools — do NOT shell out to `drawio` yourself. The references at the end of this message are already loaded: do not re-read those files.",
    "",
    cliStatus(cli),
    "2. **Plan** — choose the diagram type, shapes, relationships, and layout direction (LR or TB). Plan generous spacing (200–350px between shapes) and do NOT fix page dimensions up front: the canvas is fitted to the finished content later with `drawio_fit_canvas`. For a specific type (ERD, UML class, sequence, C4, architecture, ML/DL, flowchart, SysML, BPMN, network, swimlane), follow the diagram-types reference below." +
      mermaidPlanning,
    "3. **Author** — for hand-written XML, follow the XML authoring reference below. Keep XML uncompressed; never reuse ids `0`/`1`; give every edge `<mxGeometry relative=\"1\" as=\"geometry\"/>`; use `drawio_shapesearch` rather than guessing exact vendor/UML/BPMN/cloud styles. For large graphs (>~15 nodes) on v30+, hand-write nodes and use `drawio_layout`. Space elements generously rather than packing them, then run `drawio_fit_canvas` after authoring — and again after any Mermaid conversion or layout — so the page wraps the content with a comfortable margin. Treat every write, edit, Mermaid conversion, layout, and canvas-fit result as a source edit.",
    "4. **Validate after every source edit** — call `drawio_validate` immediately after authoring and after every later XML edit, Mermaid conversion, or layout operation. Fix all errors before previewing. Every warning must be either fixed or recorded explicitly as reviewed and acceptable with a reason; unresolved or unreviewed warnings block final export.",
    "5. **Visual review — critique before editing** — export one holistic preview to `<name>.review.png` with `drawio_export` mode `\"preview\"`. The result text states whether the preview image is attached; follow the matching path:",
    "   - **Image attached** — write a structured critique of the render before touching the source. Walk every category in this order and, for each one, either record findings as `category / severity / affected cell ids / fix` or state explicitly why it passes — never conclude the render is fine without walking all four:",
    "     1. **Canvas and composition**: page bounds, outer margins, clipping, excessive empty space, aspect ratio, major alignment, and overall balance.",
    "     2. **Nodes and typography**: shape overlap, label clipping/wrapping, readable font size, contrast, padding, sizing, and alignment. If the 2000px full-diagram preview makes labels unreadable, re-export a focused preview (`width`, `pageIndex`) rather than assuming the typography passes.",
    "     3. **Connectors**: endpoints, arrowheads, stacked lines, crossings, routes through unrelated elements, labels, and routing corridors.",
    "     4. **Semantics**: requested components and relationships, hierarchy, consistency, legends, and grouping.",
    "   - **Image NOT attached** — the current model cannot view images. Do not describe or judge renders; review structurally instead: cross-check `drawio_validate` findings and a `drawio_explain` read-back against the user's request. Keep the latest `<name>.review.png` on disk so the user can view it, and state plainly in the summary that rendered inspection was skipped.",
    "6. **Fix and confirm** — resolve critique findings with targeted source edits: after each edit, validate, then re-export a focused preview named for the affected category (`<name>.review-canvas.png`, `<name>.review-nodes.png`, `<name>.review-connectors.png`, or `<name>.review-semantics.png`) and confirm the fix. When elements overlap, are cramped, clipped, or short on margin, never shrink or squeeze elements to fit the page — move them apart, then run `drawio_fit_canvas` to enlarge the canvas around them. When no findings remain, re-export the holistic `<name>.review.png`, re-walk all four categories to confirm nothing regressed, and retain that image for the final report. Each successful preview export automatically removes the previous preview file for the same source, so only the latest review image remains.",
    `7. **Correction limit** — the initial critique pass and the final holistic confirmation do not count against the limit. Across the whole automatic review, allow at most ${AUTOMATIC_CORRECTION_LIMIT} correction retries; one retry is one targeted source-edit → \`drawio_validate\` → replacement-preview cycle. Count retries explicitly. If the limit is reached with a finding unresolved, stop automatic editing, keep the best validated state, and continue to final export — name the unresolved finding and its category plainly in the final report instead of looping or waiting for input.`,
    "8. **No human gate** — the run is fully autonomous: once started, never pause to ask for approval, confirmation, or feedback. When the holistic confirmation is clean (or the correction limit was reached), proceed directly to final export. If the user interrupts with feedback mid-run, treat it as new critique findings: targeted edit, validate, focused confirmation, fresh holistic preview, then continue to export.",
    "9. **Final export** — immediately after the holistic confirmation, call `drawio_export` with `mode: \"final\"` for each requested format (default PNG; SVG/PDF/JPG on request). The first successful final export removes the one remaining latest preview for the same source; do not delete previews yourself or report it as a retained output. Report the `.drawio` source and every final path, retained reviewed warnings, any unresolved finding from the correction limit, and cleanup warnings. Offer `drawio_open` for fine-tuning afterwards.",
    "",
    "Failure handling: several DrawMe tools report failures as a text result beginning with `Export failed`, `Layout failed`, `Mermaid conversion failed`, `Fit canvas failed`, `Explain failed`, or `Open failed` rather than a tool error — always read the result text and treat those as failures. If export fails, read `" +
      refDir +
      "/troubleshooting.md` (the one reference kept on-demand). On draw.io below v30, use hand-authored XML instead of Mermaid conversion or ELK layout, but keep validation, the critique-first review, requested-format handling, and final cleanup unchanged.",
    "",
    "---",
    "",
    "# Packaged references (pre-loaded — do not re-read these files)",
    "",
    ...referenceSection("diagram types", `${refDir}/diagram-types.md`, refs.diagramTypes),
    ...referenceSection("XML authoring", `${refDir}/xml-authoring.md`, refs.xmlAuthoring),
    ...(refs.mermaidAuthoring !== null || cli.supportsMermaid
      ? referenceSection("Mermaid authoring", `${refDir}/mermaid-authoring.md`, refs.mermaidAuthoring)
      : []),
  ].join("\n");
}
