# Security

> Pi packages run with your full system permissions. Only install extensions from sources you trust.

## Runtime behavior

DrawMe reads and writes diagram files requested by the user. Depending on the selected tool, it may
launch:

- the **draw.io desktop CLI** for conversion, layout, rendering, and export;
- **`xvfb-run`** for draw.io on headless Linux;
- the **OS file opener** (`open` / `xdg-open` / `start`) when `drawio_open` is requested.

Child processes are invoked with argument lists rather than through a shell. Shape lookup uses the
bundled `assets/data/shape-index.json.gz` file.

## Dependency audit

The published package depends only on `@xmldom/xmldom`, with Pi and `typebox` declared as peer
dependencies. It ships `src/`, `assets/`, and `docs/`.

Audit the production dependency tree with:

```bash
npm audit --omit=dev
```

Development dependencies are not included in the published extension. Review `package.json` and
`package-lock.json` for the current dependency versions and audit results.

## Reporting

Please report suspected vulnerabilities privately to the maintainer rather than opening a public issue.
