/**
 * Maximum number of automatic source-correction retries across all visual
 * quality passes. The five required inspection passes do not consume retries;
 * one targeted edit → validation → replacement preview cycle consumes one.
 */
export const AUTOMATIC_CORRECTION_LIMIT = 5;

/**
 * Builds the message the `/drawme` command injects to drive the diagram
 * workflow. It steers the model through authoring, deterministic validation,
 * focused visual quality passes, human approval, and final export.
 */
export function drawmeWorkflow(description: string, refDir: string, agentReferencePath: string): string {
  const quoted = description.replaceAll("\n", "\n> ");
  return [
    "# DrawMe — create a diagram",
    "",
    "The user asked for this diagram:",
    "",
    `> ${quoted}`,
    "",
    "Before starting, read `" +
      agentReferencePath +
      "`, the official DrawMe extension reference for agent behavior, tool options, decision rules, and limitations.",
    "",
    "Produce a `.drawio` file and export it, following the workflow below. For anything that touches the draw.io CLI, use the DrawMe tools — do NOT shell out to `drawio` yourself.",
    "",
    "1. **Check** — call `drawio_check` once and note the version. v30+ unlocks Mermaid conversion and the auto-layout pass. If the CLI is unavailable, still author and validate the `.drawio` XML, tell the user how to install draw.io or open the source, and skip conversion, layout, previews, visual quality passes, and exports.",
    "2. **Plan** — choose the diagram type, shapes, relationships, page/canvas dimensions, and layout direction (LR or TB). For a specific type (ERD, UML class, sequence, C4, architecture, ML/DL, flowchart, SysML, BPMN, network, swimlane), read `" +
      refDir +
      "/diagram-types.md`. If it is a standard type with no custom styling and the CLI is v30+, prefer concise Mermaid converted with `drawio_from_mermaid`; read `" +
      refDir +
      "/mermaid-authoring.md`.",
    "3. **Author** — for hand-written XML, first read `" +
      refDir +
      "/xml-authoring.md`. Keep XML uncompressed; never reuse ids `0`/`1`; give every edge `<mxGeometry relative=\"1\" as=\"geometry\"/>`; use `drawio_shapesearch` rather than guessing exact vendor/UML/BPMN/cloud styles. For large graphs (>~15 nodes) on v30+, hand-write nodes and use `drawio_layout`. Treat every write, edit, Mermaid conversion, and layout result as a source edit.",
    "4. **Validate after every source edit** — call `drawio_validate` immediately after authoring and after every later XML edit, Mermaid conversion, or layout operation. Fix all errors before previewing. Every warning must be either fixed or recorded explicitly as reviewed and acceptable with a reason; unresolved or unreviewed warnings block final export.",
    "5. **Run focused visual quality passes in order** — handle exactly one category at a time. For each pass: export its named PNG preview, inspect only that category and its acceptance checks, make targeted source edits if needed, validate, then replace/re-export that pass preview before advancing. Preview results include the image when supported; the reported path remains the fallback for text-only models or run modes. Each successful preview export automatically removes the previous preview file for the same source, so only the latest review image remains. Use these predictable outputs beside `<name>.drawio`:",
    "   1. **Canvas and composition** → `<name>.review-canvas.png`: page bounds, outer margins, clipping, excessive empty space, aspect ratio, major alignment, and overall balance.",
    "   2. **Nodes and typography** → `<name>.review-nodes.png`: shape overlap, label clipping/wrapping, readable font size, contrast, padding, sizing, and alignment. If a full-diagram 2000px preview makes labels unreadable, simplify, resize, split pages, or use a focused review rather than assuming the typography passes.",
    "   3. **Connectors** → `<name>.review-connectors.png`: endpoints, arrowheads, stacked lines, crossings, routes through unrelated elements, labels, and routing corridors.",
    "   4. **Semantics and final polish** → `<name>.review-semantics.png`: requested components and relationships, hierarchy, consistency, legends, grouping, and remaining regressions.",
    "   5. **Holistic regression check** → `<name>.review.png`: recheck every earlier category and confirm later fixes introduced no regression. This pass is mandatory after all focused passes and after any user-feedback edit; it is the one review image retained for approval.",
    `6. **Correction limit** — the five required inspection passes do not count against the limit. Across the whole automatic review, allow at most ${AUTOMATIC_CORRECTION_LIMIT} correction retries; one retry is one targeted source-edit → \`drawio_validate\` → replacement-preview cycle. Count retries explicitly. If the limit is reached with a finding unresolved, stop automatic editing, identify the failing category, ask for focused user feedback, and offer \`drawio_open\`; never loop indefinitely.`,
    "7. **Human review and approval** — present the final holistic preview plus validation status and any reviewed/accepted warning reasons. Apply user feedback as a targeted edit, validate it, rerun the affected focused pass, then rerun the holistic regression preview. Ask for and receive explicit user approval before any `mode: \"final\"` export.",
    "8. **Final export** — only after explicit approval, call `drawio_export` with `mode: \"final\"` for each requested format (default PNG; SVG/PDF/JPG on request). The first successful final export removes the one remaining latest preview for the same source; do not delete previews yourself or report it as a retained output. Report the `.drawio` source and every final path, retained reviewed warnings, and cleanup warnings. Offer `drawio_open` for fine-tuning.",
    "",
    "Failure handling: if export fails, read `" +
      refDir +
      "/troubleshooting.md`. On draw.io below v30, use hand-authored XML instead of Mermaid conversion or ELK layout, but keep validation, focused previews, approval, requested-format handling, and final cleanup unchanged.",
  ].join("\n");
}
