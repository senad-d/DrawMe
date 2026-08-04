/**
 * Builds the message the `/drawme` command injects to drive the diagram
 * workflow. It steers the model through the skill's author→validate→preview→
 * self-check→final loop while pointing it at the DrawMe tools and the bundled,
 * network-free authoring references.
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
    "Produce a `.drawio` file and export it, following the workflow below. For anything that touches the draw.io CLI, use the DrawMe tools — do NOT shell out to `drawio` yourself. Everything runs locally; there is no network access.",
    "",
    "1. **Check** — call `drawio_check` once (note the version: v30+ unlocks Mermaid conversion and the auto-layout pass). If the CLI is unavailable, still author the `.drawio` XML, tell the user how to install draw.io / open the file, and skip the export + self-check steps.",
    "2. **Plan** — choose the diagram type, shapes, relationships, and layout direction (LR or TB). For a specific type (ERD, UML class, sequence, C4, architecture, ML/DL, flowchart, SysML, BPMN, network, swimlane), read `" +
      refDir +
      "/diagram-types.md`. If it is a standard type with no custom styling AND the CLI is v30+, prefer authoring concise **Mermaid** and converting it with `drawio_from_mermaid` (automatic layout, no hand-placed coordinates) — read `" +
      refDir +
      "/mermaid-authoring.md`.",
    "3. **Author** — for hand-written `.drawio` XML, first read `" +
      refDir +
      "/xml-authoring.md` (skeleton, cell/edge forms, containers, palette, spacing). Never reuse ids `0`/`1`; every edge `mxCell` needs a `<mxGeometry relative=\"1\" as=\"geometry\"/>` child; keep the XML uncompressed. When you need a specific vendor / UML / BPMN / cloud shape, call `drawio_shapesearch` for the exact `style=` instead of guessing. For large graphs (>~15 nodes) on v30+, hand-write the nodes then run `drawio_layout` rather than hand-placing coordinates. Write the file to the user's working directory unless they gave a path.",
    "4. **Validate** — call `drawio_validate` on the file and fix every reported error before exporting.",
    "5. **Preview & self-check** — call `drawio_export` with `mode: \"preview\"` (clean, width-capped PNG). Read the PNG with your own vision and fix obvious problems (overlaps, clipped labels, missing/stacked/crossing edges, off-canvas shapes) by editing the XML and re-previewing. Cap at 2 self-check rounds. If an export fails, read `" +
      refDir +
      "/troubleshooting.md`.",
    "6. **Review** — show the PNG to the user, apply targeted XML edits from their feedback, and re-preview until they approve.",
    "7. **Final export** — call `drawio_export` with `mode: \"final\"` for each requested format (default PNG; SVG/PDF/JPG on request). Report the `.drawio` source path and every exported file path, and offer to open the source in the desktop app with `drawio_open` for fine-tuning.",
  ].join("\n");
}
