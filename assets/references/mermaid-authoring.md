# Mermaid authoring → native .drawio

Use Mermaid for a standard diagram with no custom styling requirements when `drawio_check` reports
`supportsMermaid: true` (draw.io 30.2.4 or later). Mermaid keeps the input focused on structure while
draw.io supplies the initial layout.

Pass exactly one of `mermaid` (nonblank inline text) or `input` (a `.mmd` file). For example:

```text
drawio_from_mermaid({
  "mermaid": "flowchart LR\n  A[Client] --> B[Service]",
  "output": "diagram.drawio"
})
```

If Mermaid conversion is unavailable, author uncompressed `.drawio` XML instead.

## When to prefer each authoring mode

| Author as | Best for | Why |
|---|---|---|
| **Mermaid → `drawio_from_mermaid`** | Flowchart, sequence, class, state, ER, gantt, mind map, timeline, journey, and similar standard diagrams | Concise structure and automatic initial layout |
| **Uncompressed XML** | Official vendor icons, exact UML/BPMN notation, custom styling, swimlanes, containers, precise routing, or multi-page output | Full control over draw.io cells, styles, geometry, and pages |
| **XML → `drawio_layout`** | Large or graph-heavy hand-authored diagrams | Repositions nodes and routes edges with an allowlisted ELK preset |

If the user requests Mermaid source rather than a `.drawio` deliverable, do not convert it unless they
also ask for a draw.io file.

## Mermaid quirks that matter for draw.io conversion

- The first non-directive line selects the diagram type. Common headers include `flowchart TD`,
  `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, `erDiagram`, `gantt`, `mindmap`, `timeline`,
  `journey`, `pie`, `gitGraph`, and `c4Context`.
- Node IDs are identifiers such as `A` or `node_1`. Put display text in brackets or quotes and avoid
  reserved words such as `end`, `class`, and `subgraph`.
- Keep one statement per line. Quote labels containing punctuation or non-ASCII text.
- Only `<br>`, `<b>`, `<i>`, and `<u>` are consistently reliable in labels; prefer hex colors.
- Style a node with `style A fill:#f9f,stroke:#333`, reusable classes with `classDef`, and edges with
  `linkStyle`.
- Match label language to the user's language.
- Never apply `drawio_layout` to a Mermaid-converted file; conversion already lays it out.

After conversion, treat the `.drawio` as the source of truth. Run `drawio_fit_canvas` on the imported
finite pages to size them to their content and margins. Then validate, export a preview, inspect the
attachment if available, and create the requested final exports.

## ELK layout for XML-authored diagrams

For rough XML geometry, use `drawio_layout` when `drawio_check` reports `supportsLayout: true`
(draw.io 30.2.4 or later). Choose one of these presets:

| Preset | Layout |
|---|---|
| `verticalFlow` / `horizontalFlow` | Layered flowcharts and pipelines |
| `verticalTree` / `horizontalTree` | Hierarchies and organization charts |
| `radialTree` | Trees arranged around a center |
| `organic` | Force-directed topologies and mind maps |

Use a distinct output path to preserve the rough source unless in-place replacement was requested:

```text
drawio_layout({
  "input": "diagram-rough.drawio",
  "preset": "horizontalFlow",
  "output": "diagram.drawio"
})
```

Continue with the layout tool's returned path and validate it again.
