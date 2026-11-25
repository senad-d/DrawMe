import { copyFile, readFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { resolveBinary } from "../src/drawio";
import drawme from "../src/index";
import { installNodeRendererFixture, makeMockPi } from "./fixtures";

vi.mock("../src/drawio", { spy: true });

async function commandFixture(version = "32.4.1") {
  const workspace = await mkdtemp(join(tmpdir(), "drawme command fixture "));
  onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  const dir = await realpath(workspace);
  const binary = join(dir, "drawio.mjs");
  await writeFile(binary, `import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) console.log(${JSON.stringify(version)});
else writeFileSync(args[args.indexOf("-o") + 1], '<svg xmlns="http://www.w3.org/2000/svg" width="100px" height="50px"/>');
`);
  const restore = installNodeRendererFixture([binary]);
  vi.stubEnv("DISPLAY", ":99");
  vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
  onTestFinished(() => {
    restore();
    vi.unstubAllEnvs();
  });
  return { ...makeMockPi(), dir, notify: vi.fn<(message: string, type: string) => void>() };
}

it("queues /drawme exactly once as a follow-up when the session is streaming", async () => {
  const { pi, commands, notify } = await commandFixture();
  const sendUserMessage = vi.fn((_message: string, options?: { deliverAs?: string }) => {
    if (!options?.deliverAs) throw new Error("Pi rejected the message: deliverAs is required while streaming");
  });
  drawme({ ...pi, sendUserMessage } as never);
  await commands.get("drawme")!.handler("a flowchart for order dispatch", { isIdle: () => false, ui: { notify } });
  expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("a flowchart for order dispatch"), { deliverAs: "followUp" });
});

it("includes Mermaid and layout capabilities in the /drawme-check notification", async () => {
  const { pi, commands, notify } = await commandFixture();
  drawme(pi as never);
  await commands.get("drawme-check")!.handler("", { ui: { notify } });
  const [status, level] = notify.mock.calls[0];
  expect(level).toBe("info");
  expect(status).toContain("32.4.1");
  expect(status).toMatch(/Mermaid.*layout|layout.*Mermaid/is);
});

it("gives actionable stored-motion guidance for /drawme-export on the packaged orders example", async () => {
  const { pi, commands, dir, notify } = await commandFixture();
  drawme(pi as never);
  const input = "event-driven-orders.drawio";
  await copyFile(new URL(`../example/${input}`, import.meta.url), join(dir, input));
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    await commands.get("drawme-export")!.handler(`${input} animated-svg`, { cwd: dir, ui: { notify } });
  } finally {
    process.chdir(originalCwd);
  }
  const [status, level] = notify.mock.calls[0];
  expect(level).toBe("error");
  expect.soft(status).toMatch(/stored motion|drawmeMotion/i);
  expect.soft(status).toContain("drawio_animate");
  expect(status).toMatch(/(?:omit|without).*steps/i);
});

it("starts /drawme exactly once when idle and injects current review and failure guidance", async () => {
  const { pi, commands, notify } = await commandFixture();
  const sendUserMessage = vi.fn();
  drawme({ ...pi, sendUserMessage } as never);
  await commands.get("drawme")!.handler("an order flow", { isIdle: () => true, ui: { notify } });
  expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("an order flow"), { deliverAs: "followUp" });
  const [workflow] = sendUserMessage.mock.calls[0];
  expect(workflow).toContain("Mermaid import: supported; ELK layout: supported");
  expect(workflow).toContain("allow at most 8 correction retries");
  expect(workflow).toContain("never pause to ask for approval");
  expect(workflow).toContain("tracked by this process per source, not per page or across restarts");
  expect(workflow).toContain("Transcript attachments are separate from files");
  expect(workflow).toContain("`Animate failed:`");
  expect(workflow).toContain("`Fit canvas failed:`");
  expect(workflow).toMatch(/Unchecked auto-route warnings.*do not report a crossing/);
});

it("reports early 30.x as incapable in the command, check tool, and workflow", async () => {
  const { pi, commands, tools, sent, notify } = await commandFixture("30.0.4");
  drawme(pi as never);
  const ctx = { ui: { notify } };
  await commands.get("drawme-check")!.handler("", ctx);
  expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/30\.0\.4.*Mermaid import: unsupported; ELK layout: unsupported/s), "info");
  const check = await tools.get("drawio_check")!.execute("check", {}, undefined, undefined, ctx);
  expect(check.details).toMatchObject({ version: "30.0.4", supportsMermaid: false, supportsLayout: false });
  expect(check.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("30.2.4") });
  await commands.get("drawme")!.handler("an order flow", ctx);
  expect(sent[0]).toContain("Use only supported features; otherwise author and place cells by hand.");
  expect(sent[0]).not.toContain("## Reference: Mermaid authoring");
});

it("provides the actionable renderer diagnostic when drawme-check cannot find a usable CLI", async () => {
  const { pi, commands } = makeMockPi();
  const notify = vi.fn();
  drawme(pi as never);
  vi.mocked(resolveBinary).mockResolvedValueOnce({ available: false, reason: "Install native Linux draw.io; Windows draw.io in WSL is unsupported." });
  await commands.get("drawme-check")!.handler("", { ui: { notify } });
  expect(notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Install native Linux draw.io"), "error");
});

it("exports a session-relative command operand next to the session source and explains the animation dialects in usage", async () => {
  const { pi, commands, dir, notify } = await commandFixture();
  drawme(pi as never);
  const input = "order.drawio";
  await writeFile(join(dir, input), '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>');
  const ctx = { cwd: dir, ui: { notify } };
  await commands.get("drawme-export")!.handler(`${input} svg`, ctx);
  const output = join(dir, "order.svg");
  expect(notify).toHaveBeenLastCalledWith(`Exported ${output}`, "info");
  expect(await readFile(output, "utf8")).toMatch(/<svg\b/);
  await commands.get("drawme-export")!.handler("", ctx);
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/^Usage: .*native draw.io.*stored DrawMe motion.*drawio_animate.*omit steps/i), "info");
});
