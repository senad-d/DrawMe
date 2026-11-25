# DrawMe release audit: local baseline

## Scope and method

Evidence for issue #34, base `12aa08e15e2b2d36be26995e2ac2cbca7b236610`. The offline baseline used the unmodified extension's documented `npm run dev` entry, lockfile Pi 1.5.2, Node 24.22.3 and native desktop 32.4.1 through an installed Xvfb wrapper. A fixed local tool-call driver exercised the registered tools; no model provider, publishing or network was involved. Five captures were inspected: three Pi HTML transcript views and two comparisons of real output pixels. `/drawme-check` was captured via RPC. Neither the live terminal's appearance nor historical desktop versions were measured.

## Observed outputs

| Observation | Evidence and interpretation |
| --- | --- |
| Preview versus final | `01-preview-final.png`: preview reported a PNG image block and `embed=false`; the final reported `embed=true` and removed the preview file. The earlier transcript attachment survived. Receipts are not proof of recoverable embedded XML (`src/index.ts`, `exportResult`). |
| Imported pages | `02-import-layout-fit-receipts.png`: the LR Receive order → Check stock → Ship order graph converted successfully. Both direct fit and fit after `verticalFlow` skipped: “page canvas disabled (infinite canvas)”. |
| Native layout | `03-import-and-layout-renders.png`: geometry changed in the requested direction, but a finite 640×480 page lost its dark `#172033` background and became an infinite 850×1100 page. Fit of the original control produced 435×245; fit after layout skipped. Sources: `src/drawio.ts` (`applyLayout`, `convertMermaid`), `src/fitcanvas.ts` (`fitModel`). |
| Storyboard | `04-storyboard-visibility.png`: the blue/green static preview omitted a hidden layer; both captioned tiles visibly showed its red HIDDEN DRAFT bar. `05-animate-feedback.png`: the receipt certified two steps and attached the two-frame board. A successful receipt did not imply correct tile contents (`src/storyboard.ts`, `buildStoryboard`). |
| CLI check | RPC delivered only “draw.io 32.4.1 — /usr/local/bin/drawio”, not Mermaid or layout capabilities (`src/index.ts`, `drawme-check`). |

Capture names identify the research report's five objective-local screenshots, not files needed to build or run DrawMe. Recreate these comparisons with disposable diagrams; do not depend on a scratch pathname.

## Compatibility sources

- Pi: the installed `@earendil-works/pi-coding-agent/docs/extensions.md` (`pi.sendUserMessage`) and `examples/extensions/send-user-message.ts` specify `deliverAs: "followUp"`. `dist/core/agent-session.js` maps the policy to queued follow-up while streaming and immediate submission while idle. Send once, not once per state.
- Install: Pi `docs/packages.md` specifies an explicit Git host. The installed `dist/core/package-manager.js` uses `source.repo` from `dist/utils/git.js`. Parsing `git:senad-d/DrawMe` returned `https://senad-d/DrawMe` **despite** `host=github.com`; `git:github.com/senad-d/DrawMe` returned `https://github.com/senad-d/DrawMe`. Verified offline without cloning.
- Audit sources supplied with #39 and #56: desktop tag option tables for 26.2.15 versus 27.0.2 (page-index convention) and 30.0.4 versus 30.2.4 (feature options); 32.4.1 was actually rendered. Use these as compatibility fixtures, not a claim that every historical binary was executed.
