import { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFile, resolveBinary } from "../src/drawio";
import drawme from "../src/index";
import { makeMockPi } from "./fixtures";

vi.mock("node:child_process", async (importOriginal) => ({
  ChildProcess: (await importOriginal<typeof import("node:child_process")>()).ChildProcess,
  spawn: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  platform: vi.fn(),
}));

const VERSION = "30.2.4";
const spawnMock = vi.mocked(spawn);
let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "drawme process trust ")));
  vi.stubEnv("DRAWME_DRAWIO_BINARY", undefined);
  vi.mocked(platform).mockReturnValue("darwin");
  spawnMock.mockReset().mockImplementation((_bin, args) => {
    const child = Object.assign(new ChildProcess(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      unref: vi.fn().mockReturnThis(),
    });
    queueMicrotask(() => {
      child.emit("spawn");
      child.stdout.end(Array.isArray(args) && args[0] === "--version" ? `${VERSION}\n` : "");
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("CLI discovery trust", () => {
  it.each([
    { name: "drawio_check" },
    { name: "drawio_export", hasInput: true, destination: "output.png", options: { format: "png" } },
    { name: "drawio_animate", hasInput: true, destination: "output.svg", options: { steps: [{ effect: "fadeIn", cells: ["a"] }], storyboard: false } },
    { name: "drawio_from_mermaid", destination: "output.drawio", options: { mermaid: "graph TD\n  A --> B" } },
    { name: "drawio_layout", hasInput: true, destination: "output.drawio", options: { preset: "verticalFlow" } },
  ])("does not probe an unconfigured executable from $name", async ({ name, hasInput, destination, options }) => {
    const input = join(dir, "diagram.drawio");
    await writeFile(input, `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="a" parent="1" vertex="1"><mxGeometry width="10" height="10" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`);
    const binary = join(dir, "Other Renderer");
    await writeFile(binary, "");
    const { pi, tools } = makeMockPi();
    drawme(pi as never);
    const tool = tools.get(name)!;
    await tool.execute("t", {
      ...options,
      ...(hasInput && { input }),
      ...(destination && { output: join(dir, destination) }),
      binary,
    });

    // Not spawning the supplied binary is not enough: the route must reach discovery.
    expect(spawnMock).toHaveBeenCalledWith("drawio", ["--version"], expect.anything());
    expect(spawnMock.mock.calls.map(([bin]) => bin)).not.toContain(binary);
    expect(tool.parameters.properties).not.toHaveProperty("binary");
  });

  it("probes a custom CLI selected in Pi's launch environment before default candidates", async () => {
    const binary = join(dir, "Custom Drawio");
    await writeFile(binary, "");
    vi.stubEnv("DRAWME_DRAWIO_BINARY", binary);

    await expect(resolveBinary()).resolves.toMatchObject({ available: true, binary, version: VERSION, supportsMermaid: true });
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith(binary, ["--version"], expect.anything());
  });

  it("uses default discovery when the configured CLI is not an absolute path", async () => {
    vi.stubEnv("DRAWME_DRAWIO_BINARY", "other-drawio");

    await expect(resolveBinary()).resolves.toMatchObject({ available: true, binary: "drawio" });
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith("drawio", ["--version"], expect.anything());
  });
});

describe("desktop opener trust", () => {
  it("passes one literal Windows document path to the system association helper without a command interpreter", async () => {
    vi.mocked(platform).mockReturnValue("win32");
    vi.stubEnv("SystemRoot", String.raw`C:\Windows`);
    const document = join(dir, "Team Plan (Q1), draft.DRAWIO");
    await writeFile(document, "");

    await openFile(document);

    expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
      String.raw`C:\Windows\System32\rundll32.exe`, ["shell32.dll,ShellExec_RunDLL", document],
      expect.not.objectContaining({ shell: true }),
    );
  });

  it("opens a supported export through its absolute path", async () => {
    vi.mocked(platform).mockReturnValue("linux");
    const document = join(dir, "Team Plan.drawio.png");
    await writeFile(document, "");

    await expect(openFile(relative(process.cwd(), document))).resolves.toEqual({ opener: "xdg-open" });
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith("xdg-open", [document], expect.anything());
  });

  it("does not hand a file with an unsupported extension to the desktop", async () => {
    const document = join(dir, "notes.txt");
    await writeFile(document, "");

    await expect(openFile(document)).rejects.toThrow("supported diagram or export");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not hand an application bundle or a supported-looking directory to the desktop", async () => {
    for (const name of ["Viewer.app", "Draft.drawio"]) {
      const directory = join(dir, name);
      await mkdir(directory);
      await expect(openFile(directory)).rejects.toThrow("regular file");
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("checks the target of a document symlink before opening", async () => {
    const target = join(dir, "notes.txt");
    const alias = join(dir, "draft.drawio");
    await writeFile(target, "");
    await symlink(target, alias);

    await expect(openFile(alias)).rejects.toThrow("supported diagram or export");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
