# Release audit: regressions at the boundaries that failed

Kind: testing

## Purpose and scope

Issue #34 calls for failing-before regressions, especially #66–69. Put deterministic rules at the narrowest boundary and inspect the actual artifact when the defect is in native rendering or packaging. Already-fixed behavior is positive protection, not a claim of a newly failing baseline.

## Scope

| Area | Tested by this work | Why or why not |
| --- | --- | --- |
| Registered tools and commands | Yes | Cwd, signal, schema, attachment history and Pi busy delivery are not properties of pure helpers. |
| CLI and artifact | Yes | Probe, argv, lifecycle, editable pixels, page selection, layout and standalone SVG require boundary evidence. |
| XML, geometry, motion and descriptions | Yes | Small equivalent/invalid diagrams distinguish actual fixes from plausible messages. |
| Package, docs, workflows | Yes, offline | Test what ships, static policy and current-facing statements. |
| Live providers, release services, Sonar | No | Explicitly excluded. |

## Coverage today

| Area | Unit | Functional | End-to-end | Command | What they prove | Files |
| --- | --- | --- | --- | --- | --- | --- |
| PNG | Plan and tail | Staged/ownership fixtures | Real signature, IEND, zTXt marker | `npm test` | Clean preview, some metadata present; **not** recoverable expected cells | `tests/png.test.ts`, `tests/integration.test.ts` |
| Import/layout | Arg builders/loose guard | Missing CLI can satisfy missing-input test | Mermaid only | `npm test` | Does not prove actual successful placement | `tests/mermaid-layout.test.ts`, `tests/integration.test.ts` |
| Renderer fixtures | Planning and POSIX timeout | Shebang executables | Conditional native | `npm test` | Linux happy path; hardcoded separators, temp shell quoting, cleanup-on-success remain | `tests/drawio.test.ts`, `tests/animate.test.ts`, `tests/integration.test.ts` |
| Package | Fixed list | npm dry-run | None | `npm run check:pack` | Does not close over runtime imports | `scripts/check-package-contents.mjs` |
| Diagram/read-back | Graph and motion fixtures | Mock Pi and rollback | Some native SVG | `npm test` | Existing examples and shipped ownership/connector fixes pinned; not all audit scenarios | `tests/validate.test.ts`, `tests/motion.test.ts`, `tests/animate.test.ts`, `tests/examples.test.ts` |

## Gaps

| Rank | Behaviour no test proves | What breaks for the user when it fails |
| --- | --- | --- |
| High | Correct source/page/bytes across concurrency, cancel and native flag forwarding | Wrong workspace, lost edits, wrong or uneditable deliverable |
| High | Packed dependency graph and actual release privilege | Unloadable package or validation running with release identity |
| Medium | Capability-specific guards, placement, actual image bounds/media box and copied animated image | Misleading success for incompatible or visually wrong output |
| Medium | Session receipts, XML/Markdown limits, motion states | Model judges unseen output or accepts incomplete/unsafe results |
| Medium | Portable fake execution and native fixture cleanup | Platform failures hidden by a different installed CLI or temp-path assumptions |

## Approach

| Gap | Level | Why this level proves it cheapest |
| --- | --- | --- |
| Source transaction / cancel | Component with barriers, not sleep-order guesses | Pause at actual read/renderer start, observe queue and file bytes before/after. Exercise a mixed writer, not only two exports. |
| Root, WSL, headless, operands, diagnostics, viewer lifetime | Mock platform/runner plus real disposable Node child for abort/timeout/viewer | Inspect launch policy without root/Windows desktop; real child confirms termination or survival and explicit teardown. |
| XML findings, motion tracks, storyboard IDs, Markdown and ranking | Unit/component | Parse independent output: XML IDs/coordinates, emitted CSS time-zero and later states, Markdown tokens, shipped shape titles. Compare validity/bytes, not just success flags. |
| Registered surface | Functional offline Pi registration | Verify session path and signal propagation, result blocks, busy/idle, stored example command help, notification and schema. |
| #67/#72 | Native end to end | Decode PNG metadata chunks (including zTXt inflation, URL/XML decoding as appropriate), parse model and recover known IDs/labels/edge. Preview must have no model. Read IHDR, SVG dimensions/viewBox and PDF `/MediaBox`, compare to authored content/page with rounding tolerance. |
| #68/#47 | Component + native end to end | Use capable mock for exact missing-input guard, separate absent/early version cases with valid input. Real overlapping A/B/edge layout must change placement and retain IDs, terminals and declared output. |
| #66/#71 | Disposable pack fixture | Remove each representative reachable TS path from pack set, leave source tree intact; pack checker returns missing path. Check Markdown destinations against packed files/verified repository links, parse Git source offline. |
| #46/#69 | Static workflow and native Windows CI job | Validate security properties and planned execution platform, not live pipeline status. |

## Data and environments

| Need | Kind | How it is started |
| --- | --- | --- |
| Test workspace | Disposable temp dir with spaces and same-named fixtures | Vitest setup; `finally`/hooks remove files, stop all stand-ins even on failure. |
| Deterministic fake | Test-only spawn adapter maps registered fake paths to Node running the fixture script with unchanged argv, recognizes Xvfb where needed | Install via test mocks; never via public tool option or production executable bypass. Assert distinctive version/output marker, not mere success. |
| Local renderer | Stock desktop with display/Xvfb, nonroot; modern capable build for native checks | Existing conditional integration groups; use capability booleans. Missing renderer is a declared skip only for native checks. |
| Offline Pi | `makeMockPi`/local script driver, installed Pi parser | Locked dependencies via `npm ci --ignore-scripts`; `npm run dev` for local user journey. |
| CI | Linux and native Windows | Existing validation workflow, same locked install and `npm run validate`. |

## Pass criteria

| Command | What it must show |
| --- | --- |
| `npm test` | Each remaining issue scenario has a negative case that would fail on the base, plus nearby success control. Temporarily removing final embed forwarding or missing-input check makes its specific regression fail. |
| `npm run check:pack` | Normal package passes; omitted reachable module rejected. |
| `npm run validate` | Full golden/lint/tests/pack gate; with modern unprivileged draw.io, actual artifact tests run rather than skip. Distinguish configured Windows CI from observed results. |

## Risks

| Risk | What it would hide or break | What limits it |
| --- | --- | --- |
| Host discovery fallback | Real CLI or missing CLI accidentally satisfies fake test | Isolate spawn and assert intended fixture ran. |
| Windows assumptions | Shell-only fixtures, symlink privilege/mode semantics mask normal tests | Native joins, real Node executor, support Windows semantics; limit platform-specific assertions to genuine POSIX properties. Do not skip entire portable suites. |
| False native positives | Fake PNG, visible marker only, unchanged layout, same validator measuring its own fit | Decode actual native output; compare labels/placement and independent coordinates. |
| Cross-test pollution | Session state, tracked preview or temp dir survives test | Separate paths and mock sessions, teardown on assertion failure. Main native export group already has `afterAll`; fix remaining success-only cleanup. |

## Left untested

| Behaviour | Why |
| --- | --- |
| Hosted provider transfer, live CI/Sonar, publication and real privileged processes | Outside request; local contracts/static policy suffice. |
| Every historic desktop binary and WSL desktop | Use supplied tagged evidence plus deterministic process-boundary tests; do not imply native execution. |

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Negative controls | Local disposable mutations/fixtures; revert mutation within test exercise | Weakening a production check or committing mutated production | Demonstrates the test distinguishes the specific failure. |

## Open questions

None. No new requirement for live pipeline evidence.
