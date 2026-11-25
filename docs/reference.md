# DrawMe Extension Reference

> Catalog of the commands and tools the DrawMe Pi extension provides, for any project or session that uses it.

DrawMe turns diagram requirements into editable `.drawio` sources and local PNG, SVG, PDF, or JPG exports, including verified standalone animated SVG. The extension provides commands that start guided workflows and tools for CLI detection, Mermaid conversion, XML layout, structural and animation validation, shape lookup, export, explanation, and file opening.

This document lists the extension's public surface: commands, tools, options, defaults, output behavior, and limitations. It is not a workflow guide — the `/drawme` command injects the full authoring workflow itself, and the registered tool descriptions carry the operational rules. The `.drawio` file is the source of truth (exports are derived artifacts). Always read the result text: several tools [report failures there](#failure-results) rather than raising a tool-call error.

## Functional availability

| Functionality | draw.io CLI required | draw.io 30.2.4+ required |
| --- | --- | --- |
| Write or edit uncompressed `.drawio` XML with normal file tools | No | No |
| `drawio_validate` | No | No |
| `drawio_fit_canvas` | No | No |
| `drawio_shapesearch` | No | No |
| `drawio_explain` | No | No |
| `drawio_open` | No CLI check; requires an OS file handler | No |
| `drawio_export` | Yes | No |
| `drawio_animate` | Yes | No |
| `drawio_from_mermaid` | Yes | Yes |
| `drawio_layout` | Yes | Yes |

When the CLI is unavailable, you can still author, edit, validate, explain, and search for shapes. Skip conversion, layout, preview, and final export.

Mermaid conversion and ELK layout require draw.io 30.2.4 or later. A detected older CLI can still export without those features; explicit page selection requires 27.0.2 or later.

## Commands

Commands are user-facing shortcuts. Use the model-callable tools when you need explicit options or structured results. Relative input and output paths resolve from the calling Pi session's working directory, not Pi's process working directory. Absolute paths are used as given. Defaults described as siblings are derived beside the resolved input.

| Command | Functionality |
| --- | --- |
| `/drawme <description>` | Starts the autonomous workflow: check, plan, author, validate, review, and export, without a human approval gate. Visual review (fit/sizing → placement → connections → holistic confirmation) requires an attached image; otherwise review is structural. The command detects the CLI and loads the authoring references (including Mermaid when supported) before submitting the workflow. If Pi is busy, it queues the message as a follow-up. |
| `/drawme-check` | Displays the detected draw.io path, version, and whether Mermaid import and ELK layout are supported, or reports why the CLI is unavailable. |
| `/drawme-export <file> [png\|svg\|animated-svg\|pdf\|jpg]` | Performs a final export of an existing `.drawio`; format defaults to PNG. `animated-svg` verifies native draw.io page sequences or connector flow only. For stored DrawMe motion (`drawmeMotion`), use `drawio_animate` with `input` and omit `steps`. |

`/drawme-export` intentionally exposes only the source path and format. Use `drawio_export` for output naming, dimensions, border, transparency, embedding, page selection, or animation mode. The command uses whitespace-separated arguments and is unsuitable for paths containing spaces.

## Tools

DrawMe registers ten model-callable tools.

### `drawio_check`

Detects the draw.io desktop CLI, its version, and version-gated features.

This tool takes no arguments. All tools and commands share the same CLI discovery. To use a custom installation, set `DRAWME_DRAWIO_BINARY` to its absolute executable path in Pi's launch environment. DrawMe tries that path before the usual PATH and installation locations. Tool calls cannot choose an executable.

On Linux, run Pi and native Linux draw.io as an unprivileged user, with the renderer sandbox enabled. The same applies under WSL: a Windows draw.io executable is not a supported renderer there. On headless Linux, install Xvfb and make `xvfb-run` available on PATH; discovery and rendering use it automatically when no display is set.

#### Result behavior

A successful result includes:

- `available: true`;
- resolved `binary` path or command;
- `version` and numeric `major` version;
- `supportsMermaid` and `supportsLayout` flags.

An unavailable result includes `available: false`, a discovery diagnostic, and guidance that XML authoring can continue without export.

#### Use

Call once at the start of any workflow that may use conversion, layout, preview, or export.

```text
drawio_check({})
```

---

### `drawio_export`

Exports an existing `.drawio` through the local draw.io desktop CLI.

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `input` | string | Yes | — | Existing `.drawio` source path. |
| `format` | `png` \| `svg` \| `pdf` \| `jpg` | No | `png` | Output format. |
| `mode` | `preview` \| `final` | No | `final` | Selects inspection or deliverable defaults. |
| `output` | string | No | Derived beside input | Output file, not a directory. Its suffix must match `format` (`.jpg` or `.jpeg` for JPG). |
| `scale` | number | No | `2` | Requested positive scale for final PNG/JPG when `width` is absent, subject to the raster budget. |
| `width` | number | No | See sizing below | Target width in pixels. Overrides `scale`; `height` is not a public tool option. |
| `transparent` | boolean | No | `false` | Enables transparency for PNG only. |
| `border` | number | No | `40` | Nonnegative outer margin; how it contributes to the export size depends on the format and sizing mode. |
| `pageIndex` | integer | No | draw.io default | Positive, 1-based page number. Must exist in the source; explicit selection requires draw.io 27.0.2 or later. |
| `embed` | boolean | No | Mode/format dependent | Controls embedding of editable diagram XML. |
| `animated` | boolean | No | `false` | Requires and verifies standalone animation. Valid only for final SVG; when format is omitted, animated mode defaults it to SVG. |

#### Mode and naming behavior

See also [size and margins](#size-and-margins) and [preview review and cleanup](#preview-review-and-cleanup).

For an input named `name.drawio`:

| Export | Default output | Default sizing | Embedded XML by default |
| --- | --- | --- | --- |
| Preview PNG | `name.preview.png` | Long side at most 2000 px | No |
| Final PNG | `name.drawio.png` | Scale 2, capped | Yes |
| Final SVG | `name.svg` | Content bounds plus padding | Yes |
| Verified animated SVG (`animated:true`) | `name.svg` | Content bounds plus padding | Yes |
| Final PDF | `name.pdf` | PDF page bounds | Yes |
| Final JPG | `name.jpg` | Scale 2, capped | No |

Additional behavior:

- Other preview formats use the same `.preview` suffix before the format extension. If the default preview path is already occupied by a file the current preview does not own, choose an explicit `output`. The destination must not alias the editable input, even through a link. A successful export receipt names a regular file with bytes matching the requested format. DrawMe publishes only after rendering and verification succeed; failed or canceled renders do not replace an existing destination or retire previews.
- `animated:true` is valid only with `mode:"final"` and SVG. It rejects a static result instead of silently returning an ordinary SVG. Persistent `flowAnimation=1` connector motion is verified after draw.io renders it. Portable page-root visibility/opacity/fade/wait sequences are compiled into CSS inside the SVG and include a `prefers-reduced-motion` fallback that stops motion and reveals sequenced cells.
- Standalone page sequences support `opacity`, `show`, `hide`, `toggle`, `fadeIn`, `fadeOut`, `fadeTo`, `wait`, explicit cell/wildcard/exclusion selectors, loop control, and `immediate:true` parallel batches. Viewer-dependent wipe/pop, highlight, dynamic-flow, style, navigation, tag/layer, and link actions are rejected in animated SVG mode.
- Every SVG (static or animated) uses its authored colors: DrawMe resolves draw.io's `light-dark()` adaptive colors to the authored value and sets the SVG color scheme to `light`.
- `transparent` has no effect outside PNG. Preview mode never embeds editable XML, even with `embed: true`. Final PNG, SVG, and PDF default to embedding; final JPG rejects `embed: true` and is never editable. PNGs are checked before publication; only an otherwise valid embedded PNG with a missing or truncated IEND tail is repairable.

#### Size and margins

- **PNG/JPG:** The pixel budget is 6,000,000 pixels (width × height), including both margins on both axes. For measurable content, DrawMe lowers the final raster scale when necessary. For an explicit `width`, the target includes both margins, and DrawMe may reduce it to meet the applicable limits, preserving content aspect ratio. With scale sizing, the border is scaled too (40 units becomes about 80 px per side at scale 2 if the budget allows); with width or preview sizing, the border is in output pixels. DrawMe checks the rendered dimensions before publishing, including when it cannot measure the input bounds in advance.
- **Raster previews:** The long side is capped at 2000 px by default, or 2576 px with an explicit `width`. The area budget still applies to both portrait and landscape output. `scale` does not apply to previews.
- **SVG:** `width` targets the borderless native export, before padding. DrawMe adds `border` on both sides, so `width: 500` with `border: 40` yields about 580 px (for example 581 px with native rounding). Raster `scale` does not apply.
- **PDF:** The PDF retains the native page bounds (its media box) for a finite source page. Do not use `width`, `border`, or raster `scale` to request a tight crop or set the PDF page size; fit the source canvas first if a tighter page is needed.

#### Preview review and cleanup

A PNG preview result reports whether it attached an image. Attachment requires both a model known to accept image input and a successful read of the rendered file. A failed attachment read returns `Export failed:` with no image; a file may already have been published. Text-only or unknown models get no attachment. Final `drawio_export` results are text-only.

Compare only when the result identifies an actually attached prior preview of the same source and page on the current conversation branch. Record **fixed**, **not fixed**, or **regressed** for each addressed finding. Otherwise, critique the new attachment on its own. Without an attachment, use structural validation and explanation and report that visual inspection was skipped.

Earlier images can remain in Pi's transcript independently of the files on disk. Successful previews and final exports can retire older preview files (including explicit destinations) still owned and tracked by the current process, per source, not per page. Tracking does not survive a restart. Files edited or replaced since tracking are left alone; cleanup does not remove an explicit preview symlink or its target. Read the result for actual removals and warnings; do not assume any review file remains available.

#### Use

```text
# Inspection preview (image attached when the current model can view images)
drawio_export({ "input": "architecture.drawio", "mode": "preview" })

# Editable final SVG
drawio_export({
  "input": "architecture.drawio",
  "format": "svg",
  "mode": "final"
})

# Verified standalone animated SVG (format defaults to SVG)
drawio_export({
  "input": "request-flow.drawio",
  "mode": "final",
  "animated": true
})

# A specific page with an unambiguous path
drawio_export({
  "input": "system.drawio",
  "format": "pdf",
  "mode": "final",
  "pageIndex": 2,
  "output": "system-page-2.pdf"
})
```

Use a distinct `output` for each format or page. Never present a preview artifact as the final deliverable when a final export was requested. Do not manually delete review previews as part of the workflow; rely on the tool's cleanup receipts.

---

### `drawio_animate`

Adds motion to an existing `.drawio` page and exports a verified standalone animated SVG, plus an optional storyboard PNG. Requires draw.io 27.0.2 or later because it exports an explicit page.

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `input` | string | Yes | — | Existing `.drawio` source path. |
| `steps` | array | No | Stored motion | Ordered motion steps (below). Omit to re-export the motion already stored on the page. |
| `loop` | boolean | No | `true` | Repeat the sequence. |
| `hold` | number | No | `1600` | Pause in ms on the final state before a loop restarts. |
| `pageIndex` | integer | No | `1` | Positive, 1-based page to animate. |
| `output` | string | No | `name.animated.svg` | Animated SVG file path. |
| `storyboard` | boolean | No | `true` | Render a PNG storyboard; see naming below. |

Each step has an `effect` and, except for `wait`, a `cells` array of vertex or edge ids. Optional fields: `duration` (ms; required for `wait`), `stagger` (ms between consecutive cells), `parallel` (start with the previous step), `direction` (`slideIn`: `up`, `down`, `left`, `right`), `color` (hex, for `highlight` and `travel`), and `value` (`dim` opacity, default 0.25).

| Effect | Targets | Default duration | Result |
| --- | --- | --- | --- |
| `fadeIn` / `fadeOut` | any cell | 600 / 500 ms | Fade to visible / hidden |
| `dim` | any cell | 500 ms | Fade to `value` |
| `popIn` | hidden cell | 550 ms | Scale up from 60% with overshoot while fading in |
| `slideIn` | hidden cell | 650 ms | Move 32px in `direction` while fading in |
| `drawIn` | hidden solid connector | 900 ms | Draw the line, then show arrowhead and label |
| `highlight` | visible cell | 1000 ms | Brief glow and slight scale |
| `travel` | visible connector | 1400 ms | Dot runs from source to target |
| `wait` | — | required | Pause |

#### Behavior

- A sequence has 1–200 steps. `hold` and `stagger` can be 0–60,000 ms. Visual durations must be positive and at most 60,000 ms; `wait` requires a duration and may be zero. The sequence, including waits and stagger but before the loop hold, may last at most 300,000 ms. The same limits apply when overriding stored motion. Wait-only and other sequences with no effective visual motion are rejected before any source or output write.
- A cell whose first effect is an entrance (`fadeIn`, `popIn`, `slideIn`, `drawIn`) starts hidden in the animation. Do not set `visible="0"` to stage an entrance: the renderer can omit the cell. `fadeIn` can restore a dimmed cell to full opacity; a repeated entrance on a fully visible cell is an error. Reveal an animated ancestor before animating its children. Emphasis on hidden cells, duplicate targets in a parallel batch, `drawIn` on dashed or `flowAnimation=1` connectors, and missing or wrong-kind IDs are also rejected.
- Valid steps are stored as JSON in the `drawmeMotion` attribute of the page root cell (wrapping `<mxCell id="0"/>` in a `UserObject` when needed). This is a source edit. Use `drawio_validate` afterwards; do not combine stored motion with an enabled native page animation. Omitting `steps` reuses the stored sequence, with any supplied `loop` or `hold` override validated before saving.
- The embedded SVG uses CSS keyframes for opacity, transform, glow, and connector draw-in, and SMIL `animateMotion` for travelling dots. A `prefers-reduced-motion` rule shows the final state and hides dots. Persistent connector flow is preserved. Missing animated cell groups or connector paths fail verification. Both animated export routes refuse to publish an SVG with unresolved linked images; embed the images in the diagram and try again. An SVG verification failure leaves the previous SVG and previews intact but does not roll back any already-saved motion edit.
- `highlight` and `travel` default to the theme accent: `#60a5fa` on a dark page `background`, `#2563eb` otherwise.
- The storyboard shows a captioned end state for each sampled visual batch. Steps marked `parallel: true` share the previous batch (and tile); standalone waits affect timing but have no tile. If there are more than 12 visual batches, DrawMe samples evenly up to 12 frames, keeping the first and last. Use the board to check sampled order and visibility, not easing or playback. It is attached only for a model known to accept images and after a successful read.
- For page 1 at the default SVG path the storyboard is `<source-stem>.storyboard.png`; otherwise it is `<output>.page-<pageIndex>.board.png` alongside the SVG, including its full filename (for example `review.svg.page-2.board.png`). Use the returned storyboard path.
- Browsers can play the SVG motion, including when shown as an image. draw.io itself does not play DrawMe motion.

#### Use

```text
drawio_animate({
  "input": "checkout.drawio",
  "steps": [
    { "effect": "popIn", "cells": ["client"] },
    { "effect": "drawIn", "cells": ["e1"] },
    { "effect": "popIn", "cells": ["api", "db"], "stagger": 120 },
    { "effect": "travel", "cells": ["e1"] },
    { "effect": "highlight", "cells": ["api"] }
  ]
})

# Re-export the stored motion after editing the layout
drawio_animate({ "input": "checkout.drawio" })
```

---

### `drawio_validate`

Structurally lints uncompressed `.drawio` XML without launching draw.io. It accepts an `<mxfile>` page envelope, a single `<diagram>`, or a bare `<mxGraphModel>`. Input must be a regular file; the XML intake limit is 16 MiB.

#### Options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | string | Yes | Path to the `.drawio` file. |

#### Checks

Errors include:

- duplicate cell IDs;
- vertices or edges reusing reserved root IDs `0` or `1`;
- malformed XML, a missing graph root, references to missing parents, self-parenting, or longer containment cycles;
- edge references to missing sources or targets;
- missing or invalid vertex geometry;
- missing edge geometry, or edge geometry without both `relative="1"` and `as="geometry"`;
- malformed page-animation JSON, dangling/non-animatable animation cell references, invalid opacity/timing values, and invalid connector flow controls.

Actionable warnings include:

- non-positive vertex dimensions and negative vertex positions;
- overlapping sibling leaf vertices;
- visible children extending outside parent containers (relative ports and edge labels are excluded);
- content outside finite page boundaries or below the 20px minimum outer margin;
- a canvas conservatively detected as substantially larger than its visible content;
- very small explicit label fonts and long labels in narrow nodes without wrapping;
- explicitly waypointed edges routed through unrelated vertices or crossing one another;
- pinned source exits or target entries that face away from their adjacent waypoint, or their peer on an auto-route;
- edge labels likely overlapping shapes or sitting directly on their own connector;
- unchecked auto-routes: missing waypoints prevent deterministic route-through and crossing checks, so this warning does not mean a crossing was detected;
- compressed pages that cannot be inspected;
- legacy animation text, page effects, or selector types that cannot be represented in standalone animated SVG.

Informational observations identify checks intentionally skipped for infinite canvases or omitted/invalid page dimensions. They also flag an auto-routed edge when its predicted straight-line connection pierces an unrelated shape. This is a hint for preview review, not proof of the rendered route. Measured crossings and route-through findings use explicit routes. Content bounds account for visible nodes and containers, nested parent offsets, floating edge terminals, explicit waypoints, and separately sized edge labels on resolvable explicit routes where practical.

The result text and details also include a readability score:

- route through vertex: 20 points;
- edge crossing: 10 points;
- overlap: 5 points;
- anchor facing away from its next route direction: 8 points.

Lower is better, but compare only complete results from layout variants of the same graph. The score uses finding categories, not text: canvas, containment, typography, and predicted auto-route observations do not affect it. The result includes separate `errors`, `warnings`, and `observations` arrays and corresponding counts.

Validation checks up to 5,000 cells per page, with a work budget of 100,000 units and a diagnostic budget of 500 across the document. If the XML intake, cell, work, or diagnostic limit is exceeded, the result reports `incomplete: true`, retains any findings collected so far, and adds a blocking `Validation incomplete:` error. Do not treat a partial score as clean. Fix known errors and reduce or split the input into smaller diagrams, then validate again.

#### Use

Fix every error and rerun validation. Fix each warning or record an explicit reviewed-and-acceptable reason before final export. Informational observations do not require correction.

```text
drawio_validate({ "input": "architecture.drawio" })
```

Validation is structural rather than rendered. Its static typography checks are deliberately conservative: it cannot guarantee label fit, correct semantic content, valid rendering of a guessed shape, color contrast, visual balance, or clear auto-routed edges. It does not replace preview inspection when the current model can view images.

---

### `drawio_fit_canvas`

Resizes each page's canvas to its visible content plus an outer margin, without launching draw.io.

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `input` | string | Yes | — | Path to the `.drawio` file. |
| `margin` | number | No | `40` | Outer margin in px between content and page edge. |
| `output` | string | No | Overwrites `input` | Destination path. |

#### Behavior

Per page:

- computes the visible content bounding box (nested containers, floating edge terminals, explicit edge waypoints, and separately sized edge labels included);
- sets `pageWidth`/`pageHeight` to the content size plus twice the margin, honoring `pageScale`;
- shifts top-level content (absolute vertices, edge waypoints, floating edge endpoints) so the content origin lands exactly at the margin — children of containers and relative geometry move with their parents and are untouched;
- grows cramped pages and tightens oversized ones; element sizes and relative positions never change;
- skips compressed pages, intentional infinite canvases (`page="0"`), and pages without measurable content;
- reports old → new dimensions and any applied shift per page.

The result is a source edit: validate afterwards and re-export previews. Use it whenever content overflows the page, margins fall below the minimum, the canvas has excessive empty space, or elements need more room — spread elements apart and refit the canvas instead of shrinking content.

```text
drawio_fit_canvas({ "input": "architecture.drawio" })
drawio_fit_canvas({ "input": "architecture.drawio", "margin": 60 })
```

---

### `drawio_from_mermaid`

Converts Mermaid into an automatically laid-out, editable native `.drawio`. Requires draw.io 30.2.4 or later (`supportsMermaid` from `drawio_check`).

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `mermaid` | string | One of `mermaid`/`input` | — | Inline Mermaid text. A temporary `.mmd` is removed after conversion. |
| `input` | string | One of `mermaid`/`input` | — | Existing `.mmd` source path. |
| `output` | string | No | See below | Destination `.drawio` file, not a directory. |

Output defaults:

- file input: same directory and stem with `.drawio`;
- inline Mermaid: `diagram.drawio` in the Pi session's working directory.

Provide exactly one of `mermaid` (nonblank inline text) or `input` (an existing `.mmd` file). Providing both or neither fails before conversion. Normally provide `output` explicitly to avoid ambiguous names or accidental replacement.

#### Best use

Use for standard structure-first diagrams without precise draw.io styling requirements, including:

- flowcharts;
- sequence diagrams;
- class diagrams;
- state diagrams;
- ER diagrams;
- gantt charts;
- mind maps.

Do not choose Mermaid conversion when the requested artifact needs official vendor icons, exact UML/BPMN styles, custom containers or swimlanes, precise coordinates, explicit edge waypoints, or multi-page drill-down behavior.

Conversion already lays out the graph and makes the imported pages finite. Run `drawio_fit_canvas` to size them to their content and margins; no `drawio_layout` pass is needed.

```text
drawio_from_mermaid({
  "mermaid": "flowchart LR\n  A[Client] --> B[API]\n  B --> C[(Database)]",
  "output": "request-flow.drawio"
})
```

The converted file is a normal `.drawio` source: it can be validated, previewed, and exported like any other.

---

### `drawio_layout`

Repositions nodes and routes edges on the first page of an XML-authored `.drawio` using an allowlisted ELK preset. That page must be uncompressed; the tool does not skip ahead to another page. It changes geometry, preserving the authored page settings and leaving other pages unchanged. Requires draw.io 30.2.4 or later (`supportsLayout` from `drawio_check`).

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `input` | string | Yes | — | Existing `.drawio` source. |
| `preset` | layout preset | Yes | — | One of the six allowlisted values below. |
| `output` | string | No | `<name>.layout.drawio` | Destination file, not a directory. May equal `input` for intentional in-place layout. |

#### Presets

| Preset | Functionality |
| --- | --- |
| `verticalFlow` | Layered top-to-bottom process or pipeline layout. |
| `horizontalFlow` | Layered left-to-right process or pipeline layout. |
| `verticalTree` | Top-to-bottom hierarchy or org-chart layout. |
| `horizontalTree` | Left-to-right hierarchy layout. |
| `radialTree` | Tree arranged around a center. |
| `organic` | Force-directed network or mind-map-like layout. |

Use this tool for large or graph-heavy hand-authored XML, typically above approximately 15 nodes. Unknown presets are rejected because unsupported values can open a modal dialog and hang a headless process.

```text
drawio_layout({
  "input": "services-rough.drawio",
  "preset": "horizontalFlow",
  "output": "services.drawio"
})
```

After layout, treat the returned output path as the current source and validate it again. Do not apply this tool to Mermaid-converted diagrams.

---

### `drawio_shapesearch`

Searches a bundled local index of more than 10,000 official draw.io shapes.

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `query` | string | Yes | — | Shape keywords such as `aws lambda`, `uml actor`, `bpmn timer event`, or `k8s pod`. |
| `limit` | integer | No | `10` | Nonnegative maximum number of ranked results; `0` returns no matches. |

Each result contains:

- official shape title;
- exact draw.io `style=` string;
- recommended width and height.

Copy the selected style exactly and start with the returned dimensions. If the top result is not correct, search again with more specific vendor, notation, and component terms. The index contains official draw.io library shapes; it does not retrieve third-party logos.

```text
drawio_shapesearch({ "query": "aws lambda", "limit": 5 })
drawio_shapesearch({ "query": "bpmn exclusive gateway" })
```

---

### `drawio_explain`

Reads a `.drawio` and returns a structured Markdown description without launching draw.io.

#### Options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | string | Yes | Path to the `.drawio` file. |

The result:

- lists leaf components;
- groups components by named container;
- lists relations between existing endpoints, using a cell ID as a fallback for an unlabeled endpoint;
- uses edge labels as relation verbs;
- produces a separate section for each page.

Use it to understand an existing diagram before editing, verify high-level structure, or create documentation text. Diagram labels and page names are rendered as literal text in the Markdown result; the tool does not write a Markdown file.

Compressed pages cannot be explained.

```text
drawio_explain({ "input": "current-architecture.drawio" })
```

Explanation is a structural summary, not a validator and not a visual renderer.

---

### `drawio_open`

Opens a local diagram or export with the operating system's default application.

#### Options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | File to open. The resolved target must be a regular file with a `.drawio`, `.png`, `.svg`, `.pdf`, `.jpg`, or `.jpeg` extension (case-insensitive). |

Platform behavior:

- macOS: `open`;
- Windows: the system file-association helper, without `cmd.exe`;
- Linux: `xdg-open`.

Use it when the user requests desktop review or accepts an offer to fine-tune the source manually. Opening a document is a user-visible side effect.

```text
drawio_open({ "path": "architecture.drawio" })
```

## Authoring-mode selection

| Requirement | Recommended path |
| --- | --- |
| Standard diagram with no custom styling and Mermaid support | Mermaid → `drawio_from_mermaid`. |
| Vendor icons, exact UML/BPMN notation, custom styling, swimlanes, containers, precise routing, or multi-page output | Hand-authored uncompressed XML plus `drawio_shapesearch`. |
| Large hand-authored graph and ELK layout support | Rough XML → `drawio_layout`. |
| Mermaid/layout unavailable | Hand-authored XML; validation and shape search remain available. |
| Existing diagram must be understood | `drawio_explain`, then inspect the source XML. |
| Existing diagram only needs validation | `drawio_validate`; no CLI check is necessary. |
| Existing diagram only needs export | `drawio_check` → `drawio_export`; do not rebuild it. |
| Diagram needs continuous connector flow or a native draw.io page sequence | Author and validate the native animation → static PNG review → `drawio_export` with `animated:true`. |
| Diagram needs new or stored DrawMe motion | Author and review the static diagram → `drawio_animate`; omit `steps` to reuse stored motion. |

DrawMe does not expose a single natural-language-to-file tool. Author or edit Mermaid/XML with normal file tools, then use DrawMe for conversion, layout, validation, rendering, explanation, or opening.

## Output and editability semantics

- `.drawio` is always the canonical editable source.
- Final PNG, SVG, and PDF embed XML by default and can be reopened in draw.io where supported.
- Verified animated SVG is standalone: it uses SVG/CSS motion rather than draw.io's network-loaded HTML viewer. Connector flow is rendered by draw.io; portable page sequences are compiled after export. A static PNG fallback is recommended for reduced-motion users and consumers that sanitize SVG animation.
- JPG cannot embed XML.
- Preview PNG is an inspection artifact, not a deliverable. See [preview review and cleanup](#preview-review-and-cleanup) for attachment and file lifetime rules.
- A final embedded PNG normally uses the `.drawio.png` double extension.
- Multi-page exports should use `pageIndex` and explicit unique output names.
- `drawio_explain` returns Markdown as text; it does not write a documentation file.
- `drawio_layout` creates a sibling `.layout.drawio` unless `output` is supplied.
- Inline Mermaid conversion creates `diagram.drawio` in the Pi session's working directory unless `output` is supplied.

## Functional limitations

- Validation cannot inspect compressed pages.
- Explanation cannot describe compressed pages.
- Deterministic validation cannot replace visual inspection; rendered clipping, wrapping, contrast, and automatic routes can only be judged from the preview image. When the current model cannot view images, these remain unverified and must be reported as such.
- [Validation](#drawio_validate) reports unchecked auto-routes separately from measured crossings; it does not inspect draw.io's rendered automatic routes.
- Shape search covers bundled official draw.io shapes, not arbitrary third-party logos.
- Mermaid conversion cannot express all draw.io styles, containers, routing, or multi-page behavior.
- ELK layout accepts only the six registered presets; arbitrary JSON layouts are not exposed.
- Standalone animated SVG requires an uncompressed `.drawio` source and intentionally supports a portable subset of native page effects. It does not compile wipe/pop, highlight, dynamic-flow, style, navigation, tags/layers, links, or custom actions. Use persistent connector flow or visibility/opacity/fade/wait sequences.
- SVG hosts may sanitize styles or display only a static frame; retain the `.drawio` source and provide a PNG fallback when compatibility matters.
- Animation preview is structural: the attached review PNG is static. Final animated export verifies generated animation markup but does not attach temporal playback to the model for visual review.
- The extension does not expose GIF/video rendering, HTML viewers, XML compression/decompression, Python generators, or arbitrary draw.io CLI arguments.

## Failure results

Treat a text result starting with `Export failed:`, `Animate failed:`, `Fit canvas failed:`, `Layout failed:`, `Mermaid conversion failed:`, `Explain failed:`, or `Open failed:` as a failure, even if the call itself returned normally. Validation instead reports diagnostics and explicitly marks incomplete results. Check the result before claiming a file was delivered, an image was reviewed, or animation was verified.

## Authoring references

Use these packaged references when additional notation or XML detail is needed:

- [`../assets/references/xml-authoring.md`](../assets/references/xml-authoring.md) — XML cells, containers, edges, palette, and spacing;
- [`../assets/references/diagram-types.md`](../assets/references/diagram-types.md) — notation-specific shapes and layout conventions;
- [`../assets/references/mermaid-authoring.md`](../assets/references/mermaid-authoring.md) — Mermaid syntax and conversion guidance;
- [`../assets/references/troubleshooting.md`](../assets/references/troubleshooting.md) — rendering and platform failure patterns.

Use the registered DrawMe tools and options documented here rather than invoking the draw.io CLI directly.
