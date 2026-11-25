# DrawMe examples

The `.drawio` files are the editable sources and are included in the npm package. The renders are hosted in the repository rather than shipped in the package. Each example has a final `.drawio.png` with embedded XML; the animated example also has a standalone SVG and a static storyboard.

| Diagram | What it demonstrates |
| --- | --- |
| [User flow](https://github.com/senad-d/DrawMe/blob/main/example/drawme-how-it-works.drawio.png) · [source](drawme-how-it-works.drawio) | **Multi-color:** numbered stages, native input/document shapes, blue authoring, purple quality, green delivery, a three-role legend, and explicit CLI/text-only fallbacks. |
| [Installation](https://github.com/senad-d/DrawMe/blob/main/example/drawme-installation-guide.drawio.png) · [source](drawme-installation-guide.drawio) | **Light:** three columns separate preparation, package scope, and first use; monospace commands distinguish terminal actions from commands inside Pi. |
| [Architecture](https://github.com/senad-d/DrawMe/blob/main/example/drawme-architecture.drawio.png) · [source](drawme-architecture.drawio) | All ten tools, pure-TypeScript checks versus desktop CLI operations, optional OS opening, and local rendering versus model-provider access. |
| [Validation decision tree](https://github.com/senad-d/DrawMe/blob/main/example/drawme-validation-decision-tree.drawio.png) · [source](drawme-validation-decision-tree.drawio) | Error/warning gates, attachment-aware review, correction of the current pass, eight-retry limit, explicit exceptions, and preview cleanup. |
| [Animated order fulfillment](https://github.com/senad-d/DrawMe/blob/main/example/event-driven-orders.animated.svg) · [source](event-driven-orders.drawio) · [PNG fallback](https://github.com/senad-d/DrawMe/blob/main/example/event-driven-orders.drawio.png) · [storyboard](https://github.com/senad-d/DrawMe/blob/main/example/event-driven-orders.storyboard.png) | **Dark:** 13 official AWS4 components in four zones, transactional outbox, SNS/SQS fan-out, idempotent Lambda consumers, queue-level redrive, and staged motion in a 12.56-second loop. |
| [Git graph](https://github.com/senad-d/DrawMe/blob/main/example/git-graph-example.drawio.png) · [source](git-graph-example.drawio) | Retained classic multi-color branching/merge example. Its commit IDs and version labels are illustrative, not this repository's current history. |

The showcase follows the **Light**, **Dark**, and **Multi-color** presets in [`style-presets.md`](../assets/references/style-presets.md). Installation, extension architecture, and the detailed validation reference stay Light. User-flow colors encode roles, not arbitrary decoration; the cloud example uses the Dark accent for its main path and motion. The Git graph intentionally keeps its classic palette.

## Correctness and scope

- Installation commands follow the version-matched Pi package/CLI documentation. Personal settings default to `~/.pi/agent/settings.json`; project settings require trust. `pi -e` starts a single invocation without changing settings, unlike persistent installation followed by `pi` or `/reload`.
- `/drawme-check` reports the detected CLI path and version and whether Mermaid import and ELK layout are supported, or gives an unavailable diagnostic. Both features require draw.io 30.2.4 or later; ordinary rendering and export do not. WSL requires native Linux draw.io, not the Windows executable.
- User/review flows are checked against [`src/index.ts`](../src/index.ts) and [`src/workflow.ts`](../src/workflow.ts). The correction cap is eight retries across the run, not eight per pass; inspection previews do not consume retries. A new pass starts only after the current pass is cleared, except for inspection-only completion after the limit.
- Without a usable CLI, `/drawme` stops at XML authoring and structural validation. Without an attached image, use structural review and report that rendered inspection was skipped. Successful previews and finals can remove superseded default preview files still owned and tracked by this process per source, not per page or across restarts. Pi transcript attachments are separate from those files; see the [export reference](../docs/reference.md#mode-and-naming-behavior) for cleanup rules.
- PNG, SVG and PDF embed editable XML by default; JPG cannot. Motion is stored on the `.drawio` page and verified in the standalone SVG. draw.io Desktop shows the static geometry, not DrawMe motion playback.
- The order architecture is an illustrative AWS design, not a deployment template. API Gateway invokes the Orders Lambda; a DynamoDB transaction commits order + outbox together. A stream-triggered publisher filters outbox records and publishes to an SNS standard topic. Separate SQS standard queues buffer both Lambda consumers. SNS/SQS delivery is at least once, requiring idempotency. The fulfillment queue's `maxReceiveCount` redrive policy sends repeatedly failed messages to its DLQ; the Lambda does not write directly to the DLQ. Notification retry/DLQ policy, authentication, IAM, telemetry, and deployment details are deliberately outside this example.

## Re-exporting after edits

Use the DrawMe tools from Pi, rather than invoking the desktop CLI directly:

1. `drawio_check({})` before any rendering.
2. After every source edit, `drawio_validate({ "input": "example/<name>.drawio" })`. Fix errors and warnings.
3. After layout changes, run `drawio_fit_canvas`, then validate again. Grow the canvas rather than shrinking the content.
4. Export a `mode: "preview"` PNG and review label fit, placement, connectors, and semantics. Validate and re-preview any correction.
5. For the order example, `drawio_animate({ "input": "example/event-driven-orders.drawio" })` reuses the stored steps, regenerates the animated SVG/storyboard, and verifies motion. Validate the source afterward and inspect the storyboard's order/visibility; it does not prove easing or dot movement.
6. Export the final PNG with `drawio_export({ "input": "example/<name>.drawio", "mode": "final", "format": "png" })`. This embeds XML by default. Check the result for actual preview removals or cleanup warnings. Keep the PNG fallback beside the animated SVG.
7. Run `npm run validate`. The tests discover every example source and require zero structural warnings; additional checks cover installation, user-flow relationships, and stored animation versus the exported SVG.
