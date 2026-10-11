# DrawMe examples

The `.drawio` files are the editable sources of truth. Each has a final `.drawio.png` with embedded XML. The animated example also includes a standalone SVG and a static storyboard.

| Diagram | What it demonstrates |
| --- | --- |
| [User flow](drawme-how-it-works.drawio.png) · [source](drawme-how-it-works.drawio) | **Multi-color:** numbered stages, native input/document shapes, blue authoring, purple quality, green delivery, a three-role legend, and explicit CLI/text-only fallbacks. |
| [Installation](drawme-installation-guide.drawio.png) · [source](drawme-installation-guide.drawio) | **Light:** three columns separate preparation, package scope, and first use; monospace commands distinguish terminal actions from commands inside Pi. |
| [Architecture](drawme-architecture.drawio.png) · [source](drawme-architecture.drawio) | All ten tools, pure-TypeScript checks versus desktop CLI operations, optional OS opening, and local rendering versus model-provider access. Replaces the obsolete waterfall overview. |
| [Validation decision tree](drawme-validation-decision-tree.drawio.png) · [source](drawme-validation-decision-tree.drawio) | Error/warning gates, attachment-aware review, correction of the current pass, eight-retry limit, explicit exceptions, and preview cleanup. |
| [Animated order fulfillment](event-driven-orders.animated.svg) · [source](event-driven-orders.drawio) · [PNG fallback](event-driven-orders.drawio.png) · [storyboard](event-driven-orders.storyboard.png) | **Dark:** 13 official AWS4 components in four zones, transactional outbox, SNS/SQS fan-out, idempotent Lambda consumers, queue-level redrive, and staged motion in a 12.56-second loop. |
| [Git graph](git-graph-example.drawio.png) · [source](git-graph-example.drawio) | Retained classic multi-color branching/merge example. Its commit IDs and version labels are illustrative, not this repository's current history. |

The showcase follows the **Light**, **Dark**, and **Multi-color** presets in [`style-presets.md`](../assets/references/style-presets.md). Installation, extension architecture, and the detailed validation reference stay Light. User-flow colors encode roles, not arbitrary decoration; the cloud example uses the Dark accent for its main path and motion. The Git graph intentionally keeps its classic palette.

## Correctness and scope

- Installation commands follow the version-matched Pi package/CLI documentation. Personal settings default to `~/.pi/agent/settings.json`; project settings require trust. `pi -e` starts a single invocation without changing settings, unlike persistent installation followed by `pi` or `/reload`.
- `/drawme-check` reports the detected CLI path and version. Mermaid conversion and ELK layout require draw.io v30+; ordinary rendering and export do not.
- User/review flows are checked against [`src/index.ts`](../src/index.ts) and [`src/workflow.ts`](../src/workflow.ts). The correction cap is eight retries across the run, not eight per pass; inspection previews do not consume retries. A new pass starts only after the current pass is cleared, except for inspection-only completion after the limit.
- No CLI means XML authoring and structural validation only. No attached image means structural/semantic review, with rendered inspection explicitly unverified. A successful final export removes the latest preview in either vision mode.
- PNG, SVG and PDF embed editable XML by default; JPG cannot. Motion is stored on the `.drawio` page and verified in the standalone SVG. draw.io Desktop shows the static geometry, not DrawMe motion playback.
- The order architecture is an illustrative AWS design, not a deployment template. API Gateway invokes the Orders Lambda; a DynamoDB transaction commits order + outbox together. A stream-triggered publisher filters outbox records and publishes to an SNS standard topic. Separate SQS standard queues buffer both Lambda consumers. SNS/SQS delivery is at least once, requiring idempotency. The fulfillment queue's `maxReceiveCount` redrive policy sends repeatedly failed messages to its DLQ; the Lambda does not write directly to the DLQ. Notification retry/DLQ policy, authentication, IAM, telemetry, and deployment details are deliberately outside this example.

## Re-exporting after edits

Use the DrawMe tools from Pi, rather than invoking the desktop CLI directly:

1. `drawio_check({})` before any rendering.
2. After every source edit, `drawio_validate({ "input": "example/<name>.drawio" })`. Fix errors and warnings.
3. After layout changes, run `drawio_fit_canvas`, then validate again. Grow the canvas rather than shrinking the content.
4. Export a `mode: "preview"` PNG and review label fit, placement, connectors, and semantics. Validate and re-preview any correction.
5. For the order example, `drawio_animate({ "input": "example/event-driven-orders.drawio" })` reuses the stored steps, regenerates the animated SVG/storyboard, and verifies motion. Validate the source afterward and inspect the storyboard's order/visibility; it does not prove easing or dot movement.
6. Export the final PNG with `drawio_export({ "input": "example/<name>.drawio", "mode": "final", "format": "png" })`. This embeds XML and removes the review preview. Keep the PNG fallback beside the animated SVG.
7. Run `npm run validate`. The tests discover every example source and require zero structural warnings; additional checks cover installation, user-flow relationships, and stored animation versus the exported SVG.

Rendered files are checked into Git for documentation. The npm package includes editable `.drawio` sources; README images are hosted from the repository.
