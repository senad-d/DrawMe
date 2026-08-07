# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- New `drawio_fit_canvas` tool: deterministically resizes each page's canvas to its visible content plus
  a margin (default 40px) and shifts content to the margin origin — the fix for cramped pages where
  elements overlap because they were squeezed into a too-small canvas. The workflow now defers page
  dimensions until content exists (author with generous spacing → fit the canvas), and validation/docs
  direct overlap and bounds findings to "spread elements, then refit" instead of shrinking content.
  Shared `.drawio` geometry moved into `src/geometry.ts`.

### Changed

- The visual review now runs as gated passes with visually verified fixes. When the active model can view
  images, three focused passes — fit and sizing, element placement, connections — each answer explicit
  questions on their own preview (per page for multi-page files), followed by a holistic pass covering
  typography (every label read word for word), semantics, the diagram type's review checklist, and
  regressions; a pass must be clean before the next one starts, and all passes before final export. Each
  pass names the concrete rendered defects to hunt (overlapping or clipped labels, text struck through by
  lines, floating or buried edge endpoints, asymmetric or off-center anchors, stacked edges, unreadable
  full-diagram previews, …), findings go into a numbered ledger naming the affected cells and planned fix,
  and every correction is judged by comparing the replacement preview against the previous image with an
  explicit fixed / not fixed / regressed verdict — an XML edit alone never counts as a fix. `drawio_export`
  replacement previews prompt that before/after comparison directly in the tool result. The automatic
  correction limit rises from 5 to 8 retries to give the gated passes room to actually resolve findings.
  The diagram-types reference gains a per-type `Review:` checklist for the holistic pass, and the XML
  authoring reference a defect→fix recipe table (including edge-label offset positioning), so vision
  findings map to concrete source edits. Multi-page files are now reviewed and finally exported page by
  page (`pageIndex`), closing the gap where only page 1 of e.g. a multi-page C4 file was ever inspected.
  `ExportResult` gains `replacedPreview`, true whenever a preview supersedes an earlier tracked one —
  including a re-export over the same output path — so the replacement-preview verdict prompt no longer
  misses same-name re-exports. Models that cannot view images skip the visual passes entirely and review
  structurally, as before. The golden asset baseline was intentionally refreshed for these reference
  changes.
- `/drawme` now pre-loads its context: the command handler resolves the draw.io CLI itself and embeds the
  check result plus the diagram-types, XML-authoring, and (v30+) Mermaid references directly into the
  injected workflow message. The references remain editable Markdown files under `assets/references/`;
  they are just no longer read via tool calls at run start. Only the rarely needed troubleshooting
  reference stays on-demand.

- `drawio_export` previews are now vision-aware: the PNG image block is attached only when the active
  model can view images (checked per call via the extension context, failing open for unknown models),
  the result text always states whether it was attached, and `details.imageAttached` reports the outcome.
- Replaced the five mandatory visual passes with a critique-first review: one holistic preview with a
  structured all-category critique, focused re-previews only for categories with findings, and a final
  holistic confirmation. Models that cannot view images get an explicit structural-review path
  (`drawio_validate` + `drawio_explain`) instead of a silent image placeholder.
- Rewrote the packaged extension reference and workflow text in second person without agent terminology.
- The `/drawme` run is now fully autonomous: the human approval gate before final export is removed.
  After the holistic confirmation (or on hitting the five-retry correction limit, reporting the unresolved
  finding), the workflow proceeds straight to final export; mid-run user feedback is treated as new
  critique findings rather than a pause point. Docs, packaged troubleshooting guidance, and the example
  diagrams were updated to match, and the golden asset baseline was intentionally refreshed.
- The `/drawme` workflow no longer instructs a mandatory reference read: the injected message plus the
  registered tool descriptions are self-contained (the failure-text and compressed-page rules moved into
  them), saving a file read and several thousand tokens per run. `docs/agent-guide.md` became
  `docs/reference.md`, a pure command/tool catalog for other projects; topic references under
  `assets/references/` are still read on demand.
- Added focused visual quality passes, stronger deterministic canvas/edge/readability checks, attached PNG
  previews, warning-resolution gates, and explicit approval before final export.
- Intentionally re-baselined the golden asset hash after adding finite-page sizing, typography, preview
  readability, and five-retry correction guidance to the packaged authoring references.
- Each successful preview now removes the previous preview file for the same `.drawio` source, leaving only
  the latest review artifact; final export removes that remaining preview.
- Refocused the documentation on DrawMe's current diagram-authoring workflow and removed obsolete
  guidance inherited from the earlier documentation set.
- Improved npm and Pi gallery metadata, packaged linked diagram examples, and added a package-content
  validation gate for releases.

## [0.0.1]

Initial release: DrawMe as a native Pi extension for authoring, validating, and exporting diagrams.

### Added

- Commands: `/drawme`, `/drawme-check`, `/drawme-export`.
- Tools: `drawio_check`, `drawio_export`, `drawio_validate`, `drawio_shapesearch`, `drawio_from_mermaid`,
  `drawio_layout`, `drawio_explain`, `drawio_open`.
- Guided seven-step `/drawme` workflow (check → plan → author → validate → preview & self-check → review
  → final export).
- Deterministic structural linter, `-e` PNG IEND repair, shape search over a bundled index, and a
  diagram-to-Markdown describer — all pure TypeScript.
- draw.io binary resolution (macOS/Linux/Windows/WSL), headless-Linux `xvfb-run` handling, and
  version-gated Mermaid conversion + ELK auto-layout (draw.io v30+).
- Bundled authoring references and the vendored draw.io shape index.
- Tooling: ESLint flat config, custom `format:check`, `check:golden` asset-integrity check, Vitest suite
  with real-CLI integration tests, CI, SonarCloud, and release workflows.

[Unreleased]: https://github.com/senad-d/DrawMe/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/senad-d/DrawMe/releases/tag/v0.0.1
