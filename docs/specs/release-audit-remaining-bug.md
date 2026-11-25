# Release audit: diagram, renderer and session correctness

Kind: bug

## Purpose and scope

“Issue #34: Release audit: remaining confirmed findings.” IDs below are the native issue numbers. The supplied audit records the before cases; file/symbol references identify the surviving causes on the planning base. Security budgets, disclosure, workflow authority, test gaps and documentation are specified in their companion designs. Apply only the missing delta, not the original audit against an older tree.

## Reports

| Id | Reported, in the reporter's words | Where |
| --- | --- | --- |
| 35 | Resolve tool paths against the Pi session working directory | `src/index.ts` |
| 36 | Prevent concurrent animation saves from losing page edits | `src/animate.ts`, `src/fitcanvas.ts`, `src/drawio.ts` |
| 37 | Honor cancellation throughout queued and running exports | `src/index.ts`, `src/drawio.ts` |
| 38 | Detect and run stock draw.io reliably on headless Linux | `src/drawio.ts` |
| 39 | Validate export page selection and account for CLI index versions | `src/drawio.ts`, `src/index.ts` |
| 40 | Ensure export format, file bytes and editability receipts agree | `src/drawio.ts`, `src/png.ts` |
| 41 | Validate stored animation overrides before saving or rendering | `src/animate.ts` |
| 47 | Preserve authored page settings when laying out and fitting imports | `src/drawio.ts`, `src/fitcanvas.ts` |
| 48 | Include floating edge terminals in canvas bounds | `src/geometry.ts` |
| 49 | Recognize bare graph models consistently across diagram readers | `src/validate.ts`, `src/explain.ts`, `src/animation.ts` |
| 50 | Report malformed XML and invalid containment hierarchies | `src/validate.ts` |
| 51 | Preserve effective visibility and unique IDs in storyboards | `src/storyboard.ts`, `src/animate.ts` |
| 52 | Honor visibility and require effective visual motion | `src/motion.ts`, `src/animation.ts` |
| 54 | Make readability diagnostics reflect diagram geometry and finding kinds | `src/validate.ts`, `src/geometry.ts` |
| 55 | Correct WSL Windows-renderer file arguments | `src/drawio.ts` |
| 56 | Detect actual Mermaid and layout CLI capabilities | `src/drawio.ts`, `src/workflow.ts` |
| 57 | Ensure verified animated SVGs do not silently depend on local files | `src/animation.ts`, `src/motion.ts` |
| 58 | Queue drawme workflow messages when the Pi session is busy | `src/index.ts` |
| 59 | Fix shape search tokenization and validate limits | `src/shapesearch.ts` |
| 60 | Make preview result handling reflect actual attachment state | `src/index.ts` |
| 63 | Do not terminate a long-lived viewer after desktop open succeeds | `src/drawio.ts` |
| 64 | Return an actual output file when a directory is requested | `src/drawio.ts`, `docs/reference.md` |
| 65 | Make animated-export command handle or explain stored motion | `src/index.ts`, `src/animation.ts` |
| 77 | Make Mermaid input exclusivity match the documented contract | `src/drawio.ts` |

## Reproduction

| Id | Steps or input | What happens | What should happen |
| --- | --- | --- | --- |
| 35 | Same relative filename in process and session directories; validate then fit | Reads/writes host copy | Only session copy is touched |
| 36 | Concurrent saves to two pages with two SVG paths | Last whole-document save wins | Reload shows both specs and both matching SVGs |
| 37 | Abort queued or rendering final after preview | Final can publish and retire preview | Neither happens; subsequent work runs |
| 38 | Stock binary, no DISPLAY, working Xvfb | Raw version probe fails | Discover and export through compatible preparation |
| 39 | Two labeled pages, select 0, 1.9, 3; select 1 and 2 across desktop conventions | Wrong page can succeed | Invalid/unsupported selection changes nothing; supported content matches ordinal |
| 40 | Request PNG at `.jpg`, or explicit editable JPEG | Staged encoder now produces PNG but filename can mislead; JPEG receipt can claim embedding. A checksum-corrupt IHDR passes intact and can still receive a repaired tail | Contract agrees from path to bytes and receipt |
| 41 | Override hold with −1 or 60001 on a stored spec | Invalid override passes | Same failure as new spec before writes |
| 47 | Import then fit; native layout a finite dark page in a two-page file | Fit skips import; authored display settings reset | New import can fit; layout changes placement, not presentation or other page |
| 48 | Edge extends to x=480 beyond a vertex; repeat edge-only and nested | Canvas can end at x=160 | Both visible ends are within margin |
| 49 | Read equivalent bare, wrapped and compressed fixtures | Bare mistaken for missing/compressed | Same graph results; compressed remains distinguished |
| 50 | Recoverable unquoted attribute, missing root, self- and two-node cycles | Can return no errors | Each invalid structure reported; empty rooted graph clean |
| 51 | Hidden-layer tile, source cells `frame`/`caption`, two page outputs | Draft visible; ambiguous clone refs; storyboard overwritten | Only visible clones with distinct IDs; independent boards |
| 52 | Wait-only/no-op dim; time-zero hide beside a fade; emphasize child before parent enters | Static success, lost hide, invisible emphasis | Require observable motion, preserve initial state, reject invalid targets |
| 54 | Rename page with diagnostic keyword; wrap label; displace label normal to route | Score changes without geometry; missing/improper warnings | Counts and positions match geometry, not prose |
| 55 | Windows `.exe` selected on WSL for mounted input or inline temp | Linux operands sent to Windows | No incompatible process invoked |
| 56 | 30.0.4 versus 30.2.4 | Both marked capable | Conservative verified cutoff separates them |
| 57 | Animate a local logo; copy SVG away from logo | Verified output depends on local image | No standalone success for unresolved resource |
| 58 | Submit `/drawme` while streaming | Pi rejects omitted policy | Exactly one follow-up; idle submission still immediate |
| 59 | Query `ec2`, `awsLambda`; limits −1, 1.9, 0, 1 | Wrong rank, lost compound, misleading slice | Exact title first; compound equivalent; reject invalid limits |
| 60 | Text-only → vision → unknown, or read failure after export | False previous-image claim; unknown attaches; rejection escapes | Feedback describes actual block in this session |
| 63 | Foreground viewer alive past 15 s | Renderer timeout kills viewer | Prompt success after launch; no lifetime timeout |
| 64 | PDF output is existing directory | Old audit returned directory; current publication rejects non-file | Retain rejection and document/test it |
| 65 | `/drawme-export` animated SVG on packaged order example | Native-only error despite stored motion | State dialect and give usable alternative |
| 77 | Supply different inline and file inputs | File wins silently | Reject both before conversion |

## Cause

| Id | File and symbol | Why | Certainty |
| --- | --- | --- | --- |
| 35 | `src/index.ts`, registered execute/command handlers; `src/drawio.ts:convertMermaid` | Handlers pass paths through; `convertMermaid` derives the inline output from `process.cwd()` | Source |
| 36 | `src/animate.ts:animateDiagram`, `src/drawio.ts:withSourceExportQueue` | Serializing export is too late for read/modify/write | Source + audit |
| 37 | `src/index.ts:drawio_export`, `src/drawio.ts:run`, `publishExport` | Signal discarded; no cancellation checkpoint | Source |
| 38 | `src/drawio.ts:resolveBinary`, `invoke` | Only rendering wraps Xvfb | Source + audit |
| 39 | `src/drawio.ts:planExport`, `pageContentSize` | Pass-through number; missing page treated as unmeasurable | Source + tagged evidence in research note |
| 40 | `src/drawio.ts:planExport`, `verifyRenderedFile`; `src/png.ts:pngEndOffset` | Stage suffix and PNG chunk boundaries are checked, not the chunks' CRCs; embed override and display suffix can mislead | Source |
| 41 | `src/animate.ts:resolveSpec` | Reused spec mutated after parser acceptance | Source |
| 47 | `src/drawio.ts:applyLayout`, `convertMermaid` | Native XML replaces page/model settings wholesale | Native observation in research note |
| 48 | `src/geometry.ts:contentWaypoints`, `contentBounds` | Looks at waypoint array, not direct free terminal points | Source |
| 49 | `src/validate.ts:checkPage`, `src/explain.ts:cellsOf`, `src/animation.ts:pageModel` | Only inspect children of page | Source |
| 50 | `src/validate.ts:validateXml`, `checkCellReferences` | No parser diagnostic sink, missing root treated as zero cells, existence isn't acyclicity | Source |
| 51 | `src/storyboard.ts:storyboardCell`, `buildStoryboard`; `src/animate.ts:animateDiagram` | Removes layer ancestry; prefix doubles as chrome ID; filename derived only from input | Native visibility + source |
| 52 | `src/motion.ts:compileMotion`, `src/animation.ts:compileOpacityTimeline` | Own opacity only; constant tracks accepted as proof or filtered away even when different from base | Source + audit |
| 54 | `src/validate.ts:validateXml`, `labelBox`, `labelOnLineWarning`; `src/geometry.ts:collectCells` | Scores rendered strings; wrapper value absent; relative normal offset not applied | Source |
| 55 | `src/drawio.ts:CANDIDATES`, `invoke` | WSL-mounted `.exe` treated as native | Source contract, not native WSL execution |
| 56 | `src/drawio.ts:resolveBinary`, `requireBinary` | Major-only gate | Source + tag option tables (#56) |
| 57 | `src/motion.ts:injectMotion`, `src/animation.ts:enhanceAnimatedSvg` | Verifies motion but not linked image resources | Source + audit |
| 58 | `src/index.ts:drawme` | `sendUserMessage` has no delivery policy | Installed Pi runtime, research note |
| 59 | `src/shapesearch.ts:parseTerms`, `rankMatches` | Lowercases before splitting; drops digits; unchecked slice | Source |
| 60 | `src/index.ts:modelSupportsImages`, `exportResult` | Unknown defaults true, file replacement is not conversation history, promise returned without await | Source |
| 63 | `src/drawio.ts:openFile` | Linux opener uses 15-second renderer runner | Source + audit |
| 64 | `src/drawio.ts:publicationPath`, `preserveFileAccess` | Shipped regular-file checks now reject directory/trailing separator; no need to rediscover CLI-created child | Source |
| 65 | `src/index.ts:drawme-export` | `animated` selects native verification not stored-motion compiler | Source + example |
| 77 | `src/drawio.ts:convertMermaid` | Truthy path bypasses inline branch | Source |

## Fix

| Id | What changes | What stays although it looks related |
| --- | --- | --- |
| 35 | Anchor user file operands at session cwd before deriving defaults. Preserve absolute spelling and terminal separators (don't collapse `..` across symlink parents). For inline Mermaid supply session `diagram.drawio` explicitly. | Bundled references resolve relative to extension; never chdir or forward executable selectors. |
| 36 | Acquire pathname and existing-file identity locks (device + inode, shared by hard links) in stable order around read→modify→save→export, including fit, layout and conversion writing that source. Keep export queue separate to avoid nested lock acquisition. | Independent sources can proceed; no cross-process service. |
| 37 | Propagate signal through discovery, queue, child and staged finalization. Reject promptly while waiting without letting a successor overtake the active job. Reap on abort; check immediately before synchronous publish/retire. | Already-completed publication not rolled back; preserve existing staging/cleanup rules. |
| 38 | Use same headless preparation for probe and render; preserve ENOENT-only wrapper fallback, timeout, desktop path. | No tool-controlled binary. |
| 39 | Count direct diagram envelopes of an `mxfile`, including compressed pages: zero children means zero pages. A bare `mxGraphModel` or root `diagram` counts as one; reject unknown envelopes. Validate positive integer and range before stage creation. For explicit page requests require verified one-based desktop ≥27.0.2; older/unknown gets clear minimum before rendering. | Do not ban older CLI for ordinary non-indexed export. |
| 40 | Reject explicit filename whose suffix conflicts with the promised format (case-insensitive, `.jpg`/`.jpeg` equivalents); reject final JPG `embed:true`. Check each complete pre-tail PNG chunk's stored CRC against its type and data before accepting a complete PNG or offering the existing embedded-only IEND repair. A corrupt header/body is never fixed by changing its tail. Match attachment MIME to verified PNG only. | Keep staging/publication, the one-argument file repair API, valid embedded missing-tail cases and forced-unembedded preview. |
| 41 | Merge specified loop/hold into the candidate, validate the entire effective spec once; reject invalid stored representation rather than inadvertently laundering it. | Valid reuse remains `saved:false` when unchanged. |
| 47 | Stage native layout result, transfer selected page's layout geometry by stable IDs into original model, retaining wrappers, root metadata, attributes and other pages. Fail on unmatchable graph. Mark newly converted Mermaid model finite before fit. | Do not turn an intentionally infinite authored page finite; no extra layout after Mermaid. |
| 48 | Include direct `sourcePoint`/`targetPoint` only for free ends, apply parent origin once, skip invisible edges. Fit already shifts top-level terminal points. | Connected endpoints determined by vertices; no guessed auto-route. |
| 49 | Use XML pages contract for direct bare model vs diagram child. Distinguish compressed nonempty text from missing model. | No decompression. |
| 50 | Capture recoverable and fatal parser diagnostics as errors. Require model's `root`; walk cell parent graph with visitation states and name cycle IDs. | Absent parent on root cell OK; empty well-formed `<root/>` OK. |
| 51 | Filter authored effective visibility before reparenting; disjoint clone/chrome IDs with per-tile mapping for parent and terminals. Drop edges referencing omitted hidden clones rather than redirect. Keep the legacy default page-one board; give all qualified boards a different terminal suffix and include the full SVG basename and page ordinal in its output directory (Motion contract). | Keep captions, frame opacity, first/last sampling, static review only. |
| 52 | Validate effective visibility at each action's start including ancestor states and same-batch start times; require a real transition/draw/dot for a stored timeline, not scheduled time or a CSS marker. Native flow-only export keeps its existing verification path. Reject repeated full-opacity entrance, allow dim-to-fade. For native initial hides emit constant playback state distinct from base alongside changing tracks. | Preserve reduced-motion fallback and the shipped connector verification; stationary waits can separate valid changes. |
| 54 | Attach category at detection, preserve score weights. Use wrapper label/value and fallback inner value for checks. Resolve along-route fraction, normal displacement (mxGraph's signed perpendicular), then explicit x/y offset for both placement and on-line decisions. | Keep existing message arrays, declared approximations and weights. |
| 55 | Explicitly decline Windows renderer on Linux/WSL with diagnostic recommending native Linux draw.io. If native candidate is available use it; do not wrap `.exe` in Xvfb. | Native Windows still supported; no wslpath or temp conversion protocol. |
| 56 | Use numeric version tuple ≥30.2.4 for both audited features, fail closed for unknown versions. Probe/handlers/skip predicates/workflow consume capabilities, not `major`. | Static export is not gated on Mermaid. |
| 57 | Inspect render-visible image references in staged animated SVG on both dialect paths. Accept embedded data/local fragment references; refuse non-self-contained linked images (file URLs, filesystem, relative or external href/xlink:href) with actionable embed-image advice. | Do not fetch or embed arbitrary files; ordinary static export unchanged. |
| 58 | Send once with Pi follow-up policy; no busy/idle race or duplicate submission. | Empty description remains usage-only. |
| 59 | Split camel case before lowercasing, retain intact alphanumeric tokens (EC2), boost exact whole title, keep stable fallback ordering. Validate nonnegative integral limit before lookup/slice. | Index contents and default ten unchanged. |
| 60 | Unknown/text-only means no image. Await verified regular readable PNG before claiming attachment. Track last actual preview attachment per session/source/page and replacement, not just on-disk ownership; clear comparison eligibility on nonattached replacement/final, don't leak across branches/sessions. | Nonimage finals text-only; no new preview cleanup manager. |
| 63 | For Linux only, spawn existing authorized opener with detached lifetime and ignored stdio, acknowledge successful start (surface spawn/observed immediate launch failure), unref; no renderer timeout. | Canonical file/extension checks, OS association and no-shell behavior unchanged. |
| 64 | Document file-only destination and test successful file receipt; retain shipped rejection. | Do not add directory-output support or alter alias/symlink policy. |
| 65 | Keep one-shot native export. Usage, command description and animated failure explicitly distinguish stored `drawmeMotion`; advise `drawio_animate` on that input with `steps` omitted. | No silent second renderer run or source edit. |
| 77 | Require exactly one nonblank inline text or nonempty file path; reject both/neither before temp file or rendering. | Existing single-input forms remain supported. |

## Regression checks

| Id | Behaviour a test must prove | Nearby behaviour that must still hold |
| --- | --- | --- |
| 35 | Registered validate/fit, export command, relative outputs and implicit inline import use distinct session fixture | Host bytes unchanged, absolute path still targets original |
| 36 | Barrier-controlled two-page saves retain both stored specs and corresponding SVG groups via the same pathname and via two existing hard-linked names; interleave fit or layout | Both names still reference the same edited file, failure releases lock; unrelated files proceed independently |
| 37 | Hold queue head, abort waiter; abort signaled running stand-in; no final/retirement, fixture exited, next call finishes | Normal final still retires owned preview |
| 38 | Displayless probe and render reach working stock stand-in via Xvfb | Desktop probe direct |
| 39 | Explicit page 1 on `<mxfile/>` is refused before invocation/writes, but works on a bare model and single diagram; 0/fraction/past-end rejected with existing bytes intact; 26.2.15 explicitly refused for selection, 27.0.2/32.4.1 get one-based args; actual two-page outputs identify requested labels | Compressed page count not confused with measurable content |
| 40 | Flip only a known-valid PNG's IHDR CRC: intact and tail-truncated variants both fail, publish nothing, preserve previous bytes. Conflicting suffix and editable JPEG never written; format signatures match receipts | Valid embedded PNG missing only its tail still repairs via `repairPng(path)`; complete valid PNG remains unchanged |
| 41 | −1 and 60001 invalid on new/reused specs; source and existing SVG unchanged | 0 and 60000 accepted |
| 47 | Native layout changes overlapping placement, retains dark finite settings and other page; native Mermaid → fit fits | Infinite authored control still skipped |
| 48 | Read XML terminal coordinates and add known parent offsets independently; edge-only fit measurable | Hidden and overridden terminal points don't enlarge bounds |
| 49 | Same graph bare/wrapped: compare validator arrays, Markdown and native animation analysis | Real compressed sample still skipped/reported |
| 50 | Bad attribute/absent root/self-cycle/longer cycle each yields errors | Valid quoted XML and empty rooted graph clean |
| 51 | Draft color absent in rendered tiles; all IDs unique, connector references correct, first board bytes survive second page or different SVG, including page 1 default of `order.p2.drawio` versus page 2 at `order.svg` | Both distinct boards exist, compatible default name retained; visible nested clones render |
| 52 | No output/source changes for ineffective motion, with/without board; time-zero hidden target has emitted hidden state, child emphasis before/after parent and repeated entrances distinguished | Wait between effects, dim→fade, valid playback/reduced motion preserved |
| 54 | Name-only edits leave category counts/score identical; wrapped/plain warnings equivalent; separated versus inline labels distinguished | Crossing, overlap, through and anchor counts still score as before |
| 55 | Mounted-drive export and inline Mermaid with Windows-only candidate give actionable refusal without sending operands | Native Linux file operands unchanged except absolute anchoring |
| 56 | 30.0.4 off; 30.2.4 on; handlers as well as reports reflect result | Missing CLI distinct from unsupported features |
| 57 | Animate local-logo fixture: self-contained data after copying or explicit dependency failure, never verified `file:` image | Embedded resource still succeeds |
| 58 | Registered busy mock queues exactly once, idle mock starts once | No provider needed |
| 59 | Shipped EC2 first at 1; `awsLambda` matches spaced; −1, fraction rejected; 0 empty; positive capped | Existing approximate shape search remains available |
| 60 | Text-only → vision says first attachment; comparable vision→vision prompts comparison; unknown, other page/session and unreadable output never claim prior image | Unreadable result resolves with failure text, not rejection |
| 63 | Controlled long-lived foreground stand-in remains alive past old 15 s deadline after prompt return; test cleans it up | Missing launcher gives useful failure |
| 64 | Existing directory rejected; every successful receipt names regular file with promised format | Retain trailing-separator refusal |
| 65 | One-shot on scratch copy of packaged orders example explains native vs stored and names working alternative | Native animated success unchanged |
| 77 | Distinguishable file and inline contents together rejected with no conversion | Valid file and valid inline each succeed |

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Historical index, WSL fallback | Explicitly limit unsupported operations | Guessing an index/encoding or Windows temp path | An actionable refusal is better than a plausible but incorrect diagram. |
| Misleading receipt | Reject rather than rename output, fetch external images or switch animation dialect | Implicit conversions or second render | No unexpected files, network or source mutation. |
| Imported vs authored page | Set finite on fresh import only | Change global fit semantics | The authored infinite canvas is intentional. |
| Board naming | Preserve the existing page-one board beside the default SVG; use a disjoint `.board.png` suffix plus full SVG basename and page number for all others; return actual path | Single shared source stem | Independent pages and explicit SVG destinations remain independently reviewable. |

## Open questions

None blocking. The app did run: `docs/research/release-audit-remaining.md` records native renders and official Pi transcript views, not a live terminal screenshot. No visual design change to Pi itself is intended.
