# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DrawMe (`@senad-d/drawme`) is a Pi extension (TypeScript, ESM, Node >= 22.19) that turns natural-language descriptions into `.drawio` XML and exports them to PNG / SVG / PDF / JPG via the native draw.io desktop CLI.

## Commands

```bash
npm ci --ignore-scripts        # install (never plain npm install)
npm run validate               # required gate: golden check + lint + tests
npm run typecheck              # tsc --noEmit
npm run lint                   # typecheck + eslint + format:check
npm run lint:eslint            # eslint . --max-warnings=0
npm run format:check           # custom checker (LF endings, no trailing whitespace, final newline, valid JSON)
npm run check:golden           # SHA-256 check of the immutable golden agent example
npm test                       # vitest run (tests/**/*.test.ts)
npm run coverage               # vitest run --coverage
npm run dev                    # load this checkout in Pi: pi --no-extensions -e .
```

Run a single test file:

```bash
npx vitest run tests/smoke.test.ts
```

## Pi documentation

Use the documentation shipped with the installed `@earendil-works/pi-coding-agent` version under `node_modules/@earendil-works/pi-coding-agent/` as the version-matched source of truth. Online references:

- [Pi README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) and [documentation index](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/index.md)
- [Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) and [extension examples](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions)
- [RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), and [TUI components](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)
- [Skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md), [prompt templates](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/prompt-templates.md), [themes](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/themes.md), and [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Keybindings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/keybindings.md), [custom models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md), and [custom providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md)

For observability development, invoke `skill:observme-docs` before designing or changing telemetry, privacy and content capture, OpenTelemetry export, extension integration, or parent/subagent lineage. Use the version-matched ObservMe documentation routed by that skill rather than guessing behavior or configuration.
