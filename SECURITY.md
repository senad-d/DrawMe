# Security

> Pi packages run with your full system permissions. Only install extensions from sources you trust.

## Network posture

DrawMe is **network-free by construction**. No tool, command, bundled reference, or the bundled shape
index makes any network request. The only processes it spawns are:

- the **draw.io desktop CLI** (rendering/export), invoked with argument lists — never a shell;
- **`xvfb-run`** on headless Linux;
- the **OS file opener** (`open` / `xdg-open` / `start`) for `drawio_open`.

No prompt, diagram content, file content, or environment data is ever sent anywhere.

## Provenance

DrawMe is a port of the [`drawio-skill`](./example/drawio-skill). That source was audited before porting:
no `eval`/`exec`/`os.system`, no shell invocations, no reads of credentials/SSH/keychain, and no
exfiltration channels. The skill's only outbound calls lived in `aiicons.py` (brand-icon CDN downloads)
and a browser-fallback URL builder — **neither was ported**. The bundled `assets/data/shape-index.json.gz`
is upstream draw.io shape data (see the notice beside it); the bundled references are plain Markdown with
no external URLs.

## Dependency audit

The published package depends only on `@xmldom/xmldom` and `typebox`, and ships only `src/`, `assets/`,
and `img/`. Auditing what actually ships is clean:

```bash
npm audit --omit=dev   # 0 vulnerabilities
```

A plain `npm audit` currently reports **one high** finding in `brace-expansion`, pulled in transitively by
the dev-only `@earendil-works/pi-coding-agent` (used for TypeScript types and the jiti loader during
development — never shipped, never executed at runtime). That package ships its own `npm-shrinkwrap.json`
pinning `brace-expansion@5.0.7`, which npm honors over any consumer `overrides`, so it can only be
resolved upstream. It does not affect the published extension.

## Reporting

Please report suspected vulnerabilities privately to the maintainer rather than opening a public issue.
