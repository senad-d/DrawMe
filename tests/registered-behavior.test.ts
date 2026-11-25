import childProcess from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import drawme from "../src/index";
import { installNodeRendererFixture, makeMockPi, TINY_PNG, type ResultContent } from "./fixtures";

const diagram = (label: string) => `<mxfile><diagram name="Orders"><mxGraphModel page="1" pageWidth="800" pageHeight="600"><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="a" value="${label}" vertex="1" parent="1"><mxGeometry x="100" y="100" width="80" height="40" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

async function registeredSession() {
  const work = await mkdtemp(join(tmpdir(), "drawme registered routes "));
  onTestFinished(() => rm(work, { recursive: true, force: true }));
  const root = await realpath(work);
  const cwd = join(root, "session with spaces");
  const binary = join(root, "renderer fixture.mjs");
  const log = join(root, "argv.jsonl");
  const started = join(root, "running.pid");
  const hold = join(root, "hold-render");
  await mkdir(cwd);
  await writeFile(binary, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args.includes("--version")) {
  console.log("32.4.123");
} else {
  const index = args.indexOf("-o");
  const [output, input] = args.slice(index + 1, index + 3);
  if (!isAbsolute(output) || !isAbsolute(input)) throw new Error("expected absolute operands");
  const source = readFileSync(input, "utf8");
  const format = args[args.indexOf("-f") + 1];
  if (format === "xml") {
    const layout = args.includes("--layout");
    if (!layout && !source.includes("From file")) throw new Error("unexpected Mermaid input");
    const xml = layout ? source.replace('x="100"', 'x="300"') : ${JSON.stringify(diagram("Fixture imported from file"))};
    writeFileSync(output, xml);
  } else if (format === "png") {
    writeFileSync(output, Buffer.from(${JSON.stringify(TINY_PNG)}, "base64"));
  } else if (format === "svg") {
    const label = /value="([^"]+)"/.exec(source)?.[1] ?? "No fixture label";
    const render = () => writeFileSync(output, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text>' + label + '</text></svg>');
    if (existsSync(${JSON.stringify(hold)})) {
      writeFileSync(${JSON.stringify(started)}, String(process.pid));
      setTimeout(render, 5000); // A missing cancellation still settles and exposes publication.
    } else render();
  } else process.exitCode = 2;
}
`);
  vi.stubEnv("DISPLAY", ":99");
  vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);
  const restore = installNodeRendererFixture([binary]);
  onTestFinished(() => {
    restore();
    vi.unstubAllEnvs();
  });
  const { pi, tools, commands } = makeMockPi();
  drawme(pi as never);
  const vision = { cwd, model: { input: ["text", "image"] } };
  return {
    vision, cwd, tools, commands, started, hold,
    path: (filename: string) => join(cwd, filename),
    put: (filename: string, value: string) => writeFile(join(cwd, filename), value),
    argv: async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]),
    call: (name: string, params: object, ctx: object = vision, signal?: AbortSignal) =>
      tools.get(name)!.execute(name, params, signal, undefined, ctx),
  };
}

it("imports, lays out, exports and opens dash-leading paths with spaces as session file operands", async () => {
  const session = await registeredSession();
  const source = "-orders flow.mmd";
  const input = "-order source.drawio";
  const layout = "-order layout.drawio";
  const output = "-delivery file.svg";
  await session.put(source, "flowchart LR\nA[From file] --> B[End]");
  const imported = await session.call("drawio_from_mermaid", { input: source, output: input });
  expect(imported.details).toMatchObject({ output: session.path(input), version: "32.4.123" });
  expect(await readFile(session.path(input), "utf8")).toContain("Fixture imported from file");
  const laidOut = await session.call("drawio_layout", { input, output: layout, preset: "horizontalFlow" });
  expect(laidOut.details).toMatchObject({ output: session.path(layout) });
  expect(await readFile(session.path(layout), "utf8")).toContain('x="300"');
  expect(await readFile(session.path(input), "utf8")).toContain('x="100"');
  const exported = await session.call("drawio_export", { input: layout, output, format: "svg" });
  expect(exported.details).toMatchObject({ output: session.path(output), imageAttached: false });
  expect(await readFile(session.path(output), "utf8")).toContain("<text>Fixture imported from file</text>");
  const renderCalls = (await session.argv()).filter((args) => args.includes("-o"));
  expect(renderCalls).toHaveLength(3);
  const operands = renderCalls.map((args) => args.slice(args.indexOf("-o") + 1, args.indexOf("-o") + 3));
  expect(operands.map(([, file]) => file)).toEqual([session.path(source), session.path(input), session.path(layout)]);
  expect(operands.every(([stage]) => isAbsolute(stage))).toBe(true);

  // Intercept only the platform document association, not the registered handler or openFile.
  const opener = process.platform === "win32" ? win32.join("C:\\Windows", "System32", "rundll32.exe") :
    process.platform === "darwin" ? "open" : "xdg-open";
  if (process.platform === "win32") vi.stubEnv("SystemRoot", "C:\\Windows");
  const spawn = childProcess.spawn;
  const opened: string[][] = [];
  childProcess.spawn = ((...args: Parameters<typeof spawn>) => {
    if (args[0] !== opener) return Reflect.apply(spawn, childProcess, args);
    opened.push(args[1] as string[]);
    return spawn(process.execPath, ["--version"], args[2]);
  }) as typeof spawn;
  syncBuiltinESMExports();
  try {
    const result = await session.call("drawio_open", { path: output });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(`Opened ${session.path(output)}`) });
    const expected = process.platform === "win32" ? ["shell32.dll,ShellExec_RunDLL", session.path(output)] : [session.path(output)];
    expect(opened).toEqual([expected]);
  } finally {
    childProcess.spawn = spawn;
    syncBuiltinESMExports();
  }
});

it("uses current-branch PNG attachments, not replaced files or unknown vision, for review guidance", async () => {
  const session = await registeredSession();
  const input = "review.drawio";
  await session.put(input, diagram("Review control"));
  const preview = { input, mode: "preview" };
  const unknown = await session.call("drawio_export", preview, { cwd: session.cwd });
  expect(unknown.details).toMatchObject({ mode: "preview", imageAttached: false });
  expect(unknown.content).toEqual([{ type: "text", text: expect.stringContaining("Preview image NOT attached") }]);
  const withHistory = (...results: { content: ResultContent[]; details: unknown }[]) => ({
    ...session.vision, sessionManager: { buildSessionProjection: () => ({
      messages: results.map((result) => ({ ...result, role: "toolResult", toolName: "drawio_export", isError: false })),
    }) },
  });
  const first = await session.call("drawio_export", preview, withHistory(unknown));
  // The same file was replaced, but the earlier transcript visibly contained no image.
  expect(first.details).toMatchObject({ source: session.path(input), pageIndex: 1, replacedPreview: true, imageAttached: true });
  expect(first.content).toEqual([
    { type: "text", text: expect.stringContaining("Critique it") }, { type: "image", mimeType: "image/png", data: TINY_PNG },
  ]);
  expect(first.content[0]).not.toMatchObject({ text: expect.stringContaining("previous attached preview") });
  const next = await session.call("drawio_export", { ...preview, output: "second review.png" }, withHistory(unknown, first));
  expect(next.content).toEqual([
    { type: "text", text: expect.stringContaining("fixed, not fixed, or regressed") },
    { type: "image", mimeType: "image/png", data: TINY_PNG },
  ]);
  const otherBranch = await session.call("drawio_export", preview);
  expect(otherBranch.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Critique it") });
});

it("compares against an attached PNG preview that Pi re-encoded to JPEG in the active transcript", async () => {
  const session = await registeredSession();
  const input = "recoded.drawio";
  const params = { input, mode: "preview" };
  await session.put(input, diagram("Re-encoding control"));
  const first = await session.call("drawio_export", params);
  expect(first.details).toMatchObject({ format: "png", source: session.path(input), pageIndex: 1, imageAttached: true });
  expect(first.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  // Pi can resize tool-result images before storing them. The delivered file and receipt remain PNG.
  const tinyJpeg = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKcAD//Z";
  const previous = {
    role: "toolResult", toolName: "drawio_export", isError: false, details: first.details,
    content: [first.content[0], { type: "image", mimeType: "image/jpeg", data: tinyJpeg }],
  };
  const ctx = { ...session.vision, sessionManager: { buildSessionProjection: () => ({ messages: [previous] }) } };
  const next = await session.call("drawio_export", { ...params, output: "second review.png" }, ctx);
  expect(next.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  expect(next.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("fixed, not fixed, or regressed") });
});

it("cancels a queued final and a running final without retiring the preview, then publishes on retry", async () => {
  const session = await registeredSession();
  const input = "cancel.drawio";
  const preview = session.path("cancel.preview.png");
  await session.put(input, diagram("Cancellation control"));
  const result = await session.call("drawio_export", { input, mode: "preview" });
  expect(result.details).toMatchObject({ output: preview, imageAttached: true, version: "32.4.123" });
  const prior = await readFile(preview);
  await writeFile(session.hold, "");
  const render = new AbortController();
  const waiter = new AbortController();
  const final = (output: string, signal?: AbortSignal) => session.call("drawio_export", { input, output, format: "svg" }, session.vision, signal);
  const running = final("running.svg", render.signal);
  let queued: ReturnType<typeof final> | undefined;
  try {
    const pid = await vi.waitFor(async () => {
      const value = Number(await readFile(session.started, "utf8"));
      expect(value).toBeGreaterThan(0);
      return value;
    }, { timeout: 6000 });
    queued = final("queued.svg", waiter.signal);
    waiter.abort();
    const failure = [{ type: "text", text: expect.stringMatching(/^Export failed:.*abort/i) }];
    // The queued promise must finish while the first child is alive, not wait for the renderer.
    expect((await queued).content).toEqual(failure);
    expect(process.kill(pid, 0)).toBe(true);
    const calls = (await session.argv()).filter((args) => args.includes("svg"));
    expect(calls).toHaveLength(1);
    render.abort();
    expect((await running).content).toEqual(failure);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    for (const output of ["running.svg", "queued.svg"]) {
      await expect(access(session.path(output))).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(preview)).toEqual(prior);
  } finally {
    render.abort();
    waiter.abort();
    await Promise.allSettled([running, queued]);
    await rm(session.hold);
  }
  const retry = await final("retry.svg");
  expect(retry.details).toMatchObject({ output: session.path("retry.svg"), removedPreviews: [preview], imageAttached: false });
  expect(await readFile(session.path("retry.svg"), "utf8")).toContain("Cancellation control");
  await expect(access(preview)).rejects.toMatchObject({ code: "ENOENT" });
}, 20_000);

it("reports the stored-motion alternative for the session example and exposes raster width only", async () => {
  const session = await registeredSession();
  const input = "event-driven-orders.drawio";
  await copyFile(new URL(`../example/${input}`, import.meta.url), session.path(input));
  const before = await readFile(session.path(input));
  const notify = vi.fn();
  const ctx = { ...session.vision, ui: { notify } };
  await session.commands.get("drawme-check")!.handler("", ctx);
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/32\.4\.123.*\n.*Mermaid import: supported; ELK layout: supported/), "info");
  await session.commands.get("drawme-export")!.handler(`${input} animated-svg`, ctx);
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/^Export failed:.*\n.*stored DrawMe motion.*drawio_animate.*omit steps/), "error");
  await session.commands.get("drawme-export")!.handler("", ctx);
  expect(notify).toHaveBeenLastCalledWith(expect.stringMatching(/^Usage:.*stored DrawMe motion.*drawio_animate.*omit steps/), "info");
  expect(await readFile(session.path(input))).toEqual(before);
  await expect(access(session.path("event-driven-orders.svg"))).rejects.toMatchObject({ code: "ENOENT" });
  const schema = session.tools.get("drawio_export")!.parameters.properties;
  expect(schema).toHaveProperty("width.type", "number");
  expect(schema).not.toHaveProperty("height");
});
