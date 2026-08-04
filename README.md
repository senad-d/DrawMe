<p align="center">
  <img alt="DrawMe icon" src="https://raw.githubusercontent.com/senad-d/DrawMe/main/img/icon.svg" width="128">
</p>

<p align="center">
  <a href="https://pi.dev"><img alt="pi package" src="https://img.shields.io/badge/pi-package-6f42c1?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@senad-d/drawme"><img alt="npm" src="https://img.shields.io/npm/v/%40senad-d%2Fdrawme?style=flat-square" /></a>
  <a href="https://github.com/senad-d/DrawMe/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/senad-d/DrawMe/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://sonarcloud.io/summary/new_code?id=senad-d_DrawMe"><img alt="Quality Gate Status" src="https://sonarcloud.io/api/project_badges/measure?project=senad-d_DrawMe&metric=alert_status" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

<p align="center">
  Natural-language diagrams for <a href="https://pi.dev">pi</a>.
  <br />Turns a description into editable <code>.drawio</code> XML and exports it to PNG / SVG / PDF / JPG with the native draw.io desktop CLI — entirely on your machine.
</p>

---

DrawMe is a native Pi **extension** for diagram authoring. Describe a diagram and Pi plans it, writes editable `.drawio` XML (or Mermaid on draw.io v30+), lints it deterministically, previews it for a visual self-check, and exports the approved result.

<table align="center">
  <tr>
    <th>DrawMe</th>
  </tr>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/senad-d/DrawMe/main/example/drawme-how-it-works.drawio.png" alt="DrawMe: from a prompt to an editable diagram" title="DrawMe" width="820">
    </td>
  </tr>
</table>

- **Natural-language authoring:** flowcharts, architecture, UML, BPMN, ERD, C4, network, ML — as native `.drawio`, or as Mermaid with automatic layout on v30+.
- **Guided workflow:** CLI detection, planning, authoring, validation, visual review, and final export are coordinated from one `/drawme` command.
- **Deterministic validation:** a structural linter catches dangling edges, duplicate/reserved ids, broken parents, missing geometry, overlaps, and edge-routing defects before you ever look at a pixel.
- **Exact shapes, not guesses:** search 10k+ official AWS/Azure/GCP/Cisco/Kubernetes/UML/BPMN styles from a bundled local index.
- **Editable source of truth:** final PNG/SVG/PDF exports embed the diagram XML, the truncated `-e` PNG chunk is auto-repaired, and temporary previews are removed automatically after final export.

> **Security:** Pi packages run with your full system permissions. DrawMe reads and writes diagram files and can launch the draw.io CLI or your OS file opener. Review [`SECURITY.md`](SECURITY.md) before installation.

## Table of Contents

- [Implementation Status](#implementation-status)
- [Agent Reference](#agent-reference)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Commands](#commands)
- [Tools](#tools)
- [Architecture](#architecture)
- [The /drawme Workflow](#the-drawme-workflow)
- [Bundled References and Assets](#bundled-references-and-assets)
- [Requirements and Compatibility](#requirements-and-compatibility)
- [Security](#security)
- [Examples](#examples)
- [Development](#development)
- [Publishing](#publishing)
- [License](#license)

---

## Implementation Status

This checkout implements the DrawMe core loop as a Pi extension:

- Eight model-callable tools (`drawio_check`, `drawio_export`, `drawio_validate`, `drawio_shapesearch`, `drawio_from_mermaid`, `drawio_layout`, `drawio_explain`, `drawio_open`) and three commands (`/drawme`, `/drawme-check`, `/drawme-export`).
- A guided `/drawme` workflow that steers authoring, validation, a vision preview self-check, human review, and final multi-format export.
- Pure-TypeScript structural linting, `-e` PNG IEND repair, shape search over a bundled index, and diagram-to-Markdown description — no Python runtime required.
- draw.io binary resolution across macOS/Linux/Windows/WSL, headless-Linux `xvfb-run` handling, and version-gated Mermaid conversion + ELK auto-layout (draw.io v30+).
- Validation pipeline: golden asset-integrity check, TypeScript typecheck, ESLint, a custom format check, and unit + real-CLI integration tests.

## Agent Reference

[`docs/agent-guide.md`](docs/agent-guide.md) is the official operational reference for AI agents. It documents every command, tool option, default, authoring mode, workflow, output behavior, and functional limitation. The `/drawme` command instructs the agent to read this packaged reference before starting.

## Quick Start

### 1) Install the draw.io desktop CLI

```bash
brew install --cask drawio            # macOS
# others: https://github.com/jgraph/drawio-desktop/releases  (Linux: prefer the .deb/.rpm, not snap)
drawio --version
```

### 2) Install the extension

```bash
cd /path/to/your/project
pi install npm:@senad-d/drawme
```

### 3) Start Pi and check the CLI

```bash
pi
```

Inside Pi:

```text
/drawme-check
```

### 4) Draw something

```text
/drawme a flowchart of a user login: enter credentials, validate, then success or retry
```

Pi checks the CLI, plans and writes the `.drawio`, validates it, exports a preview PNG, self-checks it visually, and — after your review — exports the final editable deliverable.

### Run from a source checkout

```bash
git clone https://github.com/senad-d/DrawMe.git
cd DrawMe
npm ci --ignore-scripts
npm run validate
pi --no-extensions -e .
```

## Installation

| Scope | Command | Notes |
| --- | --- | --- |
| Global | `pi install npm:@senad-d/drawme` | Loads in every trusted Pi project. |
| Project-local | `pi install npm:@senad-d/drawme -l` | Writes to `.pi/settings.json` in the current project. |
| One run | `pi -e npm:@senad-d/drawme` | Try without changing settings. |
| Git | `pi install git:senad-d/DrawMe` | Install from Git; pin a tag or commit for a fixed version. |
| Local checkout | `pi --no-extensions -e .` | Develop or test this repository. |

## Commands

| Command | Description |
| --- | --- |
| `/drawme <description>` | Kick off the full author → validate → preview → export workflow for the described diagram. |
| `/drawme-check` | Report whether the draw.io CLI is available, its version, and v30+ feature support. |
| `/drawme-export <file> [png\|svg\|pdf\|jpg]` | One-shot final export of an existing `.drawio`. |

## Tools

Registered for the model to call directly.

| Tool | Purpose |
| --- | --- |
| `drawio_check` | Resolve the draw.io binary, version, and whether it supports Mermaid import / `--layout` (v30+). |
| `drawio_export` | Export a `.drawio` to PNG/SVG/PDF/JPG. `mode:"preview"` → clean width-capped PNG for a vision self-check (never embedded); `mode:"final"` → embedded editable deliverable, with the truncated `-e` PNG IEND chunk auto-repaired and prior previews for the source removed automatically. |
| `drawio_validate` | Deterministic structural lint: dangling edges, duplicate/reserved ids, broken parents, missing geometry; warnings for overlaps, off-canvas nodes, and edges routing through / crossing shapes. |
| `drawio_shapesearch` | Exact official `style=` strings for 10k+ AWS/Azure/GCP/Cisco/Kubernetes/UML/BPMN shapes, from a bundled local index. Use instead of guessing a style. |
| `drawio_from_mermaid` | Convert Mermaid text (inline or a `.mmd`) to a native `.drawio` with automatic layout. Requires draw.io **v30+**. |
| `drawio_layout` | Re-place nodes / route edges with an ELK preset (`verticalFlow`, `horizontalFlow`, `verticalTree`, `horizontalTree`, `radialTree`, `organic`) for large graphs. Requires draw.io **v30+**. |
| `drawio_explain` | Describe an existing `.drawio` as structured Markdown (components by container, relations) — for READMEs/PR summaries or model read-back. |
| `drawio_open` | Open a `.drawio`/export in the OS default app (draw.io desktop) for fine-tuning. |

## Architecture

```text
Natural-language request
  └── Pi agent
        └── DrawMe extension  (check · validate · export · shape search · Mermaid · layout · explain · open)
              └── draw.io desktop CLI  (renders and exports, local process)
                    └── Deliverables: .drawio source + PNG / SVG / PDF / JPG
```

The extension factory in `src/index.ts` registers the tools and commands. Rendering, conversion, and layout launch the draw.io CLI on demand with an argument list rather than a shell; validation, shape search, and explanation run directly in the extension.

## The /drawme Workflow

`/drawme` injects a guided seven-step loop that the model follows using the tools above:

1. **Check** — resolve the CLI and note the version (v30+ unlocks Mermaid conversion and ELK layout).
2. **Plan** — pick the diagram type, shapes, relationships, and layout direction.
3. **Author** — write editable, uncompressed `.drawio` XML (or Mermaid on v30+); use `drawio_shapesearch` for exact vendor/UML/BPMN shapes; use `drawio_layout` for large graphs.
4. **Validate** — run `drawio_validate` and fix every error before exporting.
5. **Preview & self-check** — export a clean, width-capped PNG and inspect it visually; fix overlaps, clipping, and edge defects (max two rounds).
6. **Review** — show the preview, apply targeted edits from your feedback, re-preview until approved.
7. **Final export** — export each requested format (embedded/editable), automatically remove previews for that source, report final paths, and offer to open the source in the desktop app.

## Bundled References and Assets

The model reads these packaged references and assets on demand.

- `docs/agent-guide.md` — official agent-facing command, tool, option, workflow, output, and limitation reference.
- `assets/references/xml-authoring.md` — `.drawio` skeleton, cell/edge forms, containers, palette, spacing.
- `assets/references/diagram-types.md` — per-type presets (ERD, UML, sequence, C4, architecture, ML, flowchart, SysML, BPMN, network, swimlane).
- `assets/references/mermaid-authoring.md` — Mermaid authoring for the v30+ conversion path.
- `assets/references/troubleshooting.md` — export/render failure recovery.
- `assets/data/shape-index.json.gz` — the vendored draw.io shape index behind `drawio_shapesearch` (see its notice).

## Requirements and Compatibility

- **Node.js** ≥ 22.19.
- **draw.io desktop CLI** on PATH (or a known app path); resolved automatically on macOS (`.app`), Linux, Windows, and WSL. Pass an explicit `binary` to any tool to override.
- **draw.io v30+** for `drawio_from_mermaid` and `drawio_layout`; on older versions those tools return a clear "needs v30+" message and everything else works normally.
- **Headless Linux:** exports are wrapped in `xvfb-run` automatically when no display is present.

## Security

DrawMe works with diagram files and may launch the draw.io CLI, `xvfb-run` on headless Linux, or the OS
file opener (`open`/`xdg-open`/`start`). Pi extensions inherit the permissions of the Pi process, so
install only packages you trust. See [`SECURITY.md`](SECURITY.md) for runtime and dependency details.

## Examples

Sample diagrams authored with DrawMe live in [`example/`](example/):

- [`drawme-how-it-works.drawio`](example/drawme-how-it-works.drawio) — the workflow/architecture overview shown above.
- [`drawme-installation-guide.drawio`](example/drawme-installation-guide.drawio) — an installation walkthrough.
- [`git-graph-example.drawio`](example/git-graph-example.drawio) — a branching release-history example.

## Development

```bash
npm ci --ignore-scripts   # install the locked dependency set
npm run validate          # golden check + lint + tests
```

Individual checks:

```bash
npm run typecheck         # tsc --noEmit
npm run lint:eslint       # eslint . --max-warnings=0
npm run format:check      # LF endings, no trailing whitespace, final newline, valid JSON
npm run check:golden      # SHA-256 integrity of bundled assets (--update to re-baseline)
npm test                  # vitest run
npm run coverage          # vitest run --coverage
pi --no-extensions -e .   # load this checkout in Pi
```

Source layout:

- `src/index.ts` — registers the tools and commands.
- `src/drawio.ts` — binary resolution, a pure/testable export planner, the CLI runner, Mermaid conversion, ELK layout, and file-open.
- `src/validate.ts` — structural linter.
- `src/shapesearch.ts` — shape search over the bundled index.
- `src/explain.ts` — diagram-to-Markdown describer.
- `src/dom.ts` — shared xmldom helpers used by `validate`/`explain`.
- `src/png.ts` — `-e` PNG IEND repair.
- `src/workflow.ts` — the guidance `/drawme` injects.

## Publishing

DrawMe publishes to npm as `@senad-d/drawme`. Run from a clean working tree after validation.

```bash
npm login
npm run validate
npm version <version>
npm publish --access public
```

Push the release commit and tag after the package is published.

## License

MIT — see [`LICENSE`](LICENSE).
