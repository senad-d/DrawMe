/** A complete 1×1 PNG for draw.io renderer stand-ins. */
export const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

export type ResultContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolDef = {
  name: string;
  parameters: { properties: object };
  execute: (...a: unknown[]) => Promise<{ content: ResultContent[]; details: unknown }>;
};

/** Minimal mock of the bits of ExtensionAPI the extension touches. */
export function makeMockPi() {
  const tools = new Map<string, ToolDef>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: string[] = [];
  const pi = {
    registerTool: (t: ToolDef) => tools.set(t.name, t),
    registerCommand: (name: string, opts: { handler: (a: string, c: unknown) => Promise<void> }) => commands.set(name, opts),
    sendUserMessage: (content: string) => sent.push(content),
  };
  return { pi, tools, commands, sent };
}
