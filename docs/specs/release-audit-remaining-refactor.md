# Release audit: share SVG primitives without changing valid timelines

Kind: refactor

## Purpose and scope

Issue #34, #70: “Remove duplicated SVG helpers and unreachable motion branch.” This is not a public API redesign. The separate behavior fixes in the bug design are not reasons to rewrite valid animation or connector verification.

## Structure today

| Part | Holds | Called by | Problem | File |
| --- | --- | --- | --- | --- |
| Native animation | `cssString`, `walkElements` | Opacity CSS, SVG verification | Independent copies | `src/animation.ts` |
| Stored motion | `cssString`, `walk`, wait case in per-cell switch | Selectors, SVG paths, compilation | Same primitives; valid waits have zero cells | `src/motion.ts` |
| SVG finishing | `walk` | Color pinning | Third preorder walker | `src/svgexport.ts` |

## Target structure

| Part | Holds | Called by | File |
| --- | --- | --- | --- |
| Shared SVG helpers | Attribute-selector string quoting; root-inclusive element preorder | Native and stored motion; traversal also by SVG finishing | `src/svg-helpers.ts` |
| Motion compiler | Wait contributes time to batch span, has no per-cell action | Existing animation/validation callers | `src/motion.ts` |

## What moves

| Item | From | To | Callers to update |
| --- | --- | --- | --- |
| `cssString` | Native and stored compilers | Shared SVG helpers | Group selectors, reduced-motion selectors |
| Root-first walk | All three modules | Shared SVG helpers | Defs lookup, verification, decorating paths, color rewriting |
| Wait arm | `compileMotion`'s per-cell switch | Remove; no replacement | Keep wait validation and batch timing |

## Behaviour that must not change

| Behaviour | Test that pins it today |
| --- | --- |
| Escapes quote, backslash and control characters in a cell id | `tests/animation.test.ts`, `tests/motion.test.ts` exercise compiled CSS; add precise quoted-ID cases. |
| Traversal includes root, children in document order, then their siblings | `tests/svgexport.test.ts` exercises nested colors; pin exact preorder with text and element siblings. |
| Wait between visible steps adds duration but no tile | `tests/motion.test.ts` timeline/frame cases; pin explicit duration and frame count. |

## Order

1. Pin the three observable behaviors before moving helpers.
2. Import one implementation in all three modules and remove the dead switch arm; retain public exports.
3. Add the #70 source-structure check for the imports/single definitions and absence of the per-cell wait arm, scoped to these modules (not every switch over effects).

## Data migration

None: no stored data moves.

## Rollback

| After step | How to go back |
| --- | --- |
| 1 | Keep behavioral coverage. |
| 2–3 | Restore call-site helpers and original switch together with the old structure assertion; no files on disk need conversion. |

## Decisions

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Scope | Move only matching SVG primitives | Consolidate animation dialects | Native sequences and stored motion have different semantics. |

## Open questions

None.
