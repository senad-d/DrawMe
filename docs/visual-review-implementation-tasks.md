# Visual Review and Fixing Implementation Tasks

## Goal

Make DrawMe's automatic review loop reliably catch and correct canvas, layout, typography, element-overlap, and connector problems before asking for user approval or creating final exports.

## Current gaps

- `/drawme` injects guidance for the model; it is not an enforced workflow or state machine.
- The current self-check asks the model to inspect every visual concern at once and caps automatic review at two rounds.
- `drawio_export` reports a preview path as text, so the model must independently remember to read the PNG with vision.
- The injected workflow does not explicitly revalidate after every visual edit.
- Validator errors block progress, but warnings do not have a clear resolution or acceptance gate.
- Canvas validation only catches negative positions. It does not compare content bounds with `pageWidth` or `pageHeight`.
- Connector analysis only covers explicitly waypointed routes, and missing edge geometry is not currently rejected.
- Text size, clipping, wrapping, contrast, and rendered edge routes remain primarily visual concerns.
- Review limits conflict: the main workflow allows two automatic rounds while troubleshooting guidance refers to five rounds.

## Decisions

- Replace the broad review step with focused, ordered quality passes.
- Keep the first implementation agent-driven rather than introducing a full extension state machine.
- Strengthen deterministic validation where geometry can be checked reliably; leave rendered typography and automatic edge routing to vision review.
- Revalidate after every source edit, regardless of whether the edit came from automatic review or user feedback.
- Preserve a final human approval step before final export.
- Keep preview dimensions within model vision limits, but explicitly assess whether full-diagram scaling makes labels unreadable.

## Focused review sequence

1. **Canvas and composition**
   - Check page bounds, content margins, clipping, excessive empty space, aspect ratio, major alignment, and overall balance.
2. **Nodes and typography**
   - Check shape overlap, label clipping, wrapping, font readability, contrast, padding, sizing, and alignment.
3. **Connectors**
   - Check endpoints, arrowheads, line stacking, crossings, routes through unrelated elements, connector labels, and routing corridors.
4. **Semantics and final polish**
   - Check requested components and relationships, visual hierarchy, consistency, legends, grouping, and remaining regressions.
5. **Holistic regression check**
   - Confirm that fixes from later passes did not reintroduce failures from earlier passes.

Each focused pass must follow: preview, inspect one category, make targeted edits if needed, validate, and re-preview before advancing.

## Implementation tasks

### 1. Refactor the injected `/drawme` workflow

Files:

- `src/workflow.ts`
- `tests/integration.test.ts`, or a new focused workflow test file

Tasks:

- [x] Replace the current broad two-round self-check with the focused review sequence above.
- [x] Tell the model to handle one review category at a time instead of attempting every visual concern in one pass.
- [x] Require `drawio_validate` after every XML or Mermaid-converted `.drawio` edit.
- [x] Require every validation warning to be fixed or explicitly recorded as reviewed and acceptable before final export.
- [x] Define one consistent automatic correction limit and use it in every reference. Count passes and correction retries unambiguously.
- [x] Stop automatic correction at the configured limit and request focused user feedback or offer `drawio_open` instead of looping indefinitely.
- [x] Require a final holistic regression preview after all focused passes.
- [x] Require explicit user approval before `mode: "final"` exports.
- [x] Use distinct preview output names to identify focused passes, for example `.review-canvas.png` and `.review-connectors.png`, while retaining only the latest file.
- [x] Preserve the existing behavior for unavailable CLIs, draw.io versions below 30, and requested formats; keep only the latest successful preview and clean it after final export.

Acceptance criteria:

- The generated workflow names every focused pass and its acceptance checks.
- Every correction path returns through validation before another preview.
- The workflow has no conflicting two-round/five-round language.
- Tests verify the ordering, revalidation requirement, approval gate, and correction limit.

### 2. Attach preview images to preview tool results

Files:

- `src/index.ts`
- `src/drawio.ts` if preview result metadata needs to change
- `tests/integration.test.ts`
- `tests/drawio.test.ts` as appropriate

Tasks:

- [x] Keep the existing text result with the output path and export metadata.
- [x] For a successful PNG preview, read the generated file and add an `ImageContent` block to the tool result.
- [x] Use MIME type `image/png` and base64 data in the Pi-supported tool-result format.
- [x] Return image content only for successful preview PNGs; preserve text-only failure behavior.
- [x] Avoid attaching final embedded exports unless there is a documented need.
- [x] Confirm behavior when the selected model or run mode cannot consume images; the text path must remain a usable fallback.
- [x] Keep preview tracking, but remove each superseded same-source preview after its replacement succeeds.
- [x] Add tests for text-plus-image preview results, MIME type, and failure results without image blocks.

Acceptance criteria:

- The model receives the actual preview in the same tool result and no longer depends solely on a separate file-read call.
- Existing export callers and cleanup tests continue to pass.

### 3. Strengthen deterministic structural validation

Files:

- `src/validate.ts`
- `src/index.ts`
- `tests/validate.test.ts`

#### 3.1 Edge geometry

- [x] Report an error when an edge lacks an `mxGeometry` child.
- [x] Report an error when edge geometry does not have `relative="1"` and `as="geometry"` as required by the authoring contract.
- [x] Add regression tests for valid and invalid edge geometry.

#### 3.2 Canvas and content bounds

- [x] Parse page settings from each `mxGraphModel`, including `page`, `pageWidth`, `pageHeight`, and `pageScale` where relevant.
- [x] Define and document behavior when page dimensions are omitted.
- [x] Compute absolute visible-content bounds, including nested container offsets.
- [x] Include visible vertices, containers, edge labels, and explicit waypoints where practical.
- [x] Warn when content extends beyond the left, top, right, or bottom page boundary.
- [x] Warn when a child visibly extends beyond its parent container, excluding intentional border ports and relative edge labels.
- [x] Warn when content has less than the documented minimum outer margin.
- [x] Add a conservative warning for a canvas that is substantially larger than its content and produces excessive empty space.
- [x] Keep diagnostics page-specific for multi-page files.
- [x] Add tests for right/bottom overflow, nested overflow, valid margins, omitted page dimensions, and multi-page files.

#### 3.3 Readability diagnostics

- [x] Surface the existing readability score in the tool's text output, not only in result details.
- [x] Extend the score with canvas or containment findings only if weights are documented and remain comparable across variants of the same graph.
- [x] Investigate conservative static checks for labeled-node wrapping, very small explicit fonts, and obviously insufficient geometry.
- [x] Add only checks with acceptable false-positive behavior; keep uncertain typography judgments in the visual pass.
- [x] Clearly separate errors, actionable warnings, and informational observations.

Acceptance criteria:

- A shape beyond `pageWidth` or `pageHeight` no longer validates without a warning.
- Missing edge geometry is rejected before export.
- Existing clean examples remain free of unexpected warnings, or intentional warnings are documented and corrected.
- Tool output makes the readability score and unresolved warning count visible to the model.

### 4. Improve authoring guidance for canvas and readability

Files:

- `assets/references/xml-authoring.md`
- `assets/references/troubleshooting.md`
- `assets/references/diagram-types.md` only where type-specific guidance is needed
- `.golden.sha256`

Tasks:

- [x] Add explicit page attributes to the XML skeleton or document when an infinite/non-page canvas is appropriate.
- [x] Explain how to calculate content bounds and choose `pageWidth` and `pageHeight` with consistent outer margins.
- [x] Add guidance for resizing the canvas after layout changes.
- [x] Define recommended minimum body and connector-label sizes while documenting legitimate exceptions such as compact ports.
- [x] Add guidance for node padding, wrapping, line count, and long-label sizing.
- [x] Explain that a 2000px full-diagram preview can make dense diagrams unreadable and should trigger layout simplification, page splitting, or focused review.
- [x] Replace the conflicting troubleshooting iteration limit with the workflow's chosen limit.
- [x] Update the golden hash intentionally after changing files under `assets/` and document why it changed.

Acceptance criteria:

- A model following the XML reference can produce an appropriately sized canvas without guessing.
- Guidance and runtime workflow use identical review terminology and limits.

### 5. Keep only the latest review artifact and dispose of it safely

Files:

- `src/workflow.ts`
- `src/drawio.ts`
- `tests/drawio.test.ts`

Tasks:

- [x] Define predictable names for focused review artifacts.
- [x] Remove the prior same-source preview only after its replacement export succeeds.
- [x] Keep the previous preview when a replacement export fails.
- [x] Serialize exports per source so concurrent preview calls cannot leave multiple latest artifacts.
- [x] Confirm that the first successful final export removes the remaining latest preview.
- [x] Preserve the final output if it resolves to the latest preview path.
- [x] Report cleanup warnings without invalidating a successful replacement or final export.
- [x] Add or update tests for focused preview replacement and cleanup behavior.

Acceptance criteria:

- Only the latest successful preview file for a source remains after each review iteration.
- No review artifact remains after a successful final export unless cleanup explicitly reports a failure.

### 6. Update public documentation and the workflow example

Files:

- `README.md`
- `docs/reference.md`
- `CHANGELOG.md`
- `example/drawme-how-it-works.drawio`
- `example/drawme-how-it-works.drawio.png`

Tasks:

- [x] Replace the seven-step overview's broad review wording with the focused quality-pass workflow.
- [x] Document which findings are deterministic and which require vision.
- [x] Document that preview results include the image when implemented.
- [x] Document validation-warning resolution and the final approval gate.
- [ ] Update the workflow diagram to show the focused passes and regression check.
- [ ] Validate and export the updated example with the DrawMe tools.
- [x] Add an Unreleased changelog entry describing the quality-review improvements.

Acceptance criteria:

- Runtime guidance, agent reference, README, troubleshooting, and example diagram describe the same workflow.

### 7. Add scenario and regression coverage

Files:

- `tests/validate.test.ts`
- `tests/drawio.test.ts`
- `tests/integration.test.ts`
- New fixtures under `tests/fixtures/` if needed

Tasks:

- [x] Add a diagram whose content exceeds the right and bottom canvas boundaries.
- [x] Add a nested-container overflow case.
- [x] Add missing and malformed edge-geometry cases.
- [x] Add long-label and small-font cases for any accepted static readability checks.
- [x] Add a dense but valid graph that demonstrates limits of waypoint-only connector analysis.
- [x] Verify preview tool results contain an image block when the real CLI is available.
- [x] Verify failure text never includes a stale image block.
- [x] Verify workflow prompt construction and focused pass ordering without requiring the CLI.
- [x] Keep real-CLI tests skippable when draw.io is unavailable.

Acceptance criteria:

- Every new behavior has deterministic regression coverage.
- Visual limitations that cannot be asserted automatically are documented in test names or fixture notes.

### 8. Perform manual workflow verification

Tasks:

- [ ] Run `npm run validate`.
- [ ] Run `/drawme` for a small five-node flowchart and verify the focused passes do not create unnecessary edits.
- [ ] Run `/drawme` for a wide architecture diagram and verify canvas fit and preview readability.
- [ ] Run `/drawme` for a dense graph with multiple connectors and verify connector review is isolated from typography review.
- [ ] Run `/drawme` with long labels and nested containers.
- [ ] Verify behavior on draw.io below version 30, where Mermaid conversion and ELK layout are unavailable.
- [ ] Verify user feedback after automatic review triggers a targeted edit, revalidation, focused recheck, and final regression preview.
- [ ] Verify final export removes all review previews and reports only retained deliverables.

Acceptance criteria:

- All automated checks pass.
- The tested workflows require no manual intervention before the human approval step unless the documented correction limit is reached.

## Suggested implementation order

1. Workflow refactor and workflow-prompt tests.
2. Preview image attachment and export-result tests.
3. Edge-geometry and canvas-bound validation.
4. Authoring references and consistent limits.
5. Public documentation and workflow example.
6. Full automated and manual verification.

## Out of scope for the first implementation

- A separate vision model or nested model call inside the extension.
- Full OCR or pixel-level text measurement in TypeScript.
- Perfect deterministic analysis of draw.io's automatic edge routing.
- Arbitrary draw.io CLI flags or unbounded preview dimensions.
- A persistent workflow state machine unless prompt-driven focused passes remain unreliable after these changes.
