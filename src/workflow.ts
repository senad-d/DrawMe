import type { DrawioInfo } from "./drawio";

/**
 * Maximum number of automatic source-correction retries across the visual
 * review. Pass inspection previews (the first preview of each review pass) do
 * not consume retries; one targeted edit → validation → replacement-preview
 * cycle consumes one.
 */
export const AUTOMATIC_CORRECTION_LIMIT = 8;

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
 * a gated multi-pass visual review, and autonomous final export — once
 * started, the run never pauses for human input. The review runs as fixed
 * passes (fit/sizing → element placement → connections → holistic typography,
 * semantics, and regression), each answering explicit questions on its own
 * preview and each required to be clean before the next starts. Findings go
 * into a numbered ledger naming the affected cells, and every fix must be
 * verified by comparing the replacement preview against the previous image
 * (verdict: fixed / not fixed / regressed) rather than by trusting the XML
 * edit. The CLI check result and the topic references are embedded, so no
 * upfront tool calls or file reads are needed; only the rarely needed
 * troubleshooting reference stays on-demand. The preview tool result states
 * whether the review image is attached, so the review instructions branch on
 * that signal rather than assuming vision.
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
    "5. **Visual review — three focused passes, then a holistic confirmation** — run this once authoring and validation are clean. Export previews with `drawio_export` mode `\"preview\"`; every preview renders a single page, so for a multi-page file, export one preview per page with `pageIndex` and review every page (page-suffixed names, e.g. `<name>.review-p2-fit.png`). The result text states whether the preview image is attached; follow the matching path:",
    "   - **Image attached** — run the four passes below in order. Do not start the next pass until every finding of the current one is verified **fixed** in a fresh render or explicitly accepted with a reason. For each pass: export its preview, write a structured critique that hunts for defects — do not summarize or admire the diagram — answer the pass's questions explicitly (a bare \"yes\" is not an answer; point at the evidence in the image), and record findings in one numbered ledger kept for the rest of the run: `F1, F2, …: pass / severity / affected cell ids / what is visibly wrong and where in the image / planned fix` (pick fixes from the defect→fix recipes in the XML authoring reference). The critique's job is to narrow every problem down to specific cells so the fix step can be surgical.",
    "     1. **Pass 1 — fit and sizing** (`<name>.review-fit.png`) answers: does the diagram fit its page, and does the canvas or any element need resizing? Hunt: content touching or crossing a page edge; one outer margin visibly thinner than the others; large empty regions or a page far larger than its content; elements too small for their labels — text touching or crossing its own shape border, clipped or mid-word truncated; a smallest label you cannot comfortably read at full-diagram scale (tighten the canvas with `drawio_fit_canvas`, split content across pages, or simplify the layout — never judge what you cannot read, and never treat \"too small to tell\" as a pass).",
    "     2. **Pass 2 — element placement** (`<name>.review-layout.png`) answers: is every element positioned correctly, and is there a visibly better arrangement? Hunt: shapes whose borders touch or overlap; two labels touching or overlapping each other; label text lying on top of any line or unrelated shape; rows/columns that drift out of alignment; uneven gaps between peers; children poking out of their container or crowding its title; related elements far apart while unrelated ones sit adjacent. Improve, not only repair: if moving an element would shorten edges, remove crossings, or make the arrangement symmetric, record that as a finding too.",
    "     3. **Pass 3 — connections** (`<name>.review-connectors.png`) answers: is every connection correct, cleanly routed, symmetric where the layout is symmetric, and anchored to the middle of the element side it faces wherever possible? Trace every edge from source to target and check it against the plan — right source, right target, right direction, right label. Hunt: an endpoint floating off its shape or plunging deep into it; an edge entering at an odd corner when a side-center anchor is available (pin `exitX`/`exitY`/`entryX`/`entryY` to the facing side's center, spreading evenly only when several edges share one side); mirrored branches routed asymmetrically; an arrowhead hidden by a shape or crushed into a bend; an edge passing through a shape it does not connect; parallel edges stacked on top of each other; an edge label sitting on its line so the text is struck through, or closer than about half a text-height to any line; crossings a reroute through a free corridor would remove.",
    "     4. **Pass 4 — typography, semantics, and regression** (`<name>.review.png`) is the holistic confirmation. Read every label word for word — a label you cannot fully read is itself a finding; check text contrast against fills; confirm every requested component and relationship is present, pointing the right way, with the right label; check hierarchy, grouping, and that legend entries match the colors actually used; apply the type's `Review:` checklist from the diagram-types reference; and re-check passes 1–3 for regressions. Retain this image (every page, for a multi-page file) for the final report.",
    "   - **Image NOT attached** — the current model cannot view images. Skip the visual passes: do not describe or judge renders; review structurally instead by cross-checking `drawio_validate` findings and a `drawio_explain` read-back against the user's request. Keep the latest `<name>.review.png` on disk so the user can view it, and state plainly in the summary that rendered inspection was skipped.",
    "6. **Fix and verify before the next pass** — resolve a pass's findings with targeted source edits: after each edit, validate, then re-export the same pass preview (for a multi-page file, the page the finding is on). The superseded preview file is deleted from disk, but its image is still visible earlier in this conversation: compare the new image against it at each addressed finding's location and record a verdict — **fixed** (the defect is gone in the new render), **not fixed** (still visible), or **regressed** (the edit introduced a new defect; log it as a new numbered finding). Never mark a finding fixed because the XML changed — only because the new image shows it fixed. When elements overlap, are cramped, clipped, or short on margin, never shrink or squeeze elements to fit the page — move them apart, then run `drawio_fit_canvas` to enlarge the canvas around them. A pass is complete only when all of its findings are fixed or explicitly accepted, and every pass must be complete before final export. If the correction limit is reached mid-pass, finish the remaining passes as inspection-only and report their findings as unresolved. Each successful preview export automatically removes the previous preview file for the same source, so only the latest review image remains.",
    `7. **Correction limit** — pass inspection previews (the first preview of each pass) do not count against the limit. Across the whole review, allow at most ${AUTOMATIC_CORRECTION_LIMIT} correction retries; one retry is one targeted source-edit → \`drawio_validate\` → replacement-preview cycle, whatever its verdict. Count retries explicitly. If the limit is reached with a finding unresolved, stop automatic editing, keep the best validated state, and continue to final export — name the unresolved finding, its pass, and its last verdict plainly in the final report instead of looping or waiting for input.`,
    "8. **No human gate** — the run is fully autonomous: once started, never pause to ask for approval, confirmation, or feedback. When pass 4 is clean (or the correction limit was reached), proceed directly to final export. If the user interrupts with feedback mid-run, append it to the ledger as new numbered findings: targeted edit, validate, before/after confirmation on the relevant pass preview, a fresh pass-4 holistic preview, then continue to export.",
    "9. **Final export** — immediately after pass 4 is clean (or the correction limit was reached), call `drawio_export` with `mode: \"final\"` for each requested format (default PNG; SVG/PDF/JPG on request). A final export also renders a single page: for a multi-page file, export each page with `pageIndex` and a distinct `output` per page and format. The first successful final export removes the one remaining latest preview for the same source; do not delete previews yourself or report it as a retained output. Report the `.drawio` source and every final path, retained reviewed warnings, any unresolved finding from the correction limit, and cleanup warnings. Offer `drawio_open` for fine-tuning afterwards.",
    "",
    "Failure handling: several DrawMe tools report failures as a text result beginning with `Export failed`, `Layout failed`, `Mermaid conversion failed`, `Fit canvas failed`, `Explain failed`, or `Open failed` rather than a tool error — always read the result text and treat those as failures. If export fails, read `" +
      refDir +
      "/troubleshooting.md` (the one reference kept on-demand). On draw.io below v30, use hand-authored XML instead of Mermaid conversion or ELK layout, but keep validation, the pass-based review, requested-format handling, and final cleanup unchanged.",
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
