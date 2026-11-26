import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { getEventListeners, once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { buildSessionProjection, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { DOMParser } from "@xmldom/xmldom";
import { afterEach, expect, it, vi } from "vitest";
import * as intake from "../src/diagram-files";
import drawme from "../src/index";
import * as raster from "../src/png";
import { makeMockPi, TINY_PNG, type ResultContent } from "./fixtures";
import { installRendererFixtureAdapter, writeRendererFixture } from "./renderer-fixture";

installRendererFixtureAdapter();

const workspaces: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const graph = (id: string, name: string) => `<mxGraphModel page="1" pageWidth="600" pageHeight="500"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="${id}" parent="1" value="${name}" vertex="1"><mxGeometry x="90" y="60" width="100" height="50" as="geometry"/></mxCell></root></mxGraphModel>`;
const diagram = `<mxfile><diagram name="Page One">${graph("a", "First vertex")}</diagram><diagram name="Page Two">${graph("b", "Second vertex")}</diagram></mxfile>`;
const steps = (id: string) => [{ effect: "fadeIn", cells: [id], duration: 200 }];
const fresh = "Critique it against the current review pass";
const compare = "fixed, not fixed, or regressed";
const vision = { input: ["text", "image"] };
const png = Buffer.from(TINY_PNG, "base64");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const image = (bytes: Buffer) => ({ type: "image", mimeType: "image/png", data: bytes.toString("base64") });
const text = ({ content }: { content: ResultContent[] }) => content[0].type === "text" ? content[0].text : "";

// Two different tiny schematic thumbnails. Pi can store a JPEG re-encoding of
// its original PNG attachment: JPEG_A was encoded from this exact PNG_A.
const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAXElEQVR4nO3SsQ2AMAxE0VvE+88VBiFpqGjOooBT+F+urSfZmmHpa8A9QC5ALkAuQK4LJJ39OUZv9aOdgPYHVVWL8yZI3X4LyjqZ0p4aUAgoJ0AuQC5ALkCuONACSJDLUShCHpoAAAAASUVORK5CYII=";
const JPEG_A = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgGBgcGBwgICAgICAkJCQoKCgkJCQkKCgoKCgoMDAwKCgoKCgoKDAwMDA0ODQ0NDA0ODg8PDxISEREVFRUZGR//xACDAAEBAQEAAAAAAAAAAAAAAAAHCAYFAQADAAMBAQAAAAAAAAAAAAAHBQQGAwEAAhAAAAUDBAEFAQEAAAAAAAAABAMCAQUGABEhFBIHE1Wk1BciMSMRAAAEAwYCCgMBAAAAAAAAAAADAgEFBBEhFBMSBlEiMlSxoVKkMdMW0TNxYTRB/8AAEQgAIAAwAwESAAISAAMSAP/aAAwDAQACEQMRAD8Af7AOyOyKtgKtk46Ok9uEI2viK2gEzj5ARBiv2aGMMfK1qfVT4zhtL8CPpbS0GiMGlJmZlMQ4zGzrxphNcp5iW4UGpS1EszWMPCM88xBimZVGan+Ns36D/crfcFees+wjPiWOAX/ZOnug+Im/WFgX3k3vdifgVTeMp3sCnzoSLMkqkg0jjAIZYtJsjHkmMIUSlzWMKY1DFrZeeSOKeL6YaxAKYhdr5M3T+bGMwOf6sz5Ps4+WnNbuGA4muVs3nRq/kbOz2u+xIoHTY86BqKHMk0bfbpDDY8Wc/IUSk3gHdRzL/wAXW7/h+LZVpjNzBxpaSl4jGZSWmUYhJmNnRmWmuUgxTcSHSpqKZnscdGs9ToLU7WO1OtghXK33BXnrPsIz4lpwX/ZOnug+Im/WGwL7yb3uxPwKpsT6jr6pqnqE8HKyG6Dojjjkl7UGVgxJxCWVyIIKXolamxnGv8sQDPdaachUJhhZ8nLYJjzKEOrFPXwuWY7tQwxafNLW0qGAllzlmLdlPVqbNu2zDmdkdb1bP1bJyMdGbgIftfEbuwJfLxgiC1fg0SWY2FoU2qWzjLaW/wB1aW1TBodBpSWmZvDOLxs6MGYVTMeYpuJBSkvVLs9jgcD5PIMWYp2TVnp/rbN+xYJW+n689G9/GfLuqbL/AL20907w836IEAX3Y3u9qfkMBjKdoCnyYSLLkqbg1DiwIZAtRsdHnGOISSljXMNYpbGLdeeS+SuT65e9ndMQu18mbp/NjGYHP9WZ8n2cfLTmt3Ew4muVs3nRq/kdB7XfXcUMpseTA07Dlya9vt1BgUeEObiKJUbwEOklkf4stn/bcmynXOLQrcaWnZeHRmUmZleGSXjZ15VqpmIMS3ChlKeqnZrGCcaz0ustTNa7062GwSt9P156N7+M+XdU2X/e2nuneHm/RAgC+7G93tT8hgBPqOgampioTxkrH7UOqOOJSZugZuTFHEKZPEg81eqUKfOMaf22y891pqOFRaGFkSczjGNMoW6cI9HCxZjO9TC0J81NZWowISy5Ky1u6mo1N23bZxUP/9k=";
const JPEG_B = "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABlAAEBAQAAAAAAAAAAAAAAAAAABwgBAQEAAAAAAAAAAAAAAAAAAAUAEAAABQQCAwEBAAAAAAAAAAAAAwQCBRIGBwERFKUX1FYTEQABAwUBAAAAAAAAAAAAAAAAFaTSBFUFVAMG/8AAEQgAIAAwAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8Av4AAiM8+88p/oPGxHwB7zyn+g8bEfAKDkLEOO4OwbtlY+F662Pt+ZWpDu/JmfyUJkBxpJlByx5b6DGtdS9jmb44dregx7iHHc5YNpSshC9hbIW/DLVZ3fky/6qFKAk04yglYwtlZjnOpYxrNc8N1rQKS83vOO8ARF9HcnVVAooAAVGwAAIidZCy9jucsG7YqPmuwtkLfmUSQnoSZf9VClAcUSXWcjYWysxzW1Pe1mueXb1oMe5ex3B2DaUVITXXWx9vwyJWT0JMz+ShMgJKOLrJRvLfQY1zamPczfHLd70J96Myn+f8AJRH3h6Myn+f8lEfeClTN6LfvMEWvR21rVTNDAABUbP/Z";

function editablePng() {
  const payload = Buffer.from(`mxfile\0${diagram}`);
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length);
  chunk.write("tEXt", 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

function register(cwd: string, extension = drawme) {
  const mock = makeMockPi();
  extension(mock.pi as never);
  const ui = { notify: vi.fn() };
  const run = (tool: string, params: object, options: { signal?: AbortSignal; model?: typeof vision; sessionManager?: object; callId?: string } = {}) =>
    mock.tools.get(tool)!.execute(options.callId ?? tool, params, options.signal, undefined, { ...options, cwd });
  return { ...mock, run, ui, command: (name: string, args = "") => mock.commands.get(name)!.handler(args, { cwd, ui }) };
}

type ToolResult = Awaited<ReturnType<ReturnType<typeof register>["run"]>>;
type Phase = "version" | "svg" | "board" | "png" | "mermaid" | "layout";
type Invocation = { args: string[]; phase: Phase; input?: string; output?: string; pid: number; descendant?: number };
const privateMarker = "inert-private-renderer-marker";

async function fixture(options: { version?: string; pause?: Phase; previewPng?: string; noisy?: boolean; descendant?: boolean } = {}) {
  const workspace = await mkdtemp(join(tmpdir(), "drawme registered "));
  workspaces.push(workspace);
  const dir = await realpath(workspace);
  const input = join(dir, "map.drawio");
  const events = join(dir, "invoked argv.ndjson");
  const gate = join(dir, "render release");
  const held = join(dir, "child ready.json");
  await writeFile(input, diagram);
  await writeFile(events, "");
  // A real Node child from this space-containing path runs on Windows too.
  // Allow the fake child even on Linux test hosts running as root, never stock Electron.
  if (process.platform === "linux") {
    for (const api of ["getuid", "geteuid"] as const) {
      if (process[api]?.() === 0) vi.spyOn(process, api).mockReturnValue(1001);
    }
  }
  const binary = await writeRendererFixture(dir, `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
const args = process.argv.slice(2);
if (args.includes('--unprepared-probe')) process.exit(11);
const at = args.indexOf('-o');
const format = args[args.indexOf('-f') + 1];
const input = args[at + 2];
const output = args[at + 1];
const phase = args.includes('--version') ? 'version' : format === 'xml' ? (args.includes('--layout') ? 'layout' : 'mermaid')
  : input.includes('.drawme-storyboard-') ? 'board' : format;
const call = { args, input, output, phase, pid: process.pid };
appendFileSync(${JSON.stringify(events)}, JSON.stringify(call) + '\\n');
if (phase === 'version') { console.log(${JSON.stringify(options.version ?? "32.4.1")}); process.exit(0); }
if (${options.noisy}) {
  const drain = (stream, data) => new Promise(resolve => stream.write(data, resolve));
  await Promise.all([drain(process.stdout, '${privateMarker}' + 'x'.repeat(900_000)), drain(process.stderr, '${privateMarker}' + 'y'.repeat(900_000))]);
  process.exitCode = 23;
} else {
  if (phase === ${JSON.stringify(options.pause)}) {
    if (${options.descendant}) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      const closed = once(child, 'close');
      process.on('SIGTERM', () => { /* reap the group-signalled child before exiting */ });
      call.descendant = child.pid;
      writeFileSync(${JSON.stringify(held + ".new")}, JSON.stringify(call));
      renameSync(${JSON.stringify(held + ".new")}, ${JSON.stringify(held)});
      while (!existsSync(${JSON.stringify(gate)}) && child.exitCode === null && child.signalCode === null) await setTimeout(10);
      child.kill();
      await closed;
    } else {
      writeFileSync(${JSON.stringify(held + ".new")}, JSON.stringify(call));
      renameSync(${JSON.stringify(held + ".new")}, ${JSON.stringify(held)});
      while (!existsSync(${JSON.stringify(gate)})) await setTimeout(10);
    }
  }
  if (phase === 'svg') {
    const id = args[args.indexOf('--page-index') + 1] === '2' ? 'b' : 'a';
    if (!readFileSync(input, 'utf8').includes('id="' + id + '"')) process.exit(12);
    writeFileSync(output, '<svg xmlns="http://www.w3.org/2000/svg" width="200px" height="100px"><g data-cell-id="' + id + '"><rect width="80" height="40"/></g></svg>');
  } else if (phase === 'mermaid') {
    if (!readFileSync(input, 'utf8').includes('flowchart')) process.exit(13);
    writeFileSync(output, ${JSON.stringify(graph("converted", "Converted vertex"))});
  } else if (phase === 'layout') {
    writeFileSync(output, readFileSync(input, 'utf8').replaceAll('x="90"', 'x="110"'));
  } else writeFileSync(output, Buffer.from(${JSON.stringify(options.previewPng ?? TINY_PNG)}, 'base64'));
}
`);
  vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
  return {
    ...register(dir), dir, input, binary,
    invocations: async (): Promise<Invocation[]> => (await readFile(events, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)),
    ready: () => vi.waitFor(async (): Promise<Invocation> => JSON.parse(await readFile(held, "utf8")), { timeout: 4_000 }),
    release: () => writeFile(gate, ""),
  };
}

it("reads and writes only the calling Pi workspace and preserves absolute paths", async () => {
  const { dir, run, binary } = await fixture();
  const host = join(dir, "host");
  await mkdir(host);
  const name = "map.drawio";
  const sameName = join(host, name);
  const absolute = join(host, "absolute result.svg");
  const wrongCopy = graph("host", "Host vertex").replace("</root>", '<mxCell id="bad" parent="1" edge="1" source="missing" target="host"><mxGeometry relative="1" as="geometry"/></mxCell></root>');
  await writeFile(sameName, wrongCopy);
  const previous = process.cwd();
  try {
    process.chdir(host);
    expect((await run("drawio_validate", { input: name })).details).toMatchObject({ errors: [] });
    expect((await run("drawio_validate", { input: sameName })).details).toMatchObject({ errors: [expect.stringContaining("missing")] });
    const explanation = await run("drawio_explain", { input: name });
    expect(text(explanation)).toContain("First vertex");
    expect(text(explanation)).not.toContain("Host vertex");
    expect(text(await run("drawio_explain", { input: sameName }))).toContain("Host vertex");
    const fit = await run("drawio_fit_canvas", { input: name, margin: 23 });
    expect(fit.details).toMatchObject({ changed: true, output: join(dir, name) });
    expect(await readFile(join(dir, name), "utf8")).toContain('x="23" y="23"');
    expect(await readFile(sameName, "utf8")).toBe(wrongCopy);
    expect((await run("drawio_export", { input: name, mode: "preview" })).details).toMatchObject({ output: join(dir, "map.preview.png"), binary });
    expect((await run("drawio_export", { input: join(dir, name), output: "relative.svg", format: "svg" })).details).toMatchObject({ output: join(dir, "relative.svg") });
    expect((await run("drawio_export", { input: name, output: absolute, format: "svg" })).details).toMatchObject({ output: absolute });
    expect(await readFile(absolute, "utf8")).toContain('data-cell-id="a"');
    expect((await run("drawio_from_mermaid", { mermaid: "flowchart LR; A-->B" })).details).toMatchObject({ output: join(dir, "diagram.drawio"), binary });
    expect(await readFile(join(dir, "diagram.drawio"), "utf8")).toContain("Converted vertex");
    for (const misplaced of ["map.preview.png", "relative.svg", "diagram.drawio"]) expect(existsSync(join(host, misplaced))).toBe(false);
  } finally {
    process.chdir(previous);
  }
});

it.each([["30.0.4", false], ["30.2.4", true]] as const)("uses draw.io %s capabilities in check, import, layout and the queued workflow", async (version, available) => {
  const { dir, binary, run, command, ui, pi, commands, invocations } = await fixture({ version });
  const probe = await run("drawio_check", {});
  expect(probe.details).toMatchObject({ binary, version, supportsMermaid: available, supportsLayout: available });
  await command("drawme-check");
  const state = available ? "supported" : "unsupported";
  expect(ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`Mermaid import: ${state}; ELK layout (--layout): ${state}`), "info");
  const conversion = await run("drawio_from_mermaid", { mermaid: "flowchart LR; A-->B" });
  const layout = await run("drawio_layout", { input: "map.drawio", preset: "horizontalFlow" });
  if (available) {
    expect(conversion.details).toMatchObject({ binary, output: join(dir, "diagram.drawio") });
    expect(layout.details).toMatchObject({ binary, output: join(dir, "map.layout.drawio") });
    expect((await invocations()).filter(({ phase }) => phase !== "version").map(({ phase }) => phase)).toEqual(["mermaid", "layout"]);
  } else {
    expect(text(conversion)).toMatch(/^Mermaid conversion failed: .*needs draw.io v30\.2\.4 or later/);
    expect(text(layout)).toMatch(/^Layout failed: .*needs draw.io v30\.2\.4 or later/);
    expect((await invocations()).every(({ phase }) => phase === "version")).toBe(true);
  }

  const send = vi.fn();
  // The Pi API rejects unqualified delivery while streaming. The old handler
  // would throw here instead of preserving the user's workflow request.
  drawme({ ...pi, sendUserMessage: (workflow: string, options?: { deliverAs: string }) => {
    if (!available && options?.deliverAs !== "followUp") throw new Error("busy Pi requires a delivery policy");
    send(workflow, options);
  } } as never);
  const request = available ? "Draw an idle workflow" : "Draw a busy workflow";
  await commands.get("drawme")!.handler(request, { cwd: dir, ui });
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(request), { deliverAs: "followUp" });
  const workflow = send.mock.calls[0][0];
  expect(workflow).toContain("Pass 4 — typography, semantics, and regression");
  expect(workflow.includes("## Reference: Mermaid authoring")).toBe(available);
});

it("offers the stored-motion alternative for the packaged example without claiming an export", async () => {
  const { dir, command, ui, invocations } = await fixture();
  const sample = "orders.drawio";
  await copyFile(new URL("../example/event-driven-orders.drawio", import.meta.url), join(dir, sample));
  await command("drawme-export");
  expect(ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/native draw\.io .*connector flow.*drawio_animate.*omit steps/), "info");
  await command("drawme-export", `${sample} animated-svg`);
  expect(ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/^Export failed: .*stored DrawMe motion.*drawio_animate.*orders\.drawio.*omit steps/), "error");
  expect(existsSync(join(dir, "orders.svg"))).toBe(false);
  expect(await invocations()).toEqual([]);

  await command("drawme-export", "map.drawio svg");
  expect(ui.notify).toHaveBeenLastCalledWith(`Exported ${join(dir, "map.svg")}`, "info");
  expect(await readFile(join(dir, "map.svg"), "utf8")).toContain("<svg");
});

type Edit = Extract<SessionEntry, { type: "context_edit" }>;
type Message = Extract<SessionEntry, { type: "message" }>;
type HistoryDetails = Extract<Message["message"], { role: "toolResult" }>["details"];
const storedDetailsOf = (result: ToolResult): HistoryDetails => JSON.parse(JSON.stringify(result.details));
const timestamp = "2026-01-01T00:00:00Z";
const session = (entries: SessionEntry[], leafId?: string) => ({ buildSessionProjection: () => buildSessionProjection(entries, leafId) });

it("compares only if the same-page Pi-stored attachment survives in its projected tool result", async () => {
  const { dir, input, run } = await fixture({ previewPng: PNG_A });
  const params = { input: "map.drawio", mode: "preview", output: "review.png" };
  const preview = (options: Parameters<typeof run>[2] = {}, args: object = {}) => run("drawio_export", { ...params, ...args }, { model: vision, ...options });
  const textOnly = await preview({ callId: "text only", model: { input: ["text"] } });
  expect(text(textOnly)).toContain("Preview image NOT attached");
  expect(textOnly.details).not.toHaveProperty("previewReceipt");
  const priorText = { type: "message", id: "text", parentId: null, timestamp, message: {
    role: "toolResult", toolName: "drawio_export", toolCallId: "text only", isError: false, timestamp: 1,
    content: textOnly.content, details: storedDetailsOf(textOnly),
  } } satisfies Message;
  const prior = await preview({ callId: "preview A", sessionManager: session([priorText]) });
  const bytes = await readFile(join(dir, "review.png"));
  const receipt = { source: input, pageIndex: 1, sha256: hash(bytes) };
  expect(prior.details).toMatchObject({ imageAttached: true, previewReceipt: receipt });
  expect(prior.content[1]).toEqual({ type: "image", mimeType: "image/png", data: PNG_A });
  expect(text(prior)).toContain(fresh);

  // Use the same tool call, receipt and stored content for every alternative projection.
  const stored = { type: "image" as const, mimeType: "image/jpeg", data: JPEG_A };
  const other = { ...stored, data: JPEG_B };
  const entry = { type: "message", id: "A", parentId: "root", timestamp, message: {
    role: "toolResult", toolName: "drawio_export", toolCallId: "preview A", isError: false, timestamp: 2,
    details: storedDetailsOf(prior), content: [prior.content[0], stored],
  } } satisfies Message;
  const user = (id: string, parentId: string | null): Message => ({ type: "message", id, parentId, timestamp,
    message: { role: "user", content: "Review the diagram", timestamp: 3 },
  });
  const root = user("root", null);
  const edit = (replacement: Edit["replacement"]) => session([root, entry, {
    type: "context_edit", id: "edit", parentId: entry.id, timestamp, targetId: entry.id, replacement,
  }]);
  const copied = edit({ content: [prior.content[0], { ...stored }] });
  const replaced = edit({ content: [prior.content[0], other] });
  const storedDetails = { imageAttached: true, previewReceipt: receipt };
  for (const [manager, projectedImage] of [[copied, stored], [replaced, other]] as const) {
    const pair = manager.buildSessionProjection().entries.find(({ sourceEntry }) => sourceEntry.id === entry.id)!;
    expect(pair.sourceEntry).toBe(entry);
    expect(entry.message.content[1]).toBe(stored);
    expect(pair.messages).toMatchObject([{ toolCallId: "preview A", details: storedDetails, content: [prior.content[0], projectedImage] }]);
  }
  const unknown = await preview({ model: undefined, sessionManager: copied });
  expect(unknown.content).toEqual([{ type: "text", text: expect.stringContaining("image support is unknown") }]);
  expect(unknown.details).toMatchObject({ imageAttached: false });
  expect(unknown.details).not.toHaveProperty("previewReceipt");
  const comparison = await preview({ sessionManager: copied });
  expect(text(comparison)).toContain(compare);
  expect(text(comparison)).not.toContain(fresh);

  const kept = user("kept", entry.id);
  const compacted = session([root, entry, kept, {
    type: "compaction", id: "compaction", parentId: kept.id, timestamp,
    firstKeptEntryId: kept.id, summary: "Prior review finished", tokensBefore: 100,
  }]);
  const branched = session([root, entry, user("sibling", root.id)], "sibling");
  const assertFresh = async (scenario: string, sessionManager: object, args?: object) => {
    const result = await preview({ sessionManager }, args);
    expect(text(result), scenario).toContain(fresh);
    expect(text(result), scenario).not.toContain(compare);
    expect(result.details).toMatchObject({ imageAttached: true });
  };
  await writeFile(join(dir, "other.drawio"), diagram);
  await assertFresh("different page", copied, { pageIndex: 2, output: "page two.png" });
  await assertFresh("different source", copied, { input: "other.drawio", output: "other.png" });
  await assertFresh("different JPEG under the same receipt", replaced);
  await assertFresh("omitted image", edit(null));
  await assertFresh("text-only replacement", edit({ content: "text only" }));
  await assertFresh("image compacted away", compacted);
  await assertFresh("preview on another branch", branched);
  await assertFresh("projection unavailable", { buildSessionProjection: () => { throw new Error("projection unavailable"); } });
}, 15_000);

it("does not rediscover orphaned preview files with a fresh extension runtime", async () => {
  const { dir, run } = await fixture();
  const preview = join(dir, "map.preview.png");
  expect((await run("drawio_export", { input: "map.drawio", mode: "preview" })).details).toMatchObject({ output: preview });
  const bytes = await readFile(preview);
  // Registering again against the same import would reuse process-local state.
  vi.resetModules();
  const { default: restartedExtension } = await import("../src/index");
  const restart = register(dir, restartedExtension);
  const params = { input: "map.drawio", format: "svg", mode: "final" };
  expect((await restart.run("drawio_export", params)).details).toMatchObject({ output: join(dir, "map.svg"), removedPreviews: [] });
  expect(await readFile(preview)).toEqual(bytes);
  expect((await run("drawio_export", params)).details).toMatchObject({ removedPreviews: [preview] });
  expect(existsSync(preview)).toBe(false);
});

it("resolves text-only failure when a previously verified preview changes or is unreadable at attachment time", async () => {
  const { dir, run } = await fixture();
  const output = join(dir, "review.png");
  const preview = () => run("drawio_export", { input: "map.drawio", mode: "preview", output: "review.png" }, { model: vision });
  const okay = await preview();
  expect(okay.content[1]).toEqual(image(await readFile(output)));

  const substitute = editablePng();
  expect(raster.inspectPng(substitute, true).hasEditableDiagram).toBe(true);
  const read = raster.readRasterFile;
  for (const [kind, error] of [
    ["editable PNG", /changed after verification/], ["directory", /not a regular file/],
    ["missing", /ENOENT/], ["unreadable", /access denied by fixture/],
  ] as const) {
    const hook = vi.spyOn(raster, "readRasterFile").mockImplementation(async path => {
      if (path !== output) return read(path);
      expect(await readFile(path)).toEqual(png); // Real export already committed.
      if (kind === "editable PNG") await writeFile(path, substitute);
      else if (kind === "unreadable") throw Object.assign(new Error("access denied by fixture"), { code: "EACCES" });
      else {
        await rm(path);
        if (kind === "directory") await mkdir(path);
      }
      return read(path);
    });
    try {
      const result = await preview();
      expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/^Export failed:/) }]);
      expect(text(result)).toMatch(error);
      expect(text(result)).not.toContain("Preview image attached");
      expect(result.details).toMatchObject({ imageAttached: false, error: expect.stringMatching(error) });
      expect(result.details).not.toHaveProperty("previewReceipt");
    } finally {
      hook.mockRestore();
      await rm(output, { recursive: true, force: true });
    }
  }
});

it.each([false, true])("binds storyboard attachments to committed bytes (substituted: %s) and keeps the board", async substituted => {
  const { dir, run } = await fixture();
  const output = join(dir, "map.animated.svg");
  const board = join(dir, "map.storyboard.png");
  const replacement = editablePng();
  expect(raster.inspectPng(replacement, true).hasEditableDiagram).toBe(true);
  const read = raster.readRasterFile;
  let committed: Buffer | undefined;
  let boardReads = 0;
  const hook = vi.spyOn(raster, "readRasterFile").mockImplementation(async path => {
    if (path === board) {
      boardReads++;
      committed = await readFile(path);
      if (substituted) await writeFile(path, replacement);
    }
    return read(path);
  });
  const result = await run("drawio_animate", { input: "map.drawio", steps: steps("a") }, { model: vision });
  hook.mockRestore();
  expect(boardReads).toBe(1);
  expect(committed).toEqual(png);
  expect(result.details).toMatchObject({ output, storyboard: board, storyboardSha256: hash(png), imageAttached: !substituted, saved: true });
  expect(result.details).not.toHaveProperty("previewReceipt");
  expect(text(result)).toContain("Animation verified:");
  expect(await readFile(output, "utf8")).toContain('data-cell-id="a"');
  if (substituted) {
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Storyboard NOT attached: the exported image could not be verified") }]);
  } else {
    expect(text(result)).toContain("Storyboard attached below");
    expect(result.content[1]).toEqual(image(committed!));
  }
  const bytesOnDisk = substituted ? replacement : png;
  expect(await readFile(board)).toEqual(bytesOnDisk);
  const preview = await run("drawio_export", { input: "map.drawio", mode: "preview" }, { model: vision });
  expect(text(preview)).toContain(fresh);
  expect(await readFile(board)).toEqual(bytesOnDisk);
  const final = await run("drawio_export", { input: "map.drawio", format: "svg", output: "final.svg" });
  expect(final.details).toMatchObject({ removedPreviews: [join(dir, "map.preview.png")] });
  expect(await readFile(board)).toEqual(bytesOnDisk);
});

it.runIf(process.platform === "linux")("checks and exports headlessly through Xvfb, while desktop probes stay direct", async () => {
  const { binary, run, dir } = await fixture();
  vi.stubEnv("DISPLAY", "");
  let headless = true;
  const launches: [string, string[]][] = [];
  const spawn = childProcess.spawn;
  vi.spyOn(childProcess, "spawn").mockImplementation(new Proxy(spawn, { apply(original, receiver, call) {
    const [command, argv] = call as [string, string[]];
    launches.push([command, argv]);
    // Model a stock executable that refuses a probe without a prepared display.
    if (headless && command !== "xvfb-run" && argv.includes("--version")) {
      return Reflect.apply(original, receiver, [binary, [...argv, "--unprepared-probe"], ...call.slice(2)]);
    }
    return Reflect.apply(original, receiver, call);
  } }));
  syncBuiltinESMExports();
  expect((await once(childProcess.spawn(binary, ["--version"]), "close"))[0]).toBe(11);
  launches.length = 0;
  expect((await run("drawio_check", {})).details).toMatchObject({ available: true, binary, version: "32.4.1" });
  expect((await run("drawio_export", { input: "map.drawio", format: "svg" })).details).toMatchObject({ output: join(dir, "map.svg"), binary });
  expect(launches.every(([command]) => command === "xvfb-run")).toBe(true);
  expect(launches.some(([, args]) => args.at(-2) === binary && args.at(-1) === "--version")).toBe(true);
  expect(launches.some(([, args]) => [binary, "-x", "svg"].every(arg => args.includes(arg)))).toBe(true);

  headless = false;
  vi.stubEnv("DISPLAY", ":91");
  expect((await run("drawio_check", {})).details).toMatchObject({ available: true, binary });
  expect(launches.at(-1)).toEqual([binary, ["--version"]]);
});

it("drains a noisy renderer and returns an actionable error without exposing its private output", async () => {
  const { run, invocations, dir } = await fixture({ noisy: true });
  const output = join(dir, "attempt.svg");
  const result = await run("drawio_export", { input: "map.drawio", format: "svg", output: "attempt.svg" }, { model: vision });
  expect((await invocations()).map(({ phase }) => phase)).toEqual(["version", "svg"]);
  expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/^Export failed: .*exited with code 23/) }]);
  expect(result.details).toMatchObject({ imageAttached: false });
  const payload = JSON.stringify(result);
  expect(payload).not.toContain(privateMarker);
  expect(Buffer.byteLength(payload)).toBeLessThan(1000);
  expect(existsSync(output)).toBe(false);
});

const previousSvg = '<svg xmlns="http://www.w3.org/2000/svg"><title>Previous final</title></svg>';
const previousBoard = Buffer.from(PNG_A, "base64");

async function settlesWhileHeld(result: Promise<ToolResult>) {
  let settled = false;
  const markSettled = () => { settled = true; };
  void result.then(markSettled, markSettled);
  await vi.waitFor(() => expect(settled, "tool must settle before the fixture gate is released").toBe(true), { timeout: 7_000 });
  return result;
}

function expectAborted(result: ToolResult, prefix: "Export" | "Animate") {
  expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(new RegExp(`^${prefix} failed: .*abort`, "i")) }]);
  expect(result.details).not.toHaveProperty("previewReceipt");
}

async function waiting(signal: AbortSignal) {
  await vi.waitFor(() => expect(getEventListeners(signal, "abort")).toHaveLength(1), { timeout: 4_000 });
}

it.each(["queued", "running"] as const)("aborts a %s registered export without publishing or retiring its preview", async state => {
  const { dir, run, ready, release, invocations } = await fixture({ pause: "svg", descendant: state === "running" && process.platform !== "win32" });
  const output = join(dir, "final.svg");
  const preview = join(dir, "map.preview.png");
  await writeFile(output, previousSvg);
  expect((await run("drawio_export", { input: "map.drawio", mode: "preview" })).details).toMatchObject({ output: preview });
  const before = await readFile(preview);
  const controller = new AbortController();
  const params = { input: "map.drawio", format: "svg", output: "final.svg" };
  const queued = state === "queued";
  const owner = run("drawio_export", queued ? { ...params, output: "holder.svg" } : params, { signal: queued ? undefined : controller.signal });
  let other: Promise<ToolResult> | undefined;
  try {
    const child = await ready();
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    if (child.descendant !== undefined) expect(() => process.kill(child.descendant!, 0)).not.toThrow();
    if (queued) {
      other = run("drawio_export", params, { signal: controller.signal });
      await waiting(controller.signal);
    }
    controller.abort();
    expectAborted(await settlesWhileHeld(other ?? owner), "Export");
    expect(await readFile(output, "utf8")).toBe(previousSvg);
    expect(await readFile(preview)).toEqual(before);
    expect((await invocations()).map(({ phase }) => phase)).toEqual(["version", "png", "version", "svg"]);
    if (queued) {
      expect(() => process.kill(child.pid, 0)).not.toThrow();
      expect(existsSync(join(dir, "holder.svg"))).toBe(false);
    } else {
      expect(() => process.kill(child.pid, 0)).toThrow();
      if (child.descendant !== undefined) expect(() => process.kill(child.descendant!, 0)).toThrow();
      expect(existsSync(child.output!)).toBe(false);
    }
    await release();
    if (queued) expect((await owner).details).toMatchObject({ output: join(dir, "holder.svg"), removedPreviews: [preview] });
    const next = await run("drawio_export", params);
    expect(next.details).toMatchObject({ output, removedPreviews: queued ? [] : [preview] });
    expect(await readFile(output, "utf8")).toContain('data-cell-id="a"');
    expect(existsSync(preview)).toBe(false);
  } finally {
    controller.abort();
    await release();
    await Promise.allSettled([owner, other]);
  }
}, 20_000);

it("aborts registered animation during board rendering and leaves the prior SVG, board and preview intact", async () => {
  const { dir, run, ready, release } = await fixture({ pause: "board" });
  const output = join(dir, "map.animated.svg");
  const board = join(dir, "map.storyboard.png");
  const preview = join(dir, "map.preview.png");
  await writeFile(output, previousSvg);
  await writeFile(board, previousBoard);
  expect((await run("drawio_export", { input: "map.drawio", mode: "preview" })).details).toMatchObject({ output: preview });
  const priorPreview = await readFile(preview);
  const controller = new AbortController();
  const animating = run("drawio_animate", { input: "map.drawio", steps: steps("a") }, { signal: controller.signal, model: vision });
  try {
    const child = await ready();
    expect(child.phase).toBe("board");
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    controller.abort();
    expectAborted(await settlesWhileHeld(animating), "Animate");
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(existsSync(child.input!)).toBe(false);
    expect(await readFile(output, "utf8")).toBe(previousSvg);
    expect(await readFile(board)).toEqual(previousBoard);
    expect(await readFile(preview)).toEqual(priorPreview);

    await release();
    const next = await run("drawio_animate", { input: "map.drawio" }, { model: vision });
    expect(next.details).toMatchObject({ output, storyboard: board, saved: false, imageAttached: true });
    expect(await readFile(output, "utf8")).toContain('data-cell-id="a"');
    expect(await readFile(board)).toEqual(png);
    expect(existsSync(preview)).toBe(false);
  } finally {
    controller.abort();
    await release();
    await animating;
  }
}, 20_000);

// Fit has no tool-level signal. Add a signal to observe real lock admission,
// then leave both the reservation and the action entirely in the product code.
function observeFit(source: string, output: string) {
  const controller = new AbortController();
  const lock = intake.withDiagramFiles;
  vi.spyOn(intake, "withDiagramFiles").mockImplementation((keys, signal, action) =>
    lock(keys, keys.length === 2 && keys[0] === source && keys[1] === output ? controller.signal : signal, action));
  return controller.signal;
}

it("serializes both registered page saves and an in-place fit, preserving each page and export", async () => {
  const { dir, input, run, ready, release } = await fixture({ pause: "board" });
  const firstSvg = join(dir, "first.svg");
  const secondSvg = join(dir, "second.svg");
  const params = { input: "map.drawio" };
  const first = run("drawio_animate", { ...params, pageIndex: 1, output: "first.svg", steps: steps("a") });
  const pending = [first];
  try {
    expect((await ready()).phase).toBe("board");
    const before = await readFile(input);
    const controller = new AbortController();
    const second = run("drawio_animate", { ...params, pageIndex: 2, output: "second.svg", steps: steps("b"), storyboard: false }, { signal: controller.signal });
    pending.push(second);
    await waiting(controller.signal);
    const fitSignal = observeFit(input, input);
    const fit = run("drawio_fit_canvas", { ...params, margin: 23 });
    pending.push(fit);
    await waiting(fitSignal);
    expect(await readFile(input)).toEqual(before);
    expect(existsSync(firstSvg)).toBe(false);
    expect(existsSync(secondSvg)).toBe(false);

    await release();
    expect((await first).details).toMatchObject({ output: firstSvg, page: "Page One", saved: true });
    expect((await second).details).toMatchObject({ output: secondSvg, page: "Page Two", saved: true });
    expect((await fit).details).toMatchObject({ output: input, changed: true });
    const doc = new DOMParser().parseFromString(await readFile(input, "utf8"), "text/xml");
    const pages = Array.from(doc.getElementsByTagName("diagram"));
    expect(pages).toHaveLength(2);
    for (const [i, id, svg] of [[0, "a", firstSvg], [1, "b", secondSvg]] as const) {
      const page = pages[i];
      expect(JSON.parse(page.getElementsByTagName("UserObject")[0].getAttribute("drawmeMotion")!)).toMatchObject({ steps: steps(id) });
      const geometry = page.getElementsByTagName("mxGeometry")[0];
      expect([geometry.getAttribute("x"), geometry.getAttribute("y")]).toEqual(["23", "23"]);
      const exported = await readFile(svg, "utf8");
      expect(exported).toContain(`data-cell-id="${id}"`);
      expect(exported).toContain("prefers-reduced-motion");
    }
  } finally {
    await release();
    await Promise.allSettled(pending);
  }
}, 20_000);

it("makes a different-input fit wait on a hard-linked destination and match replacement-last serial bytes", async () => {
  const { dir, input, run, ready, release } = await fixture({ pause: "board" });
  const replacement = join(dir, "replacement.drawio");
  const alias = join(dir, "map alias.drawio");
  const control = join(dir, "control.drawio");
  const controlAlias = join(dir, "control alias.drawio");
  await writeFile(replacement, graph("new", "Replacement vertex"));
  await writeFile(control, diagram);
  await link(control, controlAlias);
  await link(input, alias);
  const motion = { steps: steps("a") };
  const fit = { input: replacement, margin: 29 };
  expect((await run("drawio_animate", { input: control, ...motion, storyboard: false })).details).toMatchObject({ saved: true });
  expect((await run("drawio_fit_canvas", { ...fit, output: controlAlias })).details).toMatchObject({ output: controlAlias, changed: true });
  const serial = await readFile(control);
  expect(serial.toString()).toContain("Replacement vertex");
  expect(serial.toString()).not.toContain("drawmeMotion");

  const holder = run("drawio_animate", { input: "map.drawio", ...motion });
  let writer: Promise<ToolResult> | undefined;
  try {
    expect((await ready()).phase).toBe("board");
    const held = await readFile(alias);
    expect(held).not.toEqual(serial);
    const admitted = observeFit(replacement, alias);
    writer = run("drawio_fit_canvas", { ...fit, output: alias });
    await waiting(admitted);
    expect(await readFile(alias)).toEqual(held);
    expect(await readFile(input)).toEqual(held);
    await release();
    expect((await holder).details).toMatchObject({ saved: true, output: join(dir, "map.animated.svg") });
    expect((await writer).details).toMatchObject({ output: alias, changed: true });
    expect(await readFile(alias)).toEqual(serial);
    expect(await readFile(input)).toEqual(serial);
  } finally {
    await release();
    await Promise.allSettled([holder, writer]);
  }
}, 20_000);
