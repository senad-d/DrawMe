import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { afterAll, beforeAll } from "vitest";

const fixtures = new Set<string>();

/** Register a script that the test runner will invoke with the current Node binary. */
export async function writeRendererFixture(dir: string, body: string, name = `drawio fixture ${randomUUID()}.mjs`): Promise<string> {
  const file = resolve(dir, name);
  await writeFile(file, body);
  fixtures.add(file);
  return file;
}

function xvfbOperand(args: readonly string[]): number {
  // Skip the Xvfb options used by renderer preparation, not arguments to its child.
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") return i + 1;
    if (arg === "-s" || arg === "--server-args") i += 2;
    else if (arg === "-a" || arg === "--auto-servernum" || arg.startsWith("--server-args=")) i++;
    else break;
  }
  return i;
}

/** Opt in once at suite definition time. Other commands still spawn as usual. */
export function installRendererFixtureAdapter(): void {
  let originalSpawn: typeof childProcess.spawn | undefined;
  beforeAll(() => {
    originalSpawn = childProcess.spawn;
    childProcess.spawn = new Proxy(originalSpawn, {
      apply(spawn, receiver, call) {
        const [command, args, ...options] = call;
        if (fixtures.has(command)) {
          const argv = Array.isArray(args) ? [command, ...args] : [command];
          const spawnOptions = Array.isArray(args) || args == null ? options : [args];
          return Reflect.apply(spawn, receiver, [process.execPath, argv, ...spawnOptions]);
        }
        if (command === "xvfb-run" && Array.isArray(args)) {
          const index = xvfbOperand(args);
          if (fixtures.has(args[index])) {
            return Reflect.apply(spawn, receiver, [process.execPath, args.slice(index), ...options]);
          }
        }
        return Reflect.apply(spawn, receiver, call);
      },
    });
    // Update already-imported named bindings in the production modules too.
    syncBuiltinESMExports();
  });
  afterAll(() => {
    fixtures.clear();
    if (originalSpawn) {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
  });
}
