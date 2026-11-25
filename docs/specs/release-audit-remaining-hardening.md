# Release audit: boundaries on input, execution and disclosure

Kind: hardening

## Purpose and scope

Issue #34 asks to fix confirmed security/resource defects before release. Use small benign fixtures, static policy checks and limits at DrawMe's own boundaries. No live release, binary-trust changes, or opener authorization changes.

## Baseline

| Measured or found | How | When | Result |
| --- | --- | --- | --- |
| Wrong filesystem base/ambiguous operands | #35/#62, `src/index.ts` registrations, `src/drawio.ts` argv | Planning base | Session cwd absent; opener already uses absolute document and export stage is absolute. |
| Preview budget | Native 32.4.1 #42, `planExportSize` | Audit/base | 2000×5057 portrait; explicit dimensions precede scale cap. `planExport` already suppresses embedding. |
| Linux identity | `src/drawio.ts:planExport`, `tests/drawio.test.ts` | Planning base | Root adds sandbox-disabling flag; no compromise asserted. |
| Intake/work | `src/validate.ts:validateFile`, `overlapWarnings`, `src/drawio.ts:pageContentSize` | Planning base | Unbounded read; n sibling boxes allow n(n−1)/2 comparisons and retained warnings. |
| Diagnostics | `src/drawio.ts:run`, `invokeExport` | Planning base | Streams accumulated; raw stderr enters tool error. |
| Release authority | `.github/workflows/publish.yml` | Static only | Short ref; one job for validation, write and OIDC. |
| Content disclosure | `src/explain.ts:renderRelations`, `README.md` intro, `src/index.ts:exportResult` | Planning base | Markdown interpolation and local-only claim despite model context/image blocks. |

## Target

| Measure or rule | Today | Target | Check that decides it |
| --- | --- | --- | --- |
| Raster sizes | Width-only preview; explicit raster skips cap | Default preview long side ≤2000 px, explicit ≤2576 px on both axes, final/explicit rasters ≤6,000,000 pixels incl. border | Actual dimensions and aspect ratio |
| XML intake | Whole files | Regular files only, ≤16 MiB UTF-8 bytes, including growing files and string validator | Tiny injected limit, oversized/irregular file |
| Validation | Nested loops and uncapped arrays | ≤5000 cells/page, shared 100,000 work units per validation for pair/segment/ancestor comparisons, ≤500 diagnostics across severities plus one incomplete marker | Small limits; count work, retained output, incomplete status |
| Streams | No ceiling | ≤8192 bytes retained per stream; drain remainder. No child prose/argv in surfaced failure | Many chunks and oversized single chunk with inert marker |
| Privilege | Unsafe root default; privileged validation | No unsandboxed root renderer; only exact default branch after validation reaches npm environment | Mock launch; static workflow assertions |

## Findings

| Id | Rank | Area | Where | What is wrong | Cost or exposure | Certainty |
| --- | --- | --- | --- | --- | --- | --- |
| 35 | High | V5 File Handling | `src/index.ts`, file tools | Wrong session base | Wrong workspace edited | Confirmed |
| 43 | High | V13 Configuration | `src/drawio.ts:planExport` | Root default weakens sandbox | Lost isolation | Confirmed |
| 61 | High | V14 Data Protection | `README.md`, introduction | No hosted-provider qualification | Inadvertent disclosure | Confirmed |
| 42 | Medium | memory | `src/drawio.ts:planExportSize` | Width or scale insufficient | Oversized model attachment | Confirmed |
| 44 | Medium | time, memory | `src/validate.ts:checkPage`, `src/drawio.ts:pageContentSize` | No file, pair or result limit | Pi stalls before timeout | Confirmed |
| 45 | Medium | V16 Security Logging and Error Handling | `src/drawio.ts:run`, `invokeExport` | Raw unbounded output | Memory/conversation disclosure | Confirmed |
| 46 | Medium | V8 Authorization | `.github/workflows/publish.yml:publish` | Short ref/shared authority | Excess release privilege | Confirmed statically |
| 53 | Medium | V1 Encoding and Sanitization | `src/explain.ts:clean`, renderers | Labels are markup; invalid codepoints throw | Misleading/missing content | Confirmed |
| 62 | Medium | V5 File Handling | `src/drawio.ts` CLI argv | Ambiguous relative operands | Wrong operation | Confirmed for remaining routes |

## Fix per finding

| Id | Change | What it could break | Finding it must not reopen |
| --- | --- | --- | --- |
| 35 | Anchor only user file operands at session; direct calls without context retain process base | Relative destinations incl. implicit inline import | Keep symlink and terminal-separator behavior |
| 43 | Refuse privileged Linux renderer with advice to run as an unprivileged user; cover planner and actual discovery/convert/layout paths | Tests mock identity for normal runner; no public bypass | Executable trust unchanged |
| 61 | Distinguish local rendering from provider access to requests, tool context, attached previews and storyboards before installation | Don't imply all providers are remote | No new telemetry/provider settings |
| 42 | Select one aspect-preserving axis using bordered bounds, budget explicit requests as well as scale. Reject non-finite/nonpositive dimensions, size before render where measurable. Verify actual PNG IHDR/JPEG SOF before publishing; reject unsafe or unbudgetable explicit requests rather than attach oversized bytes | Tall, wide, small and border-heavy pages; width precedence, vector sizing | Preserve forced unembedded preview and ownership |
| 44 | Preflight regular file, open without blocking on special files where supported, check handle type/size, read at most limit+1, close in finally. Failure must not become “size unknown” followed by rendering. Pass the same Work budget through validation, geometry and both stored/native animation analyses. Charge inside ancestor/route/step/target loops and before retaining each diagnostic, including helper-local arrays. On exhaustion throw the typed budget stop, not a generic parser error; only the outer validator converts it to incomplete. Charge forwarded findings once, not again on merge. Non-validator callers omit the optional budget | Large valid graphs explicitly incomplete; ordinary examples unchanged | Never report truncated results as clean |
| 45 | Store bounded byte prefixes without retaining backing large buffers, drain both pipes. Surface operation and safe launch/exit code/signal/timeout category and advice, not child text | Discovery still needs bounded parsed version | No private marker in conversation/details |
| 46 | Exact full-ref guard; validation separate from privileged job; reviewed action commit pins | Must publish validated revision when separately authorized | No live dispatch/tag/publish |
| 53 | Decode only Unicode scalar values; substitute U+FFFD for invalid references. Normalize line breaks and escape literal text at final Markdown interpolation, including headings, groups, IDs and verbs. Index existing endpoints independently of labels; stable `(unlabeled <id>)`; include wrapper/inner edge label and child labels in document order without duplication | Preserve report's intentional Markdown; truly dangling terminals omitted | No extra links, images, HTML or headings from user prose |
| 62 | Absolute operands at process boundary for inputs, output and temp; spaced names remain single argv elements | Retain safe pure-builder APIs where possible | Keep already-canonical opener; no trust/shell redesign |

## Proof

| Id | Check that shows it is fixed | Measurement to repeat |
| --- | --- | --- |
| 35 | Registered same-name fixture | Compare bytes in both directories |
| 43 | Root planner/runner refuses; nonroot proceeds | Mocked argv, launch count and diagnostic |
| 61 | Pre-install privacy qualification | Mentions requests and both attached image types |
| 42 | Real tall/wide, oversized explicit, embedded override | Width × height, ratio and PNG chunks |
| 44 | Harmless nested graph stops inside ancestor traversal; separate valid envelope with several motion/sequence diagnostics stops at emission before delegate arrays grow | Single shared work/diagnostic counts across helpers, one blocking incomplete marker; ordinary control complete and non-validator callers unchanged |
| 45 | Noisy failing stand-in exits; next call works | Retained bytes and absence of marker |
| 46 | Parsed jobs/steps against branch, tag, other branch | Validation has only contents read |
| 53 | Parse generated Markdown and compare text nodes/relations | No unintended markup, malformed codepoint cannot erase other components |
| 62 | Mock argv export, file/inline conversion, layout and POSIX open | Dash-leading name and ordinary spaced name each one absolute operand |

## Accepted

None of the remaining findings are accepted. Retain previously delivered safeguards.

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Limits | Fixed conservative defaults, smaller internal test limits | Public tuning options | Deterministic bounds without weakening defaults. |
| Failure privacy | Safe categories and advice | Regex-redacting arbitrary child text | A private label need not resemble a secret. |

## Open questions

None for repository changes. Hosted environment settings are not asserted from workflow source; see infrastructure design.
