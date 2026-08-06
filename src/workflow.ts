/**
 * Maximum number of automatic source-correction retries across the visual
 * review. The initial critique pass and the final holistic confirmation do not
 * consume retries; one targeted edit → validation → replacement preview cycle
 * consumes one.
 */
export const AUTOMATIC_CORRECTION_LIMIT = 5;

/**
 * Builds the message the `/drawme` command injects to drive the diagram
 * workflow. It steers the model through authoring, deterministic validation,
 * a critique-first visual review, and autonomous final export — once started,
 * the run never pauses for human input. The preview tool result states
 * whether the review image is attached, so the review instructions branch on
 * that signal rather than assuming vision.
 * This message plus the registered tool descriptions are the complete
 * instructions; topic references under `refDir` are read on demand.
 */
export function drawmeWorkflow(description: string, refDir: string): string {
  const quoted = description.replaceAll("\n", "\n> ");
  return [
    "# DrawMe — create a diagram",
    "",
    "The user asked for this diagram:",
    "",
    `> ${quoted}`,
    "",
    "Produce a `.drawio` file and export it, following the workflow below. For anything that touches the draw.io CLI, use the DrawMe tools — do NOT shell out to `drawio` yourself.",
    "",
    "1. **Check** — call `drawio_check` once and note the version. v30+ unlocks Mermaid conversion and the auto-layout pass. If the CLI is unavailable, still author and validate the `.drawio` XML, tell the user how to install draw.io or open the source, and skip conversion, layout, previews, visual review, and exports.",
    "2. **Plan** — choose the diagram type, shapes, relationships, page/canvas dimensions, and layout direction (LR or TB). For a specific type (ERD, UML class, sequence, C4, architecture, ML/DL, flowchart, SysML, BPMN, network, swimlane), read `" +
      refDir +
      "/diagram-types.md`. If it is a standard type with no custom styling and the CLI is v30+, prefer concise Mermaid converted with `drawio_from_mermaid`; read `" +
      refDir +
      "/mermaid-authoring.md`.",
    "3. **Author** — for hand-written XML, first read `" +
      refDir +
      "/xml-authoring.md`. Keep XML uncompressed; never reuse ids `0`/`1`; give every edge `<mxGeometry relative=\"1\" as=\"geometry\"/>`; use `drawio_shapesearch` rather than guessing exact vendor/UML/BPMN/cloud styles. For large graphs (>~15 nodes) on v30+, hand-write nodes and use `drawio_layout`. Treat every write, edit, Mermaid conversion, and layout result as a source edit.",
    "4. **Validate after every source edit** — call `drawio_validate` immediately after authoring and after every later XML edit, Mermaid conversion, or layout operation. Fix all errors before previewing. Every warning must be either fixed or recorded explicitly as reviewed and acceptable with a reason; unresolved or unreviewed warnings block final export.",
    "5. **Visual review — critique before editing** — export one holistic preview to `<name>.review.png` with `drawio_export` mode `\"preview\"`. The result text states whether the preview image is attached; follow the matching path:",
    "   - **Image attached** — write a structured critique of the render before touching the source. Walk every category in this order and, for each one, either record findings as `category / severity / affected cell ids / fix` or state explicitly why it passes — never conclude the render is fine without walking all four:",
    "     1. **Canvas and composition**: page bounds, outer margins, clipping, excessive empty space, aspect ratio, major alignment, and overall balance.",
    "     2. **Nodes and typography**: shape overlap, label clipping/wrapping, readable font size, contrast, padding, sizing, and alignment. If the 2000px full-diagram preview makes labels unreadable, re-export a focused preview (`width`, `pageIndex`) rather than assuming the typography passes.",
    "     3. **Connectors**: endpoints, arrowheads, stacked lines, crossings, routes through unrelated elements, labels, and routing corridors.",
    "     4. **Semantics**: requested components and relationships, hierarchy, consistency, legends, and grouping.",
    "   - **Image NOT attached** — the current model cannot view images. Do not describe or judge renders; review structurally instead: cross-check `drawio_validate` findings and a `drawio_explain` read-back against the user's request. Keep the latest `<name>.review.png` on disk so the user can view it, and state plainly in the summary that rendered inspection was skipped.",
    "6. **Fix and confirm** — resolve critique findings with targeted source edits: after each edit, validate, then re-export a focused preview named for the affected category (`<name>.review-canvas.png`, `<name>.review-nodes.png`, `<name>.review-connectors.png`, or `<name>.review-semantics.png`) and confirm the fix. When no findings remain, re-export the holistic `<name>.review.png`, re-walk all four categories to confirm nothing regressed, and retain that image for the final report. Each successful preview export automatically removes the previous preview file for the same source, so only the latest review image remains.",
    `7. **Correction limit** — the initial critique pass and the final holistic confirmation do not count against the limit. Across the whole automatic review, allow at most ${AUTOMATIC_CORRECTION_LIMIT} correction retries; one retry is one targeted source-edit → \`drawio_validate\` → replacement-preview cycle. Count retries explicitly. If the limit is reached with a finding unresolved, stop automatic editing, keep the best validated state, and continue to final export — name the unresolved finding and its category plainly in the final report instead of looping or waiting for input.`,
    "8. **No human gate** — the run is fully autonomous: once started, never pause to ask for approval, confirmation, or feedback. When the holistic confirmation is clean (or the correction limit was reached), proceed directly to final export. If the user interrupts with feedback mid-run, treat it as new critique findings: targeted edit, validate, focused confirmation, fresh holistic preview, then continue to export.",
    "9. **Final export** — immediately after the holistic confirmation, call `drawio_export` with `mode: \"final\"` for each requested format (default PNG; SVG/PDF/JPG on request). The first successful final export removes the one remaining latest preview for the same source; do not delete previews yourself or report it as a retained output. Report the `.drawio` source and every final path, retained reviewed warnings, any unresolved finding from the correction limit, and cleanup warnings. Offer `drawio_open` for fine-tuning afterwards.",
    "",
    "Failure handling: several DrawMe tools report failures as a text result beginning with `Export failed`, `Layout failed`, `Mermaid conversion failed`, `Explain failed`, or `Open failed` rather than a tool error — always read the result text and treat those as failures. If export fails, read `" +
      refDir +
      "/troubleshooting.md`. On draw.io below v30, use hand-authored XML instead of Mermaid conversion or ELK layout, but keep validation, the critique-first review, requested-format handling, and final cleanup unchanged.",
  ].join("\n");
}
