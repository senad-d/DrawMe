# DrawMe Extension Reference

> Catalog of the commands and tools the DrawMe Pi extension provides, for any project or session that uses it.

DrawMe turns diagram requirements into editable `.drawio` sources and local PNG, SVG, PDF, or JPG exports, including verified standalone animated SVG. The extension provides commands that start guided workflows and tools for CLI detection, Mermaid conversion, XML layout, structural and animation validation, shape lookup, export, explanation, and file opening.

This document lists the extension's public surface: commands, tools, options, defaults, output behavior, and limitations. It is not a workflow guide — the `/drawme` command injects the full authoring workflow itself, and the registered tool descriptions carry the operational rules. The `.drawio` file is the source of truth; exports are derived artifacts. Relative paths resolve from the calling Pi session's working directory. Read tool results even when the call resolves normally: [some failures are returned as text](#functional-limitations).

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

DrawMe enables Mermaid conversion and ELK layout on draw.io 30.2.4 or newer. Older versions can still render ordinary exports.

On Linux, run Pi as an unprivileged user; DrawMe refuses to run the Linux renderer as root rather than disable its sandbox. Install Xvfb with `xvfb-run` for headless discovery and rendering. WSL requires a native Linux draw.io installation, not a Windows `.exe` reached through `/mnt/c`.

## Commands

Commands are user-facing shortcuts. Use the model-callable tools when you need explicit options or structured results.

| Command | Functionality |
| --- | --- |
| `/drawme <description>` | Starts the guided workflow: check, plan, author, validate, review (fit/sizing → element placement → connections → holistic confirmation), then export without waiting for approval. If Pi is busy, the request queues as a follow-up. The command checks the CLI and includes the diagram-types, XML-authoring, style-presets, and (when supported) Mermaid references in the workflow message. |
| `/drawme-check` | Displays the detected draw.io path and version and whether Mermaid conversion and ELK layout are supported, or reports why the CLI is unavailable. |
| `/drawme-export <file> [png\|svg\|animated-svg\|pdf\|jpg]` | Performs a final export of an existing `.drawio`; format defaults to PNG. `animated-svg` verifies native connector flow or a supported page sequence. |

`/drawme-export` intentionally exposes only the source path and format. Use `drawio_export` for output naming, dimensions, border, transparency, embedding, page selection, or animation mode. The command uses whitespace-separated arguments and is unsuitable for paths containing spaces. For stored DrawMe motion (`drawmeMotion`), call [`drawio_animate`](#drawio_animate) with `input` and no `steps`, for example `drawio_animate({ "input": "example/event-driven-orders.drawio" })`.

## Tools

DrawMe registers ten model-callable tools.

### `drawio_check`

Detects the draw.io desktop CLI, its version, and version-gated features.

This tool takes no arguments. All tools and commands share the same CLI discovery. To use a custom installation, set `DRAWME_DRAWIO_BINARY` to its absolute executable path in Pi's launch environment. DrawMe tries that path before the usual PATH and installation locations. Tool calls cannot choose an executable.

#### Result behavior

A successful result includes:

- `available: true`;
- resolved `binary` path or command;
- `version` and numeric `major` version;
- `supportsMermaid` and `supportsLayout` flags.

An unavailable result includes `available: false` and guidance that XML authoring can continue without export.

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
| `output` | string | No | Derived beside input | Explicit file path, not a directory. |
| `scale` | number | No | `2` | Requested scale for final PNG/JPG when `width` is absent; subject to the raster pixel budget. |
| `width` | number | No | Preview raster: bounded to `2000` per side | Requested width in pixels. Replaces raster `scale`, but not the size limits. SVG padding is added afterward. There is no public `height` option. |
| `transparent` | boolean | No | `false` | Enables transparency for PNG only. |
| `border` | number | No | `40` | Export margin; see format-specific sizing below. Use `0` for no added border. |
| `pageIndex` | integer | No | draw.io default | 1-based page number. Zero, fractions, and values beyond the source's page count are rejected. |
| `embed` | boolean | No | Mode/format dependent | Controls embedding of editable diagram XML. |
| `animated` | boolean | No | `false` | Requires and verifies standalone animation. Valid only for final SVG; when format is omitted, animated mode defaults it to SVG. |

#### Mode and naming behavior

For an input named `name.drawio`:

| Export | Default output | Raster sizing | Embedded XML |
| --- | --- | --- | --- |
| Preview PNG | `name.preview.png` | Long side at most 2000 px | No |
| Final PNG | `name.drawio.png` | Scale 2, subject to the pixel budget | Yes |
| Final SVG | `name.svg` | Vector, with added padding | Yes |
| Verified animated SVG (`animated:true`) | `name.svg` | Vector, with added padding | Yes |
| Final PDF | `name.pdf` | Authored print page | Yes |
| Final JPG | `name.jpg` | Scale 2, subject to the pixel budget | No |

Additional behavior:

- Other preview formats use the same `.preview` suffix before the format extension. If the default preview path is already in use by a file the current preview does not own, choose an explicit `output`. An explicit `output` replaces the derived name, but it must name a file and must not refer to the editable input, even through a link. A suffix that conflicts with `format` is rejected (`.jpg` and `.jpeg` both match `jpg`, case-insensitively). An extensionless file is allowed: `format: "pdf", output: "report"` writes a verified PDF to `report` without renaming it. DrawMe publishes new bytes only after rendering and verification succeed; a failed export leaves the existing destination intact.
- `animated:true` is valid only with `mode:"final"` and SVG. It rejects a static result instead of silently returning an ordinary SVG. Persistent `flowAnimation=1` connector motion is verified after draw.io renders it. Portable page-root visibility/opacity/fade/wait sequences are compiled into CSS inside the SVG and include a `prefers-reduced-motion` fallback that stops motion and reveals sequenced cells.
- Standalone page sequences support `opacity`, `show`, `hide`, `toggle`, `fadeIn`, `fadeOut`, `fadeTo`, `wait`, explicit cell/wildcard/exclusion selectors, loop control, and `immediate:true` parallel batches. Viewer-dependent wipe/pop, highlight, dynamic-flow, style, navigation, tag/layer, and link actions are rejected in animated SVG mode.
- **PNG and JPG:** Final rasters are limited to 6,000,000 pixels, including the border. A requested scale or explicit width can be reduced to fit that budget; output that still exceeds the limit is rejected. For scaled rasters, a 40-unit margin is about 80 px at scale 2 before any size reduction. PNG and JPG previews preserve aspect ratio and fit within 2000 × 2000 px, even with an explicit width. `scale` is ignored in preview mode and for vector formats.
- **SVG:** DrawMe renders without a border, then adds `border` pixels on each side. The requested width applies before padding: `width: 500, border: 40` gives about 580 px overall, allowing for renderer rounding. DrawMe pins SVG colors to the authored palette instead of letting the viewer's dark mode change them.
- **PDF:** The export retains the authored print-page bounds instead of cropping to the visible content. Raster scale and pixel-budget rules do not describe PDF page size.
- `transparent` has no effect outside PNG.
- Preview mode never embeds editable XML, even if `embed: true` is supplied. The tool attaches a verified PNG only if the current model declares image support; a text-only or unknown model receives text and the output path. An unreadable or changed attachment file produces a text-only `Export failed:` result rather than an image claim.
- Compare before and after only when the original attachment for the same source and page is still visible to the current model. If it was omitted, compacted away, replaced with text, or replaced with a different image, review the new preview on its own. A file on disk or an image visible in the transcript does not prove the model can see that attachment.
- Final exports stay text-only; final PNG, SVG, and PDF default to embedded/editable output.
- JPG cannot carry editable XML; final requests for editable JPG are rejected.
- DrawMe repairs a missing or truncated PNG end chunk only when the rest of the image is valid.
- Preview-file tracking is process-local and per source, not per page. A successful replacement preview can retire a tracked preview from another page, and final export can retire the remaining tracked preview. DrawMe removes only files it still owns; changed files and explicit preview symlinks and their targets are left alone during cleanup. Cleanup is best effort and warnings do not invalidate an export. Restarting Pi loses file tracking, so an old file can remain on disk. Retiring files does not remove images from Pi's transcript.

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

Use a distinct final `output` for each format or page you want to keep. Never present a preview as the final deliverable.

---

### `drawio_animate`

Adds or reuses stored DrawMe motion on an existing `.drawio` page and exports a verified standalone animated SVG with an optional storyboard PNG.

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `input` | string | Yes | — | Existing `.drawio` source path. |
| `steps` | array | No | Stored motion | Ordered motion steps (below). Omit to re-export the motion already stored on the page. |
| `loop` | boolean | No | `true` | Repeat the sequence. |
| `hold` | number | No | `1600` | Pause in ms on the final state before a loop restarts. |
| `pageIndex` | integer | No | `1` | 1-based page to animate. |
| `output` | string | No | `<source-stem>.animated.svg` | Animated SVG path. The implicit destination is the same for every page. |
| `storyboard` | boolean | No | `true` | Render a persistent review PNG beside the SVG; see naming below. |

A specification has 1–200 steps. Each step has an `effect` and, except for `wait`, a `cells` array of vertex or edge IDs. `duration` is at most 60,000 ms: visual effects require a positive duration, and a `wait` requires an explicit duration that can be zero. `stagger` (offset between consecutive cells) and `hold` each accept 0–60,000 ms. The sequence, including waits and stagger but before the final hold, cannot exceed 300,000 ms.

`parallel: true` starts a step in the same batch as the previous step. The batch ends when its longest step, including stagger, ends. Other optional fields: `direction` (`slideIn`: `up`, `down`, `left`, `right`), `color` (hex, for `highlight` and `travel`), and `value` (`dim` opacity, default 0.25).

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

- A cell whose first effect is an entrance (`fadeIn`, `popIn`, `slideIn`, `drawIn`) starts hidden. Use `fadeIn` to restore a visible but dimmed cell to full opacity. Repeated entrances on fully visible cells, emphasis on cells hidden by themselves or an ancestor, targeting the same cell twice in a parallel batch, `drawIn` on dashed or `flowAnimation=1` connectors, and missing or wrong-kind IDs are rejected before writing. The result must have effective visual motion; a wait-only or no-op sequence is not an animation by itself.
- Valid steps are stored as JSON in the `drawmeMotion` attribute of the page root cell (wrapping `<mxCell id="0"/>` in a `UserObject` when needed). This is a source edit; `drawio_validate` checks stored motion and reports a page that also has an enabled native page animation.
- The page is exported to an embedded SVG, then group opacity, transform, and glow become CSS keyframes, connector draw-in uses `pathLength` and `stroke-dashoffset`, and travelling dots use SMIL `animateMotion` along the rendered connector path. A `prefers-reduced-motion` rule shows the final state and hides dots. Persistent connector flow is preserved. A missing cell group or connector path fails before publication, leaving any previous SVG and preview intact.
- `highlight` and `travel` default to the theme accent: `#60a5fa` on a dark page `background`, `#2563eb` otherwise.
- The storyboard shows captioned end states of visual batches: parallel steps share a frame, and standalone waits advance time without adding frames. DrawMe samples at most 12 frames evenly, keeping the first and last. Highlight and travel steps show their accent on the stroke. Inspect the board for order and visibility, not easing or playback.
- The storyboard is a persistent, unembedded PNG, bounded to 2000 px on each side. DrawMe attaches it only for a model that declares image support and only if the file still matches the verified export digest. If verification fails, the result reports `Storyboard NOT attached: the exported image could not be verified`; this does not undo the export. The board is not tracked or retired as a preview.
- The motion plays in browsers and in SVGs embedded as images. draw.io itself does not play it.

#### Storyboard naming

The storyboard goes beside the resolved SVG. On page 1 only, if the SVG filename ends exactly in `.animated.svg`, replace that suffix with `.storyboard.png`. Otherwise append `.storyboard-p<n>.png` to the entire SVG filename, including its extension, where `n` is the 1-based page number.

| Source | Page | SVG filename | Storyboard filename |
| --- | --- | --- | --- |
| `map.svg.drawio` | 1 | `map.svg.animated.svg` (default) | `map.svg.storyboard.png` |
| `map.svg.drawio` | 2 | `map.svg.animated.svg` (default) | `map.svg.animated.svg.storyboard-p2.png` |
| `map.svg.drawio` | 2 | `map.svg` (explicit) | `map.svg.storyboard-p2.png` |

Pass distinct explicit `output` paths to keep the SVGs for multiple pages.

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

Structurally lints uncompressed `.drawio` XML without launching draw.io.

#### Options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `input` | string | Yes | Path to the `.drawio` file. |

#### Checks

Errors include:

- duplicate cell IDs;
- vertices or edges reusing reserved root IDs `0` or `1`;
- malformed XML, missing graph roots, references to missing parents, and parent cycles;
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
- auto-routed edges whose missing waypoints prevent deterministic route checks;
- compressed pages that cannot be inspected;
- legacy animation text, page effects, or selector types that cannot be represented in standalone animated SVG.

An unchecked auto-route warning means the renderer chose the path and validation could not inspect it. It is not a detected crossing. A straight line between the endpoints piercing an unrelated shape is a preview-review observation, not a claim about the actual route. Detected crossings on explicit routes are reported separately.

Informational observations also identify checks skipped for infinite canvases or missing or invalid page dimensions. Normal page diagnostics are page-specific. Content bounds include visible nodes and containers, nested offsets, floating edge terminals, explicit waypoints, and separately sized edge labels on resolvable explicit routes where practical.

The result text and details also include a readability score:

- route through vertex: 20 points;
- edge crossing: 10 points;
- overlap: 5 points;
- anchor facing away from its next route direction: 8 points.

Lower is better, but scores are meaningful only when comparing layout variants of the same graph. Canvas, containment, typography, and predicted auto-route observations do not affect the score. The text result separately reports error, unresolved-warning, and observation counts.

#### Use

Fix every error and rerun validation. Fix each warning or record an explicit reviewed-and-acceptable reason before final export. Informational observations do not require correction. Validation reads bounded regular XML files and limits the amount of work and retained findings. A limit stop keeps the findings already collected and reports validation as incomplete (`incomplete: true` in details) with a blocking error. Do not use an incomplete result as clearance to export.

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

Converts Mermaid into an automatically laid-out, editable native `.drawio`. Requires draw.io 30.2.4 or newer.

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `mermaid` | string | One of `mermaid`/`input` | — | Inline Mermaid text. A temporary `.mmd` is removed after conversion. |
| `input` | string | One of `mermaid`/`input` | — | Existing `.mmd` source path. |
| `output` | string | No | See below | Destination `.drawio` path. |

Output defaults:

- file input: same directory and stem with `.drawio`;
- inline Mermaid: `diagram.drawio` in the Pi session working directory.

Provide exactly one nonblank input: `mermaid` or `input`. The tool rejects both together or neither before conversion. Normally provide `output` explicitly to avoid ambiguous names or accidental replacement.

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

The conversion already lays out the graph. Never run `drawio_layout` afterward.

```text
drawio_from_mermaid({
  "mermaid": "flowchart LR\n  A[Client] --> B[API]\n  B --> C[(Database)]",
  "output": "request-flow.drawio"
})
```

Conversion creates a finite page. Run `drawio_fit_canvas` to fit it to the imported graph, then validate, preview, and export the resulting `.drawio`.

---

### `drawio_layout`

Repositions nodes and routes edges on the first page of an XML-authored `.drawio` using an allowlisted ELK preset. Layout preserves that page's display settings and leaves other pages unchanged. Requires draw.io 30.2.4 or newer.

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `input` | string | Yes | — | Existing `.drawio` source. |
| `preset` | layout preset | Yes | — | One of the six allowlisted values below. |
| `output` | string | No | `<name>.layout.drawio` | Destination path beside the input. May equal `input` for intentional in-place layout. |

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
| `limit` | integer | No | `10` | Maximum number of ranked results. Must be nonnegative; `0` returns none. |

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
- lists relations between existing endpoints, using a fallback for unlabeled cells;
- uses edge labels as relation verbs;
- produces a separate section for each page.

Use it to understand an existing diagram before editing, verify high-level structure, or create documentation text. It returns Markdown in the tool result but does not create a Markdown file.

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
| Standard diagram with no custom styling and CLI 30.2.4 or newer | Mermaid → `drawio_from_mermaid`. |
| Vendor icons, exact UML/BPMN notation, custom styling, swimlanes, containers, precise routing, or multi-page output | Hand-authored uncompressed XML plus `drawio_shapesearch`. |
| Large hand-authored graph and CLI 30.2.4 or newer | Rough XML → `drawio_layout`. |
| CLI unavailable or older than 30.2.4 | Hand-authored XML; validation and shape search remain available. |
| Existing diagram must be understood | `drawio_explain`, then inspect the source XML. |
| Existing diagram only needs validation | `drawio_validate`; no CLI check is necessary. |
| Existing diagram only needs export | `drawio_check` → `drawio_export`; do not rebuild it. |
| Diagram needs continuous or timed motion | Validate and review the static diagram first. Use `drawio_animate` for DrawMe motion, or `drawio_export` with `animated:true` for native connector flow and supported page sequences. |

DrawMe does not expose a single natural-language-to-file tool. Author or edit Mermaid/XML with normal file tools, then use DrawMe for conversion, layout, validation, rendering, explanation, or opening.

## Output and editability semantics

- `.drawio` is always the canonical editable source.
- Final PNG, SVG, and PDF embed XML by default and can be reopened in draw.io where supported.
- Verified animated SVG uses SVG animation rather than draw.io's network-loaded HTML viewer. An unresolved local image dependency prevents standalone verification. Provide a static PNG fallback for viewers that disable animation.
- JPG cannot embed XML.
- A preview is not a final deliverable or a persistent per-page history. See [export mode and naming](#mode-and-naming-behavior) for attachment, comparison, and file cleanup rules.
- A final embedded PNG normally uses the `.drawio.png` double extension.
- Multi-page exports should use `pageIndex` and explicit unique output names.
- `drawio_explain` returns Markdown as text; it does not write a documentation file.
- `drawio_layout` creates a sibling `.layout.drawio` unless `output` is supplied.
- Inline Mermaid conversion creates `diagram.drawio` in the working directory unless `output` is supplied.

## Functional limitations

- Validation cannot inspect compressed pages.
- Explanation cannot describe compressed pages.
- Deterministic validation cannot replace visual inspection; rendered clipping, wrapping, contrast, and automatic routes can only be judged from the preview image. When the current model cannot view images, these remain unverified and must be reported as such.
- Route-through and crossing analysis is limited to explicit routes. An unchecked auto-route warning calls for rendered review; it does not identify a detected crossing.
- Shape search covers bundled official draw.io shapes, not arbitrary third-party logos.
- Mermaid conversion cannot express all draw.io styles, containers, routing, or multi-page behavior.
- ELK layout accepts only the six registered presets; arbitrary JSON layouts are not exposed.
- Standalone animated SVG requires an uncompressed `.drawio` source and intentionally supports a portable subset of native page effects. It does not compile wipe/pop, highlight, dynamic-flow, style, navigation, tags/layers, links, or custom actions. Use persistent connector flow or visibility/opacity/fade/wait sequences.
- SVG hosts may sanitize styles or display only a static frame; retain the `.drawio` source and provide a PNG fallback when compatibility matters.
- Animation preview is structural: the attached review PNG is static. Final animated export verifies generated animation markup but does not attach temporal playback to the model for visual review.
- The extension does not expose GIF/video rendering, HTML viewers, XML compression/decompression, Python generators, or arbitrary draw.io CLI arguments.
- A failed operation can resolve with text starting with `Export failed:`, `Animate failed:`, `Fit canvas failed:`, `Mermaid conversion failed:`, `Layout failed:`, `Explain failed:`, or `Open failed:`. Treat those results as failures. For validation, check error and unresolved warning counts and whether the result is incomplete; a normal tool return is not proof of a valid diagram.

## Authoring references

Use these packaged references when additional notation or XML detail is needed:

- [`../assets/references/xml-authoring.md`](../assets/references/xml-authoring.md) — XML cells, containers, edges, palette, and spacing;
- [`../assets/references/diagram-types.md`](../assets/references/diagram-types.md) — notation-specific shapes and layout conventions;
- [`../assets/references/mermaid-authoring.md`](../assets/references/mermaid-authoring.md) — Mermaid syntax and conversion guidance;
- [`../assets/references/troubleshooting.md`](../assets/references/troubleshooting.md) — rendering and platform failure patterns.

Use the registered DrawMe tools and options documented here rather than invoking the draw.io CLI directly.
