# Issue #34: Release audit: remaining confirmed findings

## Request coverage

| Request (native issue titles) | Delivery / boundary |
| --- | --- |
| Issue #34: Release audit: remaining confirmed findings | Tasks 1–19 deliver the missing deltas on base `12aa08e`. The seven audit areas overlap; numbers below track scenarios, not delivery order. Kinds: bug, hardening, refactor, testing, infrastructure, documentation. Not a release dispatch. |
| #35 Resolve tool paths against the Pi session working directory | 13, 14 — actual registered reads, writes and defaults |
| #36 Prevent concurrent animation saves from losing page edits | 4, 5, 12 — shared pathname/file-identity transactions, including hard links |
| #37 Honor cancellation throughout queued and running exports | 1, 8, 12–14 |
| #38 Detect and run stock draw.io reliably on headless Linux | 1, 8 |
| #39 Validate export page selection and account for CLI index versions | 2, 8, 13, 14, 19 |
| #40 Ensure export format, file bytes and editability receipts agree | 8, 14 — stage suffix/signature and chunk-boundary checks exist; close PNG chunk integrity gap before IEND repair or success, plus conflicting suffix and editable JPEG receipts. Do not redo publication |
| #41 Validate stored animation overrides before saving or rendering | 12 |
| #42 Bound preview attachments and keep editable metadata out of previews | 8, 14 — preview embedding override already disabled; size both axes and explicit raster requests, prove actual metadata |
| #43 Keep Linux renderer sandbox enabled for privileged execution | 1, 8, 19 |
| #44 Enforce bounded XML intake and validation work | 2–6, 8–10, 12, 13 — common intake, shared budget through geometry and motion helpers, explicit incomplete result |
| #45 Bound and sanitize renderer failure diagnostics | 1, 8 |
| #46 Restrict release workflow ref and isolate publishing permissions | 15 — repo policy plus existing npm environment rule; no dispatch |
| #47 Preserve authored page settings when laying out and fitting imports | 5, 14 |
| #48 Include floating edge terminals in canvas bounds | 3 |
| #49 Recognize bare graph models consistently across diagram readers | 2, 6, 9, 10 |
| #50 Report malformed XML and invalid containment hierarchies | 9 |
| #51 Preserve effective visibility and unique IDs in storyboards | 12, 14 |
| #52 Honor visibility and require effective visual motion | 6, 12, 14 |
| #53 Render diagram explanations as safe literal text with complete relations | 10 |
| #54 Make readability diagnostics reflect diagram geometry and finding kinds | 3, 9 |
| #55 Correct WSL Windows-renderer file arguments | 1, 5, 8, 14, 18, 19 — refuse Windows renderer on Linux/WSL, support native Linux |
| #56 Detect actual Mermaid and layout CLI capabilities | 1, 5, 7, 8, 13, 14, 18, 19 |
| #57 Ensure verified animated SVGs do not silently depend on local files | 6, 14 |
| #58 Queue drawme workflow messages when the Pi session is busy | 13, 14 |
| #59 Fix shape search tokenization and validate limits | 11, 13 |
| #60 Make preview result handling reflect actual attachment state | 13, 14, 18 |
| #61 Disclose model-provider access to requests and preview images | 18 — before installation |
| #62 Pass option-looking filenames as file operands, not CLI flags | 1, 5, 7, 8, 13, 14 — keep already absolute opener document and export stage; remaining input/import/layout argv and coverage |
| #63 Do not terminate a long-lived viewer after desktop open succeeds | 1, 7 — lifetime only |
| #64 Return an actual output file when a directory is requested | 8, 14, 19 — directory already rejected by publication; retain file-only behavior and close regression/reference gap |
| #65 Make animated-export command handle or explain stored motion | 13, 14, 19 — explain native-only mode and actionable stored-motion alternative |
| #66 Strengthen the packaged runtime dependency gate | 17 |
| #67 Test actual PNG editability at the renderer boundary | 14 — native zTXt-marker check exists; recover expected model/cells |
| #68 Make Mermaid and layout tests exercise the intended paths | 5, 7, 14 |
| #69 Make renderer test fixtures portable and clean up temporary files | 1, 5, 7, 8, 12, 14, 16 — keep existing main native-group teardown, fix remaining success-only cleanup |
| #70 Remove duplicated SVG helpers and unreachable motion branch | 6 |
| #71 Correct the Git install source and packaged example links | 18 |
| #72 Document export size, margin and public dimension contracts | 8, 13, 14, 19 |
| #74 Align documented motion limits and storyboard sampling with behavior | 6, 13, 18, 19 |
| #75 Correct command, preview-lifetime and failure guidance | 13, 14, 18, 19 |
| #76 Correct development gate and historical review instructions | 18 |
| #77 Make Mermaid input exclusivity match the documented contract | 5, 19 |
| Out of scope | No live CI/Sonar, publishing, bot PRs, change to intentional skips, speculative/style work; no redo of source alias/prior artifact/preview ownership protections, tool-supplied executable trust, shell/application selection/authorization, or absent/static connector verification. Preserve their tests. |
| Internal renderer/import boundaries | 1, 5, 8: split only the existing CLI responsibilities needed to apply one platform/capability policy on every route without multiple writers of `drawio.ts`. Keep its public imports working. |
| Existing outside account: `npm` deployment environment | 15: repo administrator confirms default-branch-only/no-tag setting before a real release. No live settings, account creation or credentials required for this implementation. |

## Contracts

Names below are integration points, not new tools or public settings. Except for added validation/attachment details, preserve existing return shapes and module exports.

| Name | Provider → consumers | Exact interface and invariants |
| --- | --- | --- |
| Renderer | `src/renderer.ts` → export/import/facade/tests | Move `DrawioInfo`, `resolveBinary(trustedOverride?: string, signal?: AbortSignal): Promise<DrawioInfo>`, `run(bin: string, args: string[], timeout?: number, signal?: AbortSignal): Promise<{stdout: string; stderr: string}>`, `xvfbScreen(args: string[]): string`, `openFile(path: string): Promise<{opener: string}>`. `invokeRenderer(binary: string, args: string[], signal?: AbortSignal): Promise<string>` returns the command description. `DrawioInfo` retains available/binary/version/major/supportsMermaid/supportsLayout and adds optional `reason?: string` for actionable unavailability. Numeric version ≥30.2.4 enables both feature flags. No fallback to raw child diagnostics. |
| XML pages | `src/xml-input.ts`, `src/dom.ts` → all diagram readers | `readDiagramXml(path: string, maxBytes?: number): Promise<string>` throws on non-regular/over-budget input, default 16 MiB. `diagramPages(root: DomEl): DomEl[]` returns direct `diagram` children of `mxfile` (zero for an empty envelope), `[root]` only for a single root `diagram` or bare `mxGraphModel`, and rejects any other root; `pageModel(page: DomEl): DomEl \| null` returns self for bare model or direct child otherwise. Count page envelopes independently of compressed content. |
| Work budget | `src/validation-budget.ts` → geometry, native/stored animation and validator | `createValidationBudget(maxWork: number, maxDiagnostics: number): ValidationBudget`; `ValidationBudget` exposes `work(units?: number): void` and `diagnostic(): void`. A charge exceeding remaining capacity throws `ValidationBudgetExceeded` **before** the operation or retention. Only `validateXml` converts that stop to `incomplete:true` plus one blocking marker. Pass the same object down; never reset at page/helper boundaries. With no budget, existing non-validator APIs behave as before. |
| Geometry | `src/geometry.ts` → fit/export/validator/storyboards | Preserve `contentBounds(cells: DomEl[], ids: ById, budget?: ValidationBudget): ContentBounds \| null`. `edgeLabelAnchor(cell: DomEl, route: Point[]): Point` resolves along-route fraction, signed normal and offset. Add optional trailing `budget?: ValidationBudget` through validator-reachable geometry including `isVisible`, `parentOrigin`, endpoint/route/label and bounds helpers; charge each parent/segment visit inside the traversal, not once at entry. `collectCells` may materialize effective wrapper value on its **analysis-only** inner cell; `collectCellsWithIds` must not mutate serialized DOM. |
| Edit transaction | `src/source-edits.ts` → animation, fit, layout, conversion | `withSourceEdits<T>(paths: readonly string[], action: () => Promise<T>, signal?: AbortSignal): Promise<T>` locks each canonical pathname (resolved parent + basename for an absent target) **and**, for each existing file, the target's shared `stat(path, {bigint:true})` device/inode key. Deduplicate/sort the whole key set; re-stat after waiting and retry acquisition if identity changed. Path keys bridge creation, identity keys unite hard links. Preserve the existing linked inode when editing in place; release on throw/abort. Hold across read/save/render. Export serialization is separate, so nested `exportDiagram` never reacquires this lock. No cross-process guarantee. |
| Import | `src/import-layout.ts` → drawio facade/Pi | Move `MermaidOptions`, `MermaidResult`, `LayoutOptions`, `LayoutPreset`, `LayoutResult`, `LAYOUT_PRESETS`, `mermaidArgs`, `layoutArgs`, `convertMermaid`, `applyLayout` from `src/drawio.ts`, unchanged signatures. Registered inline conversion supplies explicit session output. `output` in both results is a file, not a directory. |
| Export | `src/drawio.ts` → registered handlers/animation/tests | Preserve `exportDiagram(opts: ExportOptions, finishStagedSvg?: (path: string) => Promise<void>): Promise<ExportResult>`; add internal `ExportOptions.signal?: AbortSignal`. Never take it from model input. Re-export the former public Renderer/Import symbols at this facade. `pageIndex` stays public one-based, explicit selection needs ≥27.0.2. Final JPG cannot embed; successful explicit suffix matches format. Public width only. |
| Motion | `src/motion.ts`, `src/animation.ts`, `src/storyboard.ts` → orchestration | Preserve existing callers of `compileMotion`, `injectMotion`, `enhanceAnimatedSvg`, `buildStoryboard`, `sampleFrames`. For validation, `analyzeStoredMotion(model: DomEl, budget?: ValidationBudget)` and `analyzeAnimationPage(diagram: DomEl, budget?: ValidationBudget)` retain their result types and pass the budget into collection, step/target/ancestor analysis and diagnostic emission. Ineffective spec returns `compiled:null` plus errors; unresolved image dependency throws before verified publication. `AnimateOptions.signal?: AbortSignal` is internal, forwarded to both exports. For page 1 at the normal default SVG path keep `<source-stem>.storyboard.png`; otherwise `AnimateResult.storyboard` when present is `join(dirname(output), basename(output) + '.page-' + pageIndex + '.board.png')` (full SVG filename, decimal 1-based ordinal; `.board.png` cannot be a legacy `.storyboard.png`). `src/svg-helpers.ts` exports `cssString(value: string): string`, `walkElements(root: DomEl): DomEl[]`. |
| Validation | `src/validate.ts` → registered handler/tests | `validateXml(xml: string, limits?: Partial<ValidationLimits>): ValidateResult`; `validateFile(path: string, limits?: Partial<ValidationLimits>): Promise<ValidateResult>`. `ValidationLimits = {maxBytes:number; maxCellsPerPage:number; maxWork:number; maxDiagnostics:number}`; defaults in hardening Target. Keep errors/warnings/observations and score fields; add `incomplete:boolean`. On budget stop retain bounded findings plus one explicit blocking error; handler labels partial score, never says complete/clean. |
| Session | Pi registration → functional tests/docs | Use `ctx.cwd` for relative inputs/outputs (direct calls lacking ctx keep old base). `pi.sendUserMessage(workflow, {deliverAs:"followUp"})` once. PNG preview success returns text plus `image/png` only for positive vision capability and successful read; keep `details.imageAttached`, add `details.source` (canonical input) and `details.pageIndex` for history comparison. Consult actually attached blocks on current conversation branch, not just `replacedPreview`; missing comparable history means first-image critique. Final always text only. |
| Fixtures | `tests/fixtures.ts` → registered/native test files | `installNodeRendererFixture(scriptPaths: readonly string[]): () => void` is a test-only adapter for approved fixture scripts (real Node child, original argv, cleanup callback); allow additions through fresh installation per fixture. Keep `makeMockPi()` and `TINY_PNG`. No test hook on registered tool schemas. |
| Package gate | `scripts/check-package-contents.mjs` → local validation | Read `package.json.pi.extensions` and pack dry-run files. Exit 0 only if existing checks and runtime closure succeed; nonzero with missing relative path otherwise. No publishing or evaluation of packed extension code. |

All validity/threshold rules above are internal policies unless present in the existing public tool schema.

## File ownership

| Sole editing task | Shared surfaces it owns (others consume the contracts) |
| --- | --- |
| 1 | New `src/renderer.ts`, `tests/fixtures.ts` and direct runner/fixture tests. Exercise the new provider directly; facade/registered trust tests belong to 7. |
| 2 | `src/dom.ts`, new `src/xml-input.ts`, `src/validation-budget.ts` and helper tests. |
| 3 | `src/geometry.ts`, `tests/fitcanvas.test.ts`; 4 owns `src/fitcanvas.ts`. |
| 4 | `src/fitcanvas.ts`, new `src/source-edits.ts` and coordinated writer tests. No animation or export API changes here. |
| 5 | New `src/import-layout.ts`, `tests/mermaid-layout.test.ts` and direct import-preservation tests. |
| 6 | `src/motion.ts`, `src/animation.ts`, `src/svgexport.ts`, new `src/svg-helpers.ts`, compiler/structure tests. |
| 7 | `tests/process-trust.test.ts`, `tests/integration.test.ts`, `tests/animate.test.ts` — behavior-neutral fixture/skip migration before active facade changes. |
| 8 | `src/drawio.ts` (active facade), `src/png.ts`, `tests/png.test.ts`, `tests/drawio.test.ts` and new export regressions. Root/size planner assertions change with the actual policy. |
| 9 | `src/validate.ts`, `tests/validate.test.ts`. |
| 10 | `src/explain.ts`, `tests/explain.test.ts`. |
| 11 | `src/shapesearch.ts`, `tests/shapesearch.test.ts`. |
| 12 | `src/animate.ts`, `src/storyboard.ts` and new orchestration/independent-board/parallel-save tests. Consumes the working signal-aware export. |
| 13 | `src/index.ts`, `src/workflow.ts` and new registered-component tests, including new history/unknown-model assertions. All schema/help/notification changes land here. |
| 14 | New end-to-end test files only; reuse portable fixtures without editing the pre-existing integration suite. |
| 15 / 16 | 15: `.github/workflows/publish.yml` and release-policy tests; 16: `.github/workflows/ci.yml` and Windows matrix checks. |
| 17 | `scripts/check-package-contents.mjs`, package-closure regression. No manifest changes needed: locked TypeScript compiler API is available in dev tooling. |
| 18 | `README.md`, `example/README.md`, installation example source/render, `CLAUDE.md`, `CONTRIBUTING.md`, historical checklist, `tests/examples.test.ts` and first-use/gate documentation checks. |
| 19 | `docs/reference.md`, `CHANGELOG.md`, affected `assets/references/` texts, `.golden.sha256` and reference-contract checks. Only 19 regenerates the golden hash. |

## Verification

- For each slice run its boundary regressions and `npm run typecheck` with only its declared prerequisites. Provider tests call their own module; registered tests exercise the active facade with valid route operands. Do not leave an assertion waiting for a later behavior change.
- Use `npm ci --ignore-scripts`, then `npm run validate` on the merged change. Record golden → lint (typecheck, ESLint, format) → tests → pack and which native cases ran, not just a green count.
- With unprivileged desktop 32.4.1 and Xvfb, start the existing extension with `npm run dev`. In a disposable session with the offline driver or local model, check CLI, convert the three-node order flow, fit, validate, preview portrait/landscape and export. Inspect actual files and attachment blocks. Repeat with a finite dark two-page layout and a scratch copy of the packaged motion example; compare against `docs/research/release-audit-remaining.md`. No hosted provider required.
- Inspect recovered model/IDs in the native final PNG and absence in preview; verify page identity, SVG padded width, PDF media box, raster budget, storyboard draft invisibility and unchanged earlier board. No visual verdict from a text-only model.
- Confirm existing ownership, access, link/trailing-separator, prior artifact, connector verification and trusted-executable/opener tests still pass; prove a canceled or failed final does not retire a preview.
- Use small controlled fixtures for bounds, release ref truth table and disposable missing-module/final-embed/missing-input negative controls. Record the specific failing assertion and normal passing path; do not mutate the shipping checkout or dispatch a release.
- Inspect native Windows CI configuration and run portable tests there when available in normal CI. No request for live Actions/Sonar results and no claim a configured job actually ran.

Plan revision: #34/base-12aa08e/r2. No unresolved product choice. Hosted npm environment policy is an external pre-release check, not evidence inferred from this plan.

### 1. Run the renderer under a supported process policy

- [ ] Implement the Renderer contract for discovery, native invocation and desktop-launch acknowledgement.

#### Why

The host probes a different way from the way it renders, exposes raw diagnostics, and gives a viewer the renderer's expiration time. Process-policy decisions belong at the boundary all CLI routes use.

#### References

`docs/specs/release-audit-remaining-hardening.md#fix-per-finding` — #43/#45/#62 process and privacy rules.

`docs/specs/release-audit-remaining-bug.md#fix` — #37/#38/#55/#56/#63 cancellation, compatibility and viewer lifetime.

`docs/research/release-audit-remaining.md#compatibility-sources` — provenance of historical feature fixtures.

#### How

Depends on: none. Implement `src/renderer.ts` from the existing runner/probe/opener code under Renderer. Refuse unsupported privilege/platform before spawning native operations, preserving candidate order, safe path trust and native alternatives. Use the same Xvfb preparation for version and actual work. Drain bounded streams, parse a bounded version token, reap running children on abort or timeout, and clean all timers/listeners. Supply the test-only Fixtures adapter that executes designated fake scripts through Node with original argv (including paths with spaces), restores mocks, and can simulate an unprivileged renderer identity. Supply a verified complete 1×1 PNG fixture (check every chunk CRC; correct fixture bytes if necessary) for later integrity tests. For Linux document open acknowledge launch without timing out a surviving viewer; keep regular-file, canonical extension and no-shell checks. Exercise the **new module directly**, including its actual process wrapper, controlled probe/render and opener lifecycle; do not use `../src/drawio` or registered tools as proof of these new behaviors. Leave the existing facade and its expectations intact.

#### Where

`src/` — new renderer boundary.

`tests/fixtures.ts` — portable fake Node renderer adapter and valid tiny PNG.

`tests/` — direct renderer policy, streams, portable fixture proof and viewer lifetime tests.

#### Acceptance criteria

- Controlled headless stock probe and export succeed via wrapper; desktop goes direct. 30.0.4 and 30.2.4 produce opposite feature flags; ordinary export need not support import/layout.
- Root policy makes no unsafe launch; WSL Windows-only candidate yields native-Linux advice, native Windows and Linux controls remain usable. Spaced/dash-leading POSIX document remains one canonical operand.
- Noisy failure omits private marker and bounds retained bytes while draining to close. Abort reaps the running stand-in/process group and releases resources.
- A long-running foreground Linux viewer fixture returns promptly, survives past the former 15-second timeout, is explicitly cleaned up, and a genuine launcher error remains actionable.

### 2. Bound XML intake and identify page models consistently

- [ ] Provide the XML pages contract for bounded regular-file reads and bare/wrapped page discovery.

#### Why

Whole-file reads precede renderer timeouts. Readers disagree whether a valid root graph model is itself a page.

#### References

`docs/specs/release-audit-remaining-hardening.md#target` — byte budget and input classification.

`docs/specs/release-audit-remaining-bug.md#regression-checks` — #39/#49 equivalent pages and compressed control.

#### How

Depends on: none. Implement XML pages and the shared Work budget provider. Distinguish empty `mxfile` from the two valid single-page root forms and refuse unknown root tags. Provide a typed budget stop and test independent work/diagnostic counters are charged before use. Never feed oversized text to the parser; distinguish a missing model from compressed page text without expanding it. Keep limits injectable for tests only. Consumers should not require a model just to count a wrapped page.

#### Where

`src/dom.ts` — direct page/model helpers.

`src/` — new `xml-input.ts` and `validation-budget.ts`.

`tests/dom.test.ts` — shape equivalence.

`tests/` — bounded intake fixtures.

#### Acceptance criteria

- Small valid regular file succeeds; oversized, growing-past-limit and nonregular inputs fail without an unrestricted read. Benign special-file fixture cannot block the suite.
- Empty `mxfile` counts zero; bare model and root `diagram` count one, wrapped files count actual diagram envelopes even when compressed; unsupported roots fail. Tiny counters stop before exceeding either limit. No public tuning knob or decompression added.

### 3. Measure floating terminals and displaced labels

- [ ] Make geometry represent free edge ends, effective wrapper labels and displaced edge-label anchors.

#### Why

Fit and validation share geometry. An omitted free terminal can be cropped even though both consumers report success; a label off the route should not be warned about as if it sits on the line.

#### References

`docs/specs/release-audit-remaining-bug.md#fix` — #48/#54 coordinate and wrapper semantics.

`docs/specs/release-audit-remaining-bug.md#regression-checks` — independent coordinate and equality controls.

`docs/specs/release-audit-remaining-hardening.md#fix-per-finding` — #44 budget applies inside delegated geometry.

#### How

Depends on: Task 2. Implement Geometry and thread the optional Work budget through every validator-reachable helper chain. Charge **inside** parent walks (including effective visibility and accumulated origin), edge/label segment visits and nested bounds traversal before examining the next item; do not catch the budget stop. Distinguish connected ends from direct geometry terminal points, apply parent translation only once, honor effective visibility. Locate the route segment at the clamped fraction, use its signed normal and explicit offset (handle zero-length segments). Use the same anchor for separately sized labels. Materialize wrapper label/value only in the analysis projection, never changing a serialized source.

#### Where

`src/geometry.ts` — bounds, cell collection and label anchor.

`tests/fitcanvas.test.ts` — independently inspect fitted XML coordinates.

`tests/` — geometry/wrapper anchor regressions.

#### Acceptance criteria

- Vertex plus free end, edge-only graph and nested parent all fit inside known margins using actual transformed XML coordinates; hidden/connected fallback points do not enlarge bounds.
- A deeply nested but small benign graph with a tiny budget stops inside `parentOrigin`/visibility traversal; enough budget and omitted-budget callers give the normal coordinates. Plain/wrapped labels yield equivalent analysis text. Along-route, positive/negative normal and explicit displacement agree with known horizontal/vertical route fixtures.

### 4. Coordinate editable-source transactions by file identity

- [ ] Provide the shared edit boundary and use it for in-place and explicit-output canvas fitting.

#### Why

The export queue cannot recover an update already lost before export. Distinct pathnames, including hard links, may name the same editable file.

#### References

`docs/specs/release-audit-remaining-bug.md#fix` — #36 shared source/target identity.

`docs/specs/release-audit-remaining-testing.md#approach` — deterministic overlap and cross-writer controls.

#### How

Depends on: Task 2. Implement Edit transaction and use it around the entire read/modify/write in `fitCanvasFile`, including explicit destinations. Use XML pages for bounded intake. Derive path and existing-file identity keys before acquiring them in total order. On changes observed after waiting, release and recompute; release on failure/cancel. Fit updates an existing linked file in place. Test the transaction directly and with the actual fit mutator. This provider neither accepts animation options nor calls `exportDiagram`.

#### Where

`src/fitcanvas.ts` — bounded read and shared write coordination.

`src/` — new `source-edits.ts`.

`tests/` — identity, lock release and coordinated fit regressions.

#### Acceptance criteria

- Hold an edit on an existing diagram: fit through the same name, a symlink or a supported hard link waits, then reads the committed state. A disjoint file proceeds while the first is held. Confirm device/inode equality in the hard-link fixture; skip only that case if the filesystem lacks hard links.
- Missing output names coordinate by resolved parent/name; opposite input/output order does not deadlock. Abort/throw releases a waiting slot and subsequent fit completes.

### 5. Preserve page settings across native import and layout

- [ ] Convert exactly one Mermaid input into a fittable diagram and apply native layout without rewriting unrelated authored content.

#### Why

A successful native conversion can still leave a page the recommended fit step skips. A successful layout can wipe an authored background or page settings.

#### References

`docs/specs/release-audit-remaining-bug.md#fix` — #47/#55/#56/#77 geometry, feature checks and input selection.

`docs/specs/release-audit-remaining-hardening.md#fix-per-finding` — #44/#62 bounded XML and unambiguous operands.

`docs/research/release-audit-remaining.md#observed-outputs` — native finite/infinite controls.

#### How

Depends on: Tasks 1, 2, 4. Implement Import outside the facade, using Renderer, XML pages and Edit transaction. Require exactly one file or nonblank inline Mermaid before temp work; route capability and WSL diagnostics consistently. Anchor every file/temp/output operand without shell quoting. Enable finite canvas on newly generated XML only. For layout, work from the original diagram, feed a private native output into a geometry-only merge for the selected (currently first) page; preserve other pages and model/display settings even for in-place output. Don't add a page-selection option or run layout automatically on Mermaid output. Point this slice's guard/arg tests directly at the new Import module. Use Fixtures for a capable Node renderer and distinguish `input`-missing, CLI-missing (with otherwise valid input) and feature-incapable errors. No new behavior assertion here depends on a later facade re-export.

#### Where

`src/` — new `import-layout.ts`.

`tests/mermaid-layout.test.ts` — direct import/argv and exact capable/missing/old guard assertions.

`tests/` — import/layout boundary and geometry-merge cases.

#### Acceptance criteria

- Both inputs with distinguishable contents or neither input gives the specific input guard error, no conversion; file-only/inline-only continue to work. Removing the missing-input guard in a disposable copy turns the capable-fixture assertion red. Prove the fixture's version/output rather than accepting any rejection.
- Unsupported early renderer rejects each feature; native Linux paths with dash/space and inline temp paths arrive as file operands. Windows-only fallback is blocked with useful guidance.
- Overlapping placement changes while stable graph IDs, terminals, page background/dimensions, wrappers and other page remain intact. New import fits; intentional infinite authored input remains infinite.

### 6. Compile effective motion and verify standalone resources

- [ ] Require observable motion, preserve initial hidden states, verify portable image references, and unify the SVG primitives used to do this.

#### Why

Emitted CSS or elapsed time is not proof that a visible cell changes. A storyboard is optional; disabling it must not turn a static sequence into verified motion. An animated SVG with a local image dependency cannot be certified standalone.

#### References

`docs/specs/release-audit-remaining-bug.md#fix` — #49/#52/#57 state and verification rules.

`docs/specs/release-audit-remaining-refactor.md#what-moves` — #70 exact duplication/dead arm.

`docs/specs/release-audit-remaining-refactor.md#behaviour-that-must-not-change` — quoted IDs, preorder and wait timing.

`docs/specs/release-audit-remaining-hardening.md#fix-per-finding` — #44 work and findings budgets inside animation analysis.

#### How

Depends on: Tasks 2, 3. Implement Motion and consume XML pages, Geometry and Work budget on validator-facing paths. Pass the same optional budget through stored spec parsing/compilation and native sequence/cell analysis. Charge each potentially repeated step/cell/selector/ancestor visit and reserve diagnostics **before** constructing/appending them to helper arrays, not after a helper returns. Propagate `ValidationBudgetExceeded` unchanged (including through any parse-error catch); absent budget preserves existing non-validator calls. Model effective visibility at scheduled effect starts, distinguishing actual transitions from constant tracks. Reject all-ineffective sequences before source writes; preserve playback rules for time-zero hides and reduced motion. Inspect staged SVG image references on each animation dialect before success, without fetching them. Share `cssString` and root-inclusive `walkElements` in all three modules, remove only the per-cell wait case. Leave existing connector verification intact.

#### Where

`src/motion.ts` — stored compilation and injection.

`src/animation.ts` — native analysis, time-zero state and staged verification.

`src/svgexport.ts` — shared traversal use.

`src/` — new `svg-helpers.ts`.

`tests/motion.test.ts` — effective visibility, waits, boundaries and batch frames.

`tests/animation.test.ts` — bare/wrapped analysis and native tracks.

`tests/svgexport.test.ts` — helpers, resource references and source-structure check.

#### Acceptance criteria

- Wait-only/no-op rejected with and without requested storyboard before source/output mutation. Invisible child emphasis and repeated full entrance reject; after parent reveals, emphasis and dim→fade work. Actual emitted tracks keep a time-zero hide hidden while another cell animates.
- With a tiny work/diagnostic budget the stored analyzer and native analyzer each stop inside an ordinary multi-finding fixture; no unbounded before-return arrays. A normal-budget control completes with the same diagnostics as the omitted-budget caller.
- Both dialects refuse to certify unresolved image references; embedded images still work. Bare/wrapped graphs yield equivalent animation analysis.
- Structure check would fail on duplicate implementations/dead wait arm; quoted IDs, preorder and wait-between-effects preserve exact duration/frame count. Check 200/201 steps, timing limits, max pre-hold duration, multi-step parallel batch and 12-frame sampling boundaries.

### 7. Port the registered and native integration fixtures

- [ ] Make the existing functional tests exercise the intended runner, filenames and attachment evidence, without requiring a future behavior change.

#### Why

A `.drawio` destination for a PNG export can fail preflight before discovery, so a trust assertion may not reach the boundary it claims to cover. Legacy shebangs, an assumed capable major version and success-only cleanup also make the integration suite unreliable.

#### References

`docs/specs/release-audit-remaining-testing.md#data-and-environments` — #68/#69 portable runner and native fixture policy.

`docs/specs/release-audit-remaining-testing.md#risks` — false positives, cleanup and genuine attachment evidence.

#### How

Depends on: Task 1. Only change tests. Use Fixtures for known scripts and use the new Renderer detector directly for the native feature **skip predicate**, not the old facade's major version. Keep registered trust calls on the actual extension/facade; use `output.png` for export, `output.svg` for animate, `output.drawio` for import/layout, no output for check. Set a capable fixture version (30.2.4+), model spawn/close/unref, and assert the normal trusted version probe actually ran while the tool-supplied binary did not. These assertions pass on both the existing facade and its replacement; new renderer-policy behavior is already tested directly.

Port the integration and existing animation scripts to the Node adapter, using platform-native paths and explicit nonroot test identities where needed. Keep animation fixtures' existing SVG/PNG outputs and success/failure assertions intact. Keep main-group `afterAll`; replace success-only cleanup with hooks/finally. Preserve positive attachment/cleanup tests using explicit vision/text-only inputs and actual recorded prior image blocks on a fixture conversation branch. For absent model verify `imageAttached` equals actual image-block presence, rather than demanding the known-wrong fail-open value. Check tracked cleanup against actual files instead of pinning unconditional lifetime prose. Do **not** assert unknown-model refusal or new Session behavior yet: those exact regressions land with their implementation.

#### Where

`tests/process-trust.test.ts` — per-route operands, trusted discovery and opener mock lifecycle.

`tests/integration.test.ts` — portable registered fixtures, capability-specific native skip, cleanup and receipt controls.

`tests/animate.test.ts` — port the existing fake binary and identity setup before stricter renderer policy is active.

#### Acceptance criteria

- The intended fake runs through Node under spaced paths. The registered probe is reached on each route with a valid destination; negative trust assertions cannot pass merely because format preflight rejected the input.
- Existing attachment receipts agree with the actual content blocks, positive comparisons have real history, and real export paths/cleanup are observed. Native feature tests do not run on 30.0.4, do run on 30.2.4+, and clean up on failure.
- The changed suites pass without later facade or Session changes; no Windows-wide or behavior-masking skips.

### 8. Cancel exports safely and verify the requested page, format and size

- [ ] Finish the export boundary: preflight page and destination, fit actual raster limits, and let cancellation win until publication.

#### Why

The current staged artifact already protects source and prior output, but the caller can still get the wrong page, a misleading extension/editability receipt, an oversized preview, or a final after canceling.

#### References

`docs/specs/release-audit-remaining-bug.md#fix` — #37/#39/#40/#64 staged behavior and historical minimum.

`docs/specs/release-audit-remaining-hardening.md#target` — #42/#43/#45/#62 resource, invocation and diagnostic policies.

`docs/specs/release-audit-remaining-bug.md#regression-checks` — #40 corrupt IHDR and valid embedded-tail controls.

`docs/specs/release-audit-remaining-testing.md#risks` — retain shipped publication and repair guards.

#### How

Depends on: Tasks 3, 5, 7. Own the `src/drawio.ts` facade: use/re-export Renderer and Import, remove their superseded local implementations, preserve current public exports. Implement Export using XML pages and Geometry. Keep alias and invalid-file-path diagnostics before conflicting-suffix errors where existing regressions require them; never normalize away a terminal separator. Validate optional ordinal and CLI index convention, pass absolute input/stage operands, refuse root in planner as well as runner. Compute aspect-preserving bordered raster size and verify actual header before publication. Propagate abort through wait, probe, render and staged finalizer; recheck immediately before synchronous publish/retire. Verify PNG chunk integrity, including IHDR and IDAT CRCs, in `pngEndOffset` **before** complete-file acceptance or IEND repair. Preserve repair signatures and the existing staged verifier/order, not raw renderer stderr.

Migrate the existing planner/fixture assertions in this same change: expect root refusal and explicit raster budget, keep alias/error precedence, use a real one-page graph where a fake successful render explicitly selects page 1. Use Fixtures for Node stand-ins, native path joining and simulated nonroot. In the POSIX-only process-tree check pass a temp path containing spaces as a separate positional operand rather than interpolating it into an unquoted redirection; assert the intended child is reaped and clean up in `finally`. Run the prepared registered trust and integration suites unchanged against the now-active facade: the valid per-route suffixes must still lead to a trusted probe. No failing assertions or skips pending a later owner.

#### Where

`src/drawio.ts` — facade, queue, planner, staged verification and publication boundary.

`src/png.ts` — pre-tail CRC checks in staged PNG verification/repair.

`src/` — focused internal size/header helpers if needed.

`tests/png.test.ts` — corrupt IHDR intact/missing-tail and valid repair controls.

`tests/drawio.test.ts` — root/size expectations, portable fake argv, timeout path and failed publication.

`tests/` — new export preflight, sizing and queued/running abort tests.

#### Acceptance criteria

- Page 1 on an empty `mxfile` refuses before renderer invocation or output changes; page 1 on a valid bare or single wrapped page works. Invalid and unsupported explicit pages reject before output changes; verified convention selects actual requested content. Old CLI can still render unindexed input. JPG embedding and contradictory output suffixes cannot produce a false success.
- Clean portrait/landscape PNG attachments fit both axes with preserved aspect ratio. Oversized explicit raster requests are clamped or refused as specified, final rasters respect pixel budget, and all successes name regular files. Keep unembedded previews even with explicit `embed:true`.
- Aborted waiter settles without passing the live head; running abort reaps renderer, no publication or preview deletion, next export succeeds. No leak of private diagnostic marker.
- Change only the IHDR checksum of a known-good PNG; both intact and tail-truncated versions reject in `repairPngBuffer` and at staged export (no new success or replacement). A valid embedded PNG missing only its tail still repairs via `repairPng(path)`. Every complete pre-tail chunk is checked, not just its length.
- Existing symlink target refresh, prior artifact access/mode and cleanup protection, source-alias precedence, trailing separator refusal, malformed PNG refusal and one-argument embedded tail repair regressions stay green.

### 9. Return bounded, structural validation findings

- [ ] Make validation terminate within explicit limits and base errors, readability and score on structure.

#### Why

Recoverable parse errors and cyclic parents can look clean; diagnostic prose can change a score. An input too expensive to finish must not be reported as fully validated.

#### References

`docs/specs/release-audit-remaining-hardening.md#fix-per-finding` — #44 intake, page-work and retained-output limits.

`docs/specs/release-audit-remaining-bug.md#regression-checks` — #49/#50/#54 hierarchy, equality and displacement.

#### How

Depends on: Tasks 2, 3, 6. Implement Validation using XML pages, Geometry, Motion and Work budget. Construct one shared budget per validation and pass it into both analyzers and all validator-reachable geometry helpers; don't reset between calls/pages or double-charge on collection. Catch only the typed budget stop at the outer validation boundary, preserve bounded findings, append one blocking marker and set `incomplete:true`. Budget at emission and inside potentially combinatorial loops, not after building arrays. Reject over-limit byte input before parsing; expose explicit incomplete status on work/intake budget exhaustion. Collect xmldom recoverable/fatal diagnostics, check root existence and cycles iteratively. Tag scoring findings at origin, then render the existing text and weighted counts. Use wrapper text and resolved label anchor in both warnings and route/shape intersection calculations.

#### Where

`src/validate.ts` — input, bounded check/emission, structural checks and score.

`tests/validate.test.ts` — deterministic low budgets, validity and geometry/prose invariants.

#### Acceptance criteria

- Tiny byte/cell/comparison/diagnostic limits demonstrably bound work and retained results and report incomplete; normal examples stay complete. Prove a nested graph exhausts delegated ancestor traversal, and an ordinary page with multiple stored/native diagnostics stops in the helper before result arrays can grow beyond the limit. Assert the shared counts and one marker; normal control is complete, no clean-looking score on partial validation.
- Bare/wrapped/actually compressed cases distinguished; recoverable malformed attribute, missing root and single/multicell containment cycles report errors with useful identity. Valid quoted and empty rooted controls pass.
- Page name with warning keywords no longer changes score; all four categories retain original weights. Wrapped/plain labels get the same warnings; actual normal offset changes on-line advice and placement.

### 10. Explain diagram text and relations literally

- [ ] Return safe structured Markdown without losing verbs or existing unlabeled endpoints.

#### Why

The explanatory document should describe the diagram, not interpret its names as new headings or links. A malformed numeric reference should not cost the rest of the explanation.

#### References

`docs/specs/release-audit-remaining-hardening.md#fix-per-finding` — #53 rendering, labels, code points and endpoints.

`docs/specs/release-audit-remaining-bug.md#regression-checks` — #49 equivalent bare/wrapped graph control.

#### How

Depends on: Task 2. Use XML pages for bounded input and page selection. Separate text cleanup/Unicode decoding, graph indexing and final Markdown escaping. Keep intended headings/list formatting, stable unlabeled vertex names, wrapper and child edge verbs. Use the installed Markdown parser in tests to inspect parsed tokens, not regexes alone.

#### Where

`src/explain.ts` — entity handling, label/index relations, safe output.

`tests/explain.test.ts` — parsed Markdown and graph parity fixtures.

#### Acceptance criteria

- Page/title/component/container/verb punctuation stays literal: no additional links, images or headings; remaining content survives invalid code points.
- Both kinds of edge labels appear; unlabeled existing vertex appears via stable ID, truly dangling endpoint absent. Bare/wrapped versions match; compressed input remains distinguished.

### 11. Rank exact shape queries and enforce limits

- [ ] Preserve meaningful alphanumeric/camel-case terms and validate the requested number of results.

#### Why

The shipped index contains the exact shape, yet token loss sends the user to another shape; a negative limit is mistaken for a slice end.

#### References

`docs/specs/release-audit-remaining-bug.md#fix` — #59 normalization, ranking and limit rules.

#### How

Depends on: none. Update the existing search implementation (no index rebuild). Prefer exact normalized title, keep compound digit tokens intact, split camel case before normalizing, preserve existing AND/approximate fallback and stable order. Reject negative/fractional/nonfinite limit on the core API, zero returns empty.

#### Where

`src/shapesearch.ts` — parsing, scoring, entry point.

`tests/shapesearch.test.ts` — regressions against shipped index.

#### Acceptance criteria

- `ec2` at limit 1 returns EC2 first; `awsLambda` matches `aws lambda`. Limits −1/fraction fail, zero empty, positive respected, default remains ten. No new shapes or runtime dependency.

### 12. Serialize animation saves and preserve independent storyboards

- [ ] Use the working edit lock and cancellable exporter for the complete motion save, SVG and storyboard operation.

#### Why

The per-source export queue starts after animation has already read its source. Locking a pathname alone also misses aliases of the same inode. Flattening a hidden layer or reusing a board filename can make an apparently successful storyboard misleading.

#### References

`docs/specs/release-audit-remaining-bug.md#fix` — #36/#41/#51 source coordination, valid overrides, visibility and disjoint board names.

`docs/specs/release-audit-remaining-testing.md#approach` — barriers, two names for one source and independent outputs.

`docs/research/release-audit-remaining.md#observed-outputs` — original render versus exposed draft tile.

#### How

Depends on: Tasks 6, 8. Consume Edit transaction, XML pages, Motion, Export and Fixtures. Hold the edit lock from before reading the selected page through save and both exports, without reacquiring it inside the export queue. Add the internal signal to `AnimateOptions` and forward it to acquisition and both existing signal-aware export calls. Validate stored/effective overrides before writing. Filter effective visibility before reparenting; use disjoint tile chrome/clone IDs and remap terminals. Apply the Motion board naming contract. Use the prepared portable Node fixture for new orchestration tests and run the existing animation suite unchanged.

#### Where

`src/animate.ts` — lock full operation, signal forwarding, valid overrides, destination derivation.

`src/storyboard.ts` — visibility, clone and reference mapping.

`tests/` — new animation orchestration, transaction, override and board regressions.

#### Acceptance criteria

- Barrier-controlled simultaneous saves on two pages retain both specs and the correct two SVGs. Repeat through two existing hard-linked names when supported, verify both names see both edits and still share identity; interleave a fit using the same lock. No self-deadlock or unrelated-file serialization.
- Invalid holds on new/reused specs and ineffective motion with/without storyboard leave source and existing SVG unchanged. Successful unchanged reuse and hold boundaries work. Cancellation reaches edit acquisition and each renderer call.
- Page 1 of `order.p2.drawio` at its default SVG returns `order.p2.storyboard.png`; page 2 at explicit `order.svg` returns `order.svg.page-2.board.png` next to that SVG. Both boards exist and the first's bytes stay unchanged. Separate SVG directories/names retain identity. Hidden draft omitted; `frame`/`caption` source IDs cannot collide and endpoints resolve to intended clones.

### 13. Honor Pi session, attachment and command contracts

- [ ] Resolve user paths against the caller, report only real attachment state and send/describe workflows according to Pi's contract.

#### Why

Only the registered boundary knows the session cwd, current conversation, model capabilities and cancellation signal. Filesystem replacement is not evidence of an earlier image in the conversation.

#### References

`docs/specs/release-audit-remaining-bug.md#fix` — #35/#37/#58–60/#65 caller and receipt semantics.

`docs/specs/release-audit-remaining-documentation.md#docsreferencemd` — #56/#72/#74/#75 keep prompts and schema aligned with guidance.

`docs/research/release-audit-remaining.md#compatibility-sources` — verified Pi follow-up behavior.

#### How

Depends on: Tasks 9, 11, 12. Implement Session for all file-taking registered tools (export/animate/validate/fit/import/layout/explain/open) and `/drawme-export`, including implicit destinations. Keep `binary:undefined` at the tool boundary. Pass the supplied abort signal into Export and through `AnimateOptions`/its nested exports for the animation handler. Use Renderer flags in check tool, command notification and injected workflow. Use Validation incomplete status. Set schema for positive integer page and nonnegative integer search limit; do not expose height. Use Pi's active branch tool-result entries or equivalent scoped proof of an actual comparable attached PNG. Await regular readable image before constructing success text; failure resolves text-only. Wire follow-up delivery once, native-only animated command help/error, accurate sampled-board description and workflow cleanup/error guidance. Add the exact unknown-model, true prior attachment and lifecycle assertions with this behavior in new component tests, not in another owner's integration file. No redesign of review sequence.

#### Where

`src/index.ts` — schemas, registered tools/commands, history and results.

`src/workflow.ts` — injected capability/fit/review/failure instructions.

`tests/` — new registered-component cases using controlled tool/process boundaries.

#### Acceptance criteria

- Host/session same-name fixture: registered validate reads session, fit writes session only; all relative/implicit destinations (including inline Mermaid and command export) correctly anchored, absolute paths unchanged. Registered abort reaches queue/runner.
- Busy submission queues once, idle sends once; `/drawme-check` explicitly reports both feature capabilities with correct version, unavailable case actionable. Animated one-shot on the packaged example distinguishes native and stored formats and suggests `drawio_animate` without steps.
- Text-only→vision first attachment has no comparison claim; comparable vision→vision does. Unknown, different conversation/page, and unreadable/non-file outputs never claim image visibility; failure promise resolves. Final remains text-only. Use previous branch entries only if available, not speculative tracking.
- Workflow doesn't promise per-page/on-disk retention, identifies actual failure prefixes including animation and fit and distinguishes route warnings from detected crossings. It still runs eight correction retries without a human gate.

### 14. Prove delivered artifacts and registered behavior end to end

- [ ] Replace weak native assertions with recovery of actual artifacts, actual layout and actual session results; keep failure teardown reliable.

#### Why

A correct planner test cannot detect a missing flag at the native boundary. A signature or zTXt keyword is not a recovered editable diagram. Existing native feature coverage converts Mermaid but never actually invokes layout.

#### References

`docs/specs/release-audit-remaining-testing.md#approach` — #67–69/#72 artifact-level and mutation evidence.

`docs/specs/release-audit-remaining-bug.md#regression-checks` — end-to-end identity, page settings, visibility, resources and session cases.

`docs/research/release-audit-remaining.md#observed-outputs` — native visual controls.

#### How

Depends on: Task 13. Only add test files. Use Renderer, Import, Export, Motion, Geometry, Validation, Session and Fixtures. Build on the ported integration scenarios: explicit vision/history on positive cases, exact unknown-model and comparison cases at the registered boundary. Use actual feature flags for native skips and the portable adapter for deterministic cases. Every additional temp directory/child is cleaned on failure. Decode native PNG metadata to graph identity, not a flag; inspect actual JPG/PNG signatures/dimensions, SVG width and PDF media box. Use known labels/geometry/pixels and scratch examples for comparisons.

#### Where

`tests/` — new native artifact and registered functional test modules and decoding fixtures; no edits to existing suites.

#### Acceptance criteria

- Final PNG yields expected editable graph/cell IDs and relationship; a preview requested with `embed:true` still contains no editable diagram. Omitting `-e` only at final renderer forwarding makes the recovery assertion fail. Real preview attachments are clean and bounded on both axes.
- Valid pages 1/2 yield their distinct labels; final PNG area, pre-padding SVG width versus final margin, PDF media box and width-only registered schema match the documented contract. Regular output paths and format signatures match receipts; directory destination does not succeed.
- Native import→fit and successful layout of overlapping multipage input verify output path, moved placement, IDs, terminals, dark finite settings and untouched other page. Native local-logo animation either stands alone or gives explicit unresolved-dependency failure. Rendered board excludes hidden draft; inspect output pixels independently of visibility helpers.
- Registered route controls cover dash-leading/spaced operands, cwd, abort and command feedback on a scratch copy of `example/event-driven-orders.drawio`. Existing ownership/connector tests remain meaningful; stale “previous image” expectations are not retained as positive controls. Proper native skips only; standalone fixtures run without draw.io.

### 15. Isolate validation from release authority

- [ ] Restrict manual publication to the exact default branch after read-only validation and pin action implementations.

#### Why

A short ref name is not a branch identity. Running repository validation with OIDC and write permissions grants more authority than its checks need.

#### References

`docs/specs/release-audit-remaining-infrastructure.md#rollout` — #46 full-ref policy, same revision and deployment setting.

`docs/specs/release-audit-remaining-infrastructure.md#configuration-and-secrets` — least privilege and repository-reviewed pin sources.

#### How

Depends on: none. Split validation/publication jobs; guard release with exact full ref at job level and successful `needs: validate`. Keep validation read-only with no environment/OIDC. Restrict `npm` environment and write/OIDC grants to publish, no privileged project validation or project scripts. Pin release actions by reviewed full commits, keep supported npm/provenance and existing metadata/tag checks. Record the required existing deployment branch-only/no-tags setting in the owning workflow. Validate the YAML and ref policy statically, never dispatch or change hosted settings here.

#### Where

`.github/workflows/publish.yml` — release jobs, pins and policy.

`tests/` — independent static release-policy regression.

#### Acceptance criteria

- Exact default branch eligible, same-named tag and other branches ineligible. Privileged job cannot run before successful validation of same revision; no global write/OIDC or release environment in validation.
- Immutable action SHAs, metadata/version uniqueness checks, dist-tag restriction, provenance, publish-before-tag order and deploy setting are covered by static assertions. No release is performed.

### 16. Run the portable gate on native Windows

- [ ] Include a native Windows CI runner alongside the current Linux validation job.

#### Why

POSIX path assumptions cannot reliably be detected by a Linux-only matrix, even with a mocked Windows platform.

#### References

`docs/specs/release-audit-remaining-infrastructure.md#target` — #69 OS matrix, existing commands and permissions.

`docs/specs/release-audit-remaining-testing.md#data-and-environments` — portable fixture contract and skip boundary.

#### How

Depends on: Task 14. With all controlled and registered integration fixtures ported, extend the existing validation matrix, not the release or Sonar workflows. Run the same locked install and full gate on native Windows, distinct job names and runner-appropriate invocation. Fixtures are test-side; do not install a native desktop for the portable path or disable a failing portable group.

#### Where

`.github/workflows/ci.yml` — matrix and gate invocation.

`tests/` — static Windows matrix assertion.

#### Acceptance criteria

- Parsed CI config schedules both Linux and native Windows for normal events, retains read-only permissions and runs `npm ci --ignore-scripts` then `npm run validate` in both. No requirement to fetch or report live results.

### 17. Verify reachable runtime files in the packed manifest

- [ ] Make the packaging gate fail when any transitive runtime module is absent from what npm would ship.

#### Why

The checkout can pass tests while the installed extension fails to load. The present list verifies the entry point, not all of its runtime imports.

#### References

`docs/specs/release-audit-remaining-infrastructure.md#rollout` — #66 closure over relative runtime edges.

`docs/specs/release-audit-remaining-testing.md#approach` — pack-list mutation versus intact checkout.

#### How

Depends on: none. Implement Package gate using the locked TypeScript parser or equivalent syntax-aware resolution. Walk actual `pi.extensions` entries, resolve relative imports/re-exports including extensionless forms, deduplicate cycles, distinguish type-only/external dependencies. Compare every reachable project path to npm's dry-run list; retain current checks for assets, examples, required metadata and excluded files. Test in disposable pack fixture(s), not by changing runtime packaging on this branch.

#### Where

`scripts/check-package-contents.mjs` — actual pack membership decision.

`scripts/` — shared check helper if needed for fixtures.

`tests/` — pack-closure regression.

#### Acceptance criteria

- The normal package passes; omitting a reachable animation/motion/storyboard/SVG-export module at any depth from the pack list alone fails with the missing path. A type-only local reference does not create a false runtime requirement.
- New relative modules included by the other slices are checked automatically; no static list update per refactor.

### 18. Correct first-use, example and development guidance

- [ ] Tell readers what their provider can see, where the package installs from, what examples ship and which gate contributors actually run.

#### Why

These claims influence whether people share a diagram or install the package at all. Repository-only links and obsolete contributor instructions should not be presented as installed/current behavior.

#### References

`docs/specs/release-audit-remaining-documentation.md#content-per-page` — #55/#56/#60/#61/#71/#74–76 page-specific corrections.

`docs/specs/release-audit-remaining-documentation.md#conventions` — local vs repository links.

`docs/research/release-audit-remaining.md#compatibility-sources` — installed Pi parser's actual clone URL.

#### How

Depends on: Tasks 13, 17. Use Renderer, Motion, Session and Package gate contracts. Put privacy qualification before install, fix Git source, replace repository-only links without enlarging package manifest, and update existing installation diagram/linked render. Align example text with actual capability, WSL and preview policies; correct the README `drawio_animate` row's per-step promise to the actual sampled visual batches. Correct developer command/path/golden scope/full-gate descriptions; label the obsolete checklist historical and link current guidance. Add focused offline documentation checks, including real Pi parser `repo` and relative link targets against a pack dry-run. Use a canonical repository link for the example index rather than depending on npm's inclusion of a nested README. No remote clone.

#### Where

`README.md` — privacy, first use, examples and dev gate.

`example/README.md` — links/capabilities and scope.

`example/drawme-installation-guide.drawio` — CLI check and capability labels.

`example/drawme-installation-guide.drawio.png` — refresh edited example's linked image.

`CLAUDE.md` — actual single-test path/gate/golden scope.

`CONTRIBUTING.md` — full validation gate.

`docs/visual-review-implementation-tasks.md` — historical, not current policy.

`tests/examples.test.ts` — installation example facts.

`tests/` — first-use/privacy/link/developer-guidance checks.

#### Acceptance criteria

- Pre-install text distinguishes local rendering from requests and attached preview/storyboard images being available to configured provider. Explicit-host install string parses to actual GitHub clone URL; no broken relative package links or enlarged pack needed.
- README/diagram names actual supported CLI/version and notifications, including unsupported case. README board description matches tested `sampleFrames` and compiler behavior (at most 12 visual batches, parallel grouped, no wait-only frame). Reader can locate editable sources and rendered examples from either README.
- Referenced test path exists; documented golden scope and gate order match scripts incl. pack. Obsolete approval/retry language cannot be mistaken for current guidance.

### 19. Align the reference and authoring guidance with the tools

- [ ] Document the actual export, animation, validation, input and review contracts and protect their most important limits against drift.

#### Why

Authors use the injected guidance and reference to decide whether to deliver a file, retry, or claim visual verification. Incorrect sizing, board sampling or preview lifetime promises cause wrong decisions even with correct output bytes.

#### References

`docs/specs/release-audit-remaining-documentation.md#docsreferencemd` — #64/#65/#72/#74/#75/#77 contract details.

`docs/specs/release-audit-remaining-documentation.md#assetsreferencestroubleshootingmd` — #43/#55 supported renderer and sandbox guidance, distinct from desktop-open advice.

`docs/specs/release-audit-remaining-documentation.md#conventions` — audited authoring assets and intentional golden refresh.

`docs/specs/release-audit-remaining-testing.md#approach` — compare actual behavior rather than flags alone.

#### How

Depends on: Tasks 14, 18. Use Renderer, Import, Export, Validation, Motion and Session. Update reference tables and examples, authoring texts and changelog clarification, using the documented public width-only schema; do not add height. Keep failure prefixes and warnings in context, state true report/file lifetime, include actionable stored-motion route. Cross-check docs against boundary fixtures and actual schema/limits. In the shipped troubleshooting guide replace only the WSL Windows-renderer and Linux sandbox-disabling workarounds with supported unprivileged native Linux rendering (Xvfb when headless); leave desktop-open advice alone. Regenerate the golden asset hash once, including these reference edits.

#### Where

`docs/reference.md` — public contracts and examples.

`CHANGELOG.md` — clarify historical planner vs public dimensions and current changes, no release.

`assets/references/xml-authoring.md` — limits, batch frames and motion guidance.

`assets/references/mermaid-authoring.md` — actual capability threshold and fit.

`assets/references/diagram-types.md` — remove unconditional major-30 claims.

`assets/references/troubleshooting.md` — renderer-only WSL discovery and sandbox advice, not opener policy.

`.golden.sha256` — deliberate authoring-reference update.

`tests/` — reference/limit drift assertions.

#### Acceptance criteria

- Reference explicitly describes capped scale/area/long side, SVG width before margins and final padded size, PDF page bounds, public width not height, file-only destination and noneditable JPEG; reflects schema and inspected native files.
- Limits, standalone verification, actual board path, at most 12 sampled visual batches, parallel and wait behavior and dim-to-fade agree with compiler/boundary coverage. Native command and stored-motion alternative are unambiguous.
- Mermaid exclusivity/capabilities, session scope, actionable incomplete validation, unchecked auto-route warning vs crossing detection, failure prefixes, and process-local per-source cleanup agree with handlers. An offline check of the troubleshooting renderer entries identifies the supported native unprivileged route instead of `/mnt/c` renderer or sandbox-disabling advice; scope it away from opener entries. Golden check passes for only the intentional asset edits.
