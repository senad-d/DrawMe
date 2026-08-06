# DrawMe Extension Reference

> Catalog of the commands and tools the DrawMe Pi extension provides, for any project or session that uses it.

DrawMe turns diagram requirements into editable `.drawio` sources and local PNG, SVG, PDF, or JPG exports. The extension provides commands that start guided workflows and tools for CLI detection, Mermaid conversion, XML layout, structural validation, shape lookup, export, explanation, and file opening.

This document lists the extension's public surface: commands, tools, options, defaults, output behavior, and limitations. It is not a workflow guide — the `/drawme` command injects the full authoring workflow itself, and the registered tool descriptions carry the operational rules. Two conventions apply everywhere: the `.drawio` file is the source of truth (exports are derived artifacts), and several tools report failures as a text result (`Export failed`, `Layout failed`, `Mermaid conversion failed`, `Explain failed`, `Open failed`) rather than a tool-call error, so results must always be read.

## Functional availability

| Functionality | draw.io CLI required | draw.io 30+ required |
| --- | --- | --- |
| Write or edit uncompressed `.drawio` XML with normal file tools | No | No |
| `drawio_validate` | No | No |
| `drawio_shapesearch` | No | No |
| `drawio_explain` | No | No |
| `drawio_open` | No CLI check; requires an OS file handler | No |
| `drawio_export` | Yes | No |
| `drawio_from_mermaid` | Yes | Yes |
| `drawio_layout` | Yes | Yes |

When the CLI is unavailable, you can still author, edit, validate, explain, and search for shapes. Skip conversion, layout, preview, and final export.

When the CLI is older than version 30, export remains available. Mermaid conversion and ELK layout do not.

## Commands

Commands are user-facing shortcuts. Use the model-callable tools when you need explicit options or structured results.

| Command | Functionality |
| --- | --- |
| `/drawme <description>` | Starts the full autonomous workflow: check, plan, author, validate, critique-first visual review, and final export — no human intervention once started. |
| `/drawme-check` | Displays the detected draw.io path and version, or reports that the CLI is unavailable. |
| `/drawme-export <file> [png\|svg\|pdf\|jpg]` | Performs a final export of an existing `.drawio`; format defaults to PNG. |

`/drawme-export` intentionally exposes only the source path and format. Use `drawio_export` for output naming, dimensions, border, transparency, embedding, page selection, or binary selection. The command uses whitespace-separated arguments and is unsuitable for paths containing spaces.

## Tools

DrawMe registers eight model-callable tools.

### `drawio_check`

Detects the draw.io desktop CLI, its version, and version-gated features.

#### Options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `binary` | string | No | Explicit binary path to test first. Standard platform candidates are tried afterward if it fails. |

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
drawio_check({ "binary": "/custom/path/to/drawio" })
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
| `output` | string | No | Derived beside input | Explicit output path. |
| `scale` | number | No | `2` | Scale for final PNG/JPG when `width` is absent. |
| `width` | number | No | Preview: `2000` | Target width in pixels. Overrides `scale`. |
| `transparent` | boolean | No | `false` | Enables transparency for PNG only. |
| `border` | number | No | `10` | Export border in pixels. Use `0` for no border. |
| `pageIndex` | number | No | draw.io default | Positive, 1-based page number for multi-page files. |
| `embed` | boolean | No | Mode/format dependent | Controls embedding of editable diagram XML. |
| `binary` | string | No | Auto-detected | Explicit binary path to test first. |

#### Mode and naming behavior

For an input named `name.drawio`:

| Export | Default output | Raster sizing | Embedded XML |
| --- | --- | --- | --- |
| Preview PNG | `name.png` | Width 2000 | No |
| Final PNG | `name.drawio.png` | Scale 2 | Yes |
| Final SVG | `name.svg` | Vector | Yes |
| Final PDF | `name.pdf` | Vector | Yes |
| Final JPG | `name.jpg` | Scale 2 | No |

Additional behavior:

- An explicit `output` replaces the derived name.
- An explicit `width` replaces raster scaling.
- `scale` is ignored in preview mode and for vector formats.
- `transparent` has no effect outside PNG.
- Preview mode defaults to unembedded output suitable for visual inspection. When the current model can view images, a successful PNG preview tool result contains its normal text/metadata block followed by an `image/png` base64 image block; otherwise the image is omitted. The result text always states which case applies, and the output path in the text stays usable either way.
- Final exports stay text-only; final PNG, SVG, and PDF default to embedded/editable output.
- JPG cannot carry editable XML; never set `embed: true` for JPG.
- Embedded PNG exports are checked for draw.io's known truncated IEND chunk and repaired automatically when necessary.
- Every successful preview output is tracked, including explicit `output` paths. After a replacement preview exists, the tool automatically removes the previous preview file for the same source, so only the latest artifact remains. The first successful final export removes that remaining preview. Cleanup failures are returned as warnings without invalidating the new export.
- Headless Linux handling is automatic, including `xvfb-run`, GPU disabling, and the root sandbox flag.

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

# A specific page with an unambiguous path
drawio_export({
  "input": "system.drawio",
  "format": "pdf",
  "mode": "final",
  "pageIndex": 2,
  "output": "system-page-2.pdf"
})
```

Use a distinct `output` for each format or page. Never present a preview artifact as the final deliverable when a final export was requested. Do not manually delete superseded or final-review previews; the tool replaces and cleans them automatically.

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
- references to missing parents;
- edge references to missing sources or targets;
- missing or invalid vertex geometry;
- missing edge geometry, or edge geometry without both `relative="1"` and `as="geometry"`.

Actionable warnings include:

- non-positive vertex dimensions and negative vertex positions;
- overlapping sibling leaf vertices;
- visible children extending outside parent containers (relative ports and edge labels are excluded);
- content outside finite page boundaries or below the 20px minimum outer margin;
- a canvas conservatively detected as substantially larger than its visible content;
- very small explicit label fonts and long labels in narrow nodes without wrapping;
- explicitly waypointed edges routed through unrelated vertices or crossing one another;
- compressed pages that cannot be inspected.

Informational observations identify checks intentionally skipped for infinite canvases or omitted/invalid page dimensions. All normal-page diagnostics are page-specific. Content bounds account for nested container offsets, visible nodes/containers, explicit waypoints, and separately sized edge labels on resolvable explicit routes where practical.

The result text and details also include a readability score:

- route through vertex: 20 points;
- edge crossing: 10 points;
- overlap: 5 points.

Lower is better, but scores are meaningful only when comparing layout variants of the same graph. Canvas, containment, and typography warnings do not change this established score. The text result separately reports error, unresolved-warning, and observation counts.

#### Use

Fix every error and rerun validation. Fix each warning or record an explicit reviewed-and-acceptable reason before final export. Informational observations do not require correction.

```text
drawio_validate({ "input": "architecture.drawio" })
```

Validation is structural rather than rendered. Its static typography checks are deliberately conservative: it cannot guarantee label fit, correct semantic content, valid rendering of a guessed shape, color contrast, visual balance, or clear auto-routed edges. It does not replace preview inspection when the current model can view images.

---

### `drawio_from_mermaid`

Converts Mermaid into an automatically laid-out, editable native `.drawio`. Requires draw.io 30 or newer.

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `mermaid` | string | One of `mermaid`/`input` | — | Inline Mermaid text. A temporary `.mmd` is removed after conversion. |
| `input` | string | One of `mermaid`/`input` | — | Existing `.mmd` source path. |
| `output` | string | No | See below | Destination `.drawio` path. |
| `binary` | string | No | Auto-detected | Explicit binary path to test first. |

Output defaults:

- file input: same directory and stem with `.drawio`;
- inline Mermaid: `diagram.drawio` in the current working directory.

Provide exactly one of `mermaid` or `input`. Normally provide `output` explicitly to avoid ambiguous names or accidental replacement.

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

The converted file is a normal `.drawio` source: it can be validated, previewed, and exported like any other.

---

### `drawio_layout`

Repositions nodes and routes edges in an XML-authored `.drawio` using a safe ELK preset. Requires draw.io 30 or newer.

#### Options

| Option | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `input` | string | Yes | — | Existing `.drawio` source. |
| `preset` | layout preset | Yes | — | One of the six allowlisted values below. |
| `output` | string | No | `<name>.layout.drawio` | Destination path beside the input. May equal `input` for intentional in-place layout. |
| `binary` | string | No | Auto-detected | Explicit binary path to test first. |

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
| `limit` | number | No | `10` | Maximum number of ranked results. |

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
- lists relations between labeled endpoints;
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

Opens a local `.drawio` source or exported file with the operating system's default application.

#### Options

| Option | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | Yes | Existing local file to open. |

Platform behavior:

- macOS: `open`;
- Windows: `start`;
- Linux: `xdg-open`.

Use it when the user requests desktop review or accepts an offer to fine-tune the source manually. Opening an application is a user-visible side effect.

```text
drawio_open({ "path": "architecture.drawio" })
```

## Authoring-mode selection

| Requirement | Recommended path |
| --- | --- |
| Standard diagram with no custom styling and CLI 30+ | Mermaid → `drawio_from_mermaid`. |
| Vendor icons, exact UML/BPMN notation, custom styling, swimlanes, containers, precise routing, or multi-page output | Hand-authored uncompressed XML plus `drawio_shapesearch`. |
| Large hand-authored graph and CLI 30+ | Rough XML → `drawio_layout`. |
| CLI unavailable or older than 30 | Hand-authored XML; validation and shape search remain available. |
| Existing diagram must be understood | `drawio_explain`, then inspect the source XML. |
| Existing diagram only needs validation | `drawio_validate`; no CLI check is necessary. |
| Existing diagram only needs export | `drawio_check` → `drawio_export`; do not rebuild it. |

DrawMe does not expose a single natural-language-to-file tool. Author or edit Mermaid/XML with normal file tools, then use DrawMe for conversion, layout, validation, rendering, explanation, or opening.

## Output and editability semantics

- `.drawio` is always the canonical editable source.
- Final PNG, SVG, and PDF embed XML by default and can be reopened in draw.io where supported.
- JPG cannot embed XML.
- Preview PNG is intentionally clean and unembedded for visual inspection. Its successful tool result includes the image when the current model can view images, and the text always states whether it was attached and reports the output path. Each successful replacement removes the prior same-source preview file, and final export removes the latest remaining preview.
- A final embedded PNG normally uses the `.drawio.png` double extension.
- Multi-page exports should use `pageIndex` and explicit unique output names.
- `drawio_explain` returns Markdown as text; it does not write a documentation file.
- `drawio_layout` creates a sibling `.layout.drawio` unless `output` is supplied.
- Inline Mermaid conversion creates `diagram.drawio` in the working directory unless `output` is supplied.

## Functional limitations

- Validation cannot inspect compressed pages.
- Explanation cannot describe compressed pages.
- Deterministic validation cannot replace visual inspection; rendered clipping, wrapping, contrast, and automatic routes can only be judged from the preview image. When the current model cannot view images, these remain unverified and must be reported as such.
- Removing a superseded preview file does not rewrite Pi session history: image blocks already stored in earlier tool-result messages can remain visible in the transcript even though only the latest preview file remains on disk.
- Route-through and crossing analysis is limited to edges with explicit waypoints; dense auto-routed graphs can validate without connector-route warnings.
- Shape search covers bundled official draw.io shapes, not arbitrary third-party logos.
- Mermaid conversion cannot express all draw.io styles, containers, routing, or multi-page behavior.
- ELK layout accepts only the six registered presets; arbitrary JSON layouts are not exposed.
- The extension does not expose XML compression/decompression, Python generators, or arbitrary draw.io CLI arguments.
- A failed operation may be returned as text beginning with `Export failed`, `Layout failed`, `Mermaid conversion failed`, `Explain failed`, or `Open failed`. Treat that result as failure.

## Authoring references

Use these packaged references when additional notation or XML detail is needed:

- [`../assets/references/xml-authoring.md`](../assets/references/xml-authoring.md) — XML cells, containers, edges, palette, and spacing;
- [`../assets/references/diagram-types.md`](../assets/references/diagram-types.md) — notation-specific shapes and layout conventions;
- [`../assets/references/mermaid-authoring.md`](../assets/references/mermaid-authoring.md) — Mermaid syntax and conversion guidance;
- [`../assets/references/troubleshooting.md`](../assets/references/troubleshooting.md) — rendering and platform failure patterns.

Use the registered DrawMe tools and options documented here rather than invoking the draw.io CLI directly.
