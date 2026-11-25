# Release audit: truthful installation, export and contributor guidance

Kind: documentation

## Purpose and scope

Issue #34: fix documented contracts, not the product's presentation or release version. Cover #43, #55/56, #60/61, #64/65, #71/72, #74–77 and the resulting public behaviors. This is reference maintenance, not a new manual.

## Readers

| Reader | Comes to do | Knows |
| --- | --- | --- |
| Prospective installer | Decide whether context may leave the machine, install from the intended source | Pi may use different model providers |
| Diagram author/model | Choose supported tool, interpret actual artifact/attachment/failure | Editable diagram is source of truth |
| Contributor | Run real gates and locate current review policy | Node/npm and this checkout |

## Pages today

| Path | Covers | Wrong or out of date | Checked against |
| --- | --- | --- | --- |
| `README.md` | Intro/install/examples/development | Local-only promise, unresolved Git/render links, v30+, per-step storyboard promise, gate omits pack | `src/index.ts`, Pi parser baseline, `package.json` |
| `example/README.md`, `example/drawme-installation-guide.drawio` | Example navigation/onboarding | Render links not in pack; broad version/check claims | Pack files, `src/drawio.ts:resolveBinary`, `/drawme-check` |
| `docs/reference.md` | Public tools | Width vs scale, PDF/SVG bounds, native vs stored motion, board sampling and preview lifetime | `planExportSize`, `src/svgexport.ts`, `src/motion.ts`, registered schema |
| `assets/references/xml-authoring.md`, `mermaid-authoring.md`, `diagram-types.md` under the same directory | Injected authoring guidance | Per-step board; broad v30 threshold | `src/storyboard.ts:sampleFrames`, `src/workflow.ts`, #56 |
| `assets/references/troubleshooting.md` | On-demand renderer failure guidance | Directs WSL users to a Windows renderer and advises repositioning a sandbox-disabling flag | `src/drawio.ts` platform policy, #43/#55 |
| `CHANGELOG.md` | Export history | Height reads as public | `src/index.ts:exportParams` |
| `CLAUDE.md`, `CONTRIBUTING.md` | Contributor commands | Invalid single-test path, wrong golden scope or missing `check:pack` | `package.json:scripts`, `scripts/check-golden.mjs` |
| `docs/visual-review-implementation-tasks.md` | Past review-loop checklist | Obsolete approval/retry policy reads as current | `src/workflow.ts:AUTOMATIC_CORRECTION_LIMIT`, `drawmeWorkflow` |

## Pages

| Path | Type | Reader | Questions it answers | New, changed or removed |
| --- | --- | --- | --- | --- |
| `README.md` | how-to | Installer | What leaves the machine? How do I install/check/see examples? | Changed |
| `example/README.md` | reference | Author | Where are source and rendered examples? | Changed |
| `example/drawme-installation-guide.drawio` | tutorial | Installer | What does check report; which CLI works? | Changed source and refresh its displayed render |
| `docs/reference.md` | reference | Author | Which inputs, limits, results, warnings and failures are promised? | Changed |
| `assets/references/xml-authoring.md` | how-to | Author/model | How do I use motion and inspect frames? | Changed |
| `assets/references/mermaid-authoring.md` | how-to | Author/model | When can I use conversion/layout? | Changed |
| `assets/references/diagram-types.md` | reference | Author/model | Which type guidance can use Mermaid? | Changed |
| `assets/references/troubleshooting.md` | how-to | Author/model | Which sandboxed Linux renderer should I use when discovery fails under WSL or as root? | Change renderer advice only |
| `CHANGELOG.md` | reference | Existing user | What does explicit height refer to? | Clarified, no version bump |
| `CLAUDE.md` | reference | Contributor | What commands and assets actually exist? | Changed |
| `CONTRIBUTING.md` | how-to | Contributor | How do I validate a contribution? | Changed |
| `docs/visual-review-implementation-tasks.md` | explanation | Contributor | Is this historical or normative? | Mark historical |

## Content per page

### README.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Introduction (before installation) | Rendering is local; Pi's configured model/provider can receive requests, tool results and attached preview/storyboard images. Do not guarantee an entirely local workflow. | `src/index.ts`, `exportResult`, animate handler, `sendUserMessage` |
| Features / prerequisites / commands | Explicit capability threshold, Linux renderer required on WSL; `/drawme-check` names path/version and both capabilities. Unknown/text-only models do not receive images. In the `drawio_animate` tool row, say the board samples at most 12 visual batches (parallel steps share a tile, a wait alone has none), not a picture per input step. | Renderer, Session and Motion contracts |
| Installation and examples | `git:github.com/senad-d/DrawMe`, shipped source links local, repository links for rendered assets and example index absent from pack. | `docs/research/release-audit-remaining.md`, `package.json:files` |
| Development | Actual four-step gate; no invented smoke test. | `package.json:scripts.validate` |

### example/README.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Examples / scope | Resolve renders using repository URLs; source and shipped references stay relative. Show verified capability cutoff and qualified cleanup. | Pack list, CLI capability and export tracker |

### example/drawme-installation-guide.drawio

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Verify / compatibility cells | Path/version and detected capabilities; 30.2.4+ for Mermaid/layout, older supported versions still render ordinary exports. Update the linked native PNG so its labels agree. | `src/index.ts`, `tests/examples.test.ts` |

### docs/reference.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Commands/CLI | Session-relative file paths, Linux headless/unprivileged requirement, WSL native only, full feature cutoff; `/drawme` queues if busy. Animated one-shot uses native sequence/flow; stored motion needs `drawio_animate` without steps. | Renderer and Session contracts |
| Export | Positive 1-based page ordinal/minimum for explicit selection; file-only output, matching suffix, noneditable JPEG, actual successful format. Width only public, overrides scale; preview long-side caps, final scale ≤ requested to meet 6M pixels incl. margins; explicit raster size also budgeted. SVG width refers to pre-padding native export; finished width includes both margins and native rounding (500 can yield 581). PDF keeps page media box, not tight content bounds. | `src/index.ts:exportParams`, `src/drawio.ts`, `src/svgexport.ts`; native artifact checks |
| Review/lifetime | Compare actual attachments only for same conversation/source/page. Earlier blocks can remain in transcript; process-local file ownership is per source, not per page, not durable across restarts. Don't promise retention after success; report actual removals/warnings. | `publishExport`, `retirePreviews`, `exportResult` |
| Animation | 1–200 steps; hold/stagger 0–60000 ms; visual durations positive and ≤60000, wait duration may be zero; sequence ≤300000 ms before loop hold. One frame per visual batch, no standalone wait tile, parallel actions share tile. Even sampling up to 12 incl. endpoints. Dimmed visible may fade back to full, already fully visible repeat entrance invalid. Document board path and standalone-image refusal. | `src/motion.ts`, `src/storyboard.ts`, `src/animate.ts` |
| Validation / fit / import | Incomplete is not clean. Distinguish unchecked auto-route warnings from measured crossing and predicted straight-line observations. Fit respects authored infinite pages; fresh Mermaid imports fit. Exactly one file or inline input. | `src/validate.ts`, `src/fitcanvas.ts`, import implementation |
| Failures | `Export failed:`, `Animate failed:`, `Fit canvas failed:`, `Layout failed:`, `Mermaid conversion failed:`, `Explain failed:`, `Open failed:`; validation returns diagnostic arrays. | `src/index.ts` result construction |

### assets/references/xml-authoring.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Motion | State real limits, valid dim→fade, batch timing and sampling, actual returned board path. Do not promise one frame per step. | `compileMotion`, `sampleFrames` |

### assets/references/mermaid-authoring.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Conversion / layout | Require reported capability; fresh import is already laid out and can be fit. | `convertMermaid`, `applyLayout` |

### assets/references/diagram-types.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Mermaid choices | Replace broad major-30 advice where it recommends conversion. | `resolveBinary` capability flags |

### assets/references/troubleshooting.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Common mistakes | Replace the flag-position workaround with running draw.io unprivileged with the sandbox enabled. Replace the missing-CLI WSL row with a supported native Linux installation; headless rendering uses Xvfb. | Renderer contract, #43/#55 |
| WSL2 / Windows specifics — Locate the CLI | Replace `/mnt/c` Windows-executable discovery/invocation with native Linux renderer guidance. Leave the distinct desktop-open entries and policy untouched. | `src/drawio.ts` renderer discovery vs `openFile` |

### CHANGELOG.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Unreleased / historical raster sizing | Distinguish internal planner height from registered width-only schema; describe current budget without rewriting release history. | `planExportSize`, registered tool schema |

### CLAUDE.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Commands | Existing test such as `tests/png.test.ts`; golden is all `assets/`; validate ends with pack. | `package.json`, `scripts/check-golden.mjs`, `tests/` |

### CONTRIBUTING.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Validation gate | Golden → lint (typecheck, ESLint, format) → Vitest → pack; use existing install/gate. | `package.json:scripts` |

### docs/visual-review-implementation-tasks.md

| Heading | What it holds | Source of the facts |
| --- | --- | --- |
| Historical notice before checklist | Superseded design; link to current guidance. Current workflow has eight correction retries and no mandatory human approval. | `src/workflow.ts`, `docs/reference.md` |

## Conventions

| Rule | Example |
| --- | --- |
| Keep one owner for each contract | Full sizing rules in reference; README links there. |
| Link to what actually ships | Editable `.drawio` relative; repository-only PNG/SVG use canonical `senad-d/DrawMe` URL. Check both README files offline against actual pack list, not local file existence alone. |
| Intentional authoring asset change | Update all affected guidance first, then regenerate `.golden.sha256` via documented `npm run check:golden -- --update`; never weaken the golden check. |

## Navigation

| From | To | How |
| --- | --- | --- |
| README install/examples | Correct repository, shipped editable source, canonical render URL | Existing commands and tables |
| Historical checklist | `docs/reference.md` | Prominent first notice |
| Workflow / registered tool help | Actual next tool | Named alternative for stored motion, attachment-aware structural review on missing vision |

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Example media | Link repository media, keep pack lean | Package all rendered files | No need to change runtime distribution. |
| Height | Keep internal, document width only | Add public option to match old prose | Fix documentation without expanding API. |

## Open questions

None.
