# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

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
