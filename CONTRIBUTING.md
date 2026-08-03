# Contributing to DrawMe

Thanks for your interest in improving DrawMe. This document covers how to set up the project, the
conventions the code follows, and how changes are reviewed.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Requires Node.js ≥ 22.19 and, for the real-export tests, the draw.io desktop CLI on PATH.

```bash
git clone https://github.com/senad-d/DrawMe.git
cd DrawMe
npm ci --ignore-scripts   # first time on a fresh clone without a lockfile: npm install
npm run validate          # golden check + lint + tests
pi --no-extensions -e .   # load this checkout in Pi
```

## The validation gate

`npm run validate` must pass before a change is merged. It runs, in order:

1. `npm run check:golden` — SHA-256 integrity of the bundled upstream assets under `assets/`.
2. `npm run lint` — `tsc --noEmit`, `eslint . --max-warnings=0`, and the custom `format:check`.
3. `npm test` — the Vitest suite.

Individual checks are available as `npm run typecheck`, `npm run lint:eslint`, `npm run format:check`,
`npm run check:golden`, `npm test`, and `npm run coverage`.

## Conventions

- **Network-free.** DrawMe makes no network requests. Do not add `fetch`, `http(s)`, sockets, or any
  outbound call. The only processes it may spawn are the draw.io CLI, `xvfb-run` on headless Linux, and
  the OS file opener. See [`SECURITY.md`](SECURITY.md).
- **Pure TypeScript / Node.** No Python or other runtime dependencies. Prefer Node built-ins and the
  existing small dependencies (`typebox`, `@xmldom/xmldom`).
- **Immutable bundled assets.** Files under `assets/` are vendored upstream data (the shape index and the
  authoring references). Change them only intentionally, then run `npm run check:golden -- --update` and
  explain why in the PR.
- **Formatting.** LF line endings, no trailing whitespace, a single final newline, two-space indent.
  `.editorconfig` and `npm run format:check` enforce this.
- **Match the surrounding code.** Keep the comment density, naming, and idioms already in the file.

## Tests

- Tests live in `tests/**/*.test.ts` and run with Vitest.
- The real-`draw.io` export/convert cases in `tests/integration.test.ts` **skip automatically** when the
  CLI is unavailable (so CI passes without it); install draw.io locally to exercise them.
- New behavior needs a test. Ports of skill logic should be verified against the original where practical.

## Pull requests

1. Branch from `main`.
2. Keep the change focused; update `README.md` and `CHANGELOG.md` when behavior or the tool/command
   surface changes.
3. Ensure `npm run validate` passes.
4. Fill out the PR template checklist.

## Reporting bugs and requesting features

Use the issue templates. For anything security-sensitive, follow [`SECURITY.md`](SECURITY.md) instead of
opening a public issue.
