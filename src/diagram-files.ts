import { addAbortListener } from "node:events";
import { type Stats, constants } from "node:fs";
import { open, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { type DomEl, childrenByTag, firstByTag } from "./dom";

export interface ValidationLimits {
  maxBytes: number;
  maxPages: number;
  maxCellsPerPage: number;
  maxWork: number;
  maxDiagnostics: number;
}

export const DEFAULT_VALIDATION_LIMITS: Readonly<ValidationLimits> = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxPages: 256,
  maxCellsPerPage: 20_000,
  maxWork: 1_000_000,
  maxDiagnostics: 256,
});

export class ValidationStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationStop";
  }
}

type AcceptFinding = (
  level: "error" | "warning" | "observation",
  message: string,
  kind?: "through" | "crossings" | "overlaps" | "anchors",
) => void;

export interface ValidationBudget {
  work(n?: number): void;
  finding: AcceptFinding;
}

const MAX_DIAGNOSTIC_LENGTH = 512;

export function createValidationBudget(limits: ValidationLimits, accept: AcceptFinding): ValidationBudget {
  const { maxWork, maxDiagnostics } = limits;
  let work = 0;
  let diagnostics = 0;
  let stopped: ValidationStop | undefined;
  function stop(message: string): never {
    stopped = new ValidationStop(message);
    throw stopped;
  }
  return {
    work(n = 1) {
      if (stopped) throw stopped;
      if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("work charge must be a nonnegative integer");
      if (n > maxWork - work) stop(`validation work limit (${maxWork}) exceeded`);
      work += n;
    },
    finding(level, message, kind) {
      if (stopped) throw stopped;
      // The caller owns the one extra slot for the blocking limit diagnostic.
      if (diagnostics >= maxDiagnostics) stop(`validation diagnostic limit (${maxDiagnostics}) exceeded`);
      diagnostics++;
      const excerpt = message.length > MAX_DIAGNOSTIC_LENGTH
        ? `${message.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`
        : message;
      accept(level, excerpt, kind);
    },
  };
}

/** Read at most maxBytes + 1 from a regular file, even if it grows after fstat. */
export async function readDiagramXml(path: string, maxBytes = DEFAULT_VALIDATION_LIMITS.maxBytes): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("invalid diagram byte limit");
  const check = (file: Stats) => {
    if (!file.isFile()) throw new Error(`diagram input is not a regular file: ${path}`);
    if (file.size > maxBytes) throw new ValidationStop(`diagram input exceeds the ${maxBytes} byte limit: ${path}`);
  };
  check(await stat(path));
  // A file can be replaced after stat. Nonblocking open avoids a FIFO handoff
  // hanging before we can check the actual descriptor.
  const fd = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const file = await fd.stat();
    check(file);
    const ceiling = maxBytes + 1;
    let buffer = Buffer.allocUnsafe(file.size + 1);
    let used = 0;
    for (;;) {
      if (used === buffer.length) {
        const larger = Buffer.allocUnsafe(Math.min(ceiling, Math.max(64 * 1024, buffer.length * 2)));
        buffer.copy(larger);
        buffer = larger;
      }
      const { bytesRead } = await fd.read(buffer, used, buffer.length - used, null);
      if (bytesRead === 0) return buffer.toString("utf8", 0, used);
      used += bytesRead;
      if (used === ceiling) throw new ValidationStop(`diagram input exceeds the ${maxBytes} byte limit: ${path}`);
    }
  } finally {
    await fd.close();
  }
}

/** List the outer pages, including compressed wrappers. */
export function diagramPages(root: DomEl): DomEl[] {
  if (root.tagName === "diagram" || root.tagName === "mxGraphModel") return [root];
  return childrenByTag(root, "diagram");
}

/** A bare model is its own page; text-only wrappers have no directly readable model. */
export function pageModel(page: DomEl): DomEl | null {
  return page.tagName === "mxGraphModel" ? page : firstByTag(page, "mxGraphModel");
}

/** Resolve a name even when the destination does not exist yet. */
async function canonicalName(path: string): Promise<string> {
  const seen = new Set<string>();
  for (;;) {
    try {
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = await realpath(dirname(path));
    const entry = join(parent, basename(path));
    if (seen.has(entry)) throw new Error(`diagram path has a symlink loop: ${entry}`);
    seen.add(entry);
    let target: string;
    try {
      target = await readlink(entry);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EINVAL") return entry;
      throw error;
    }
    // A dangling final symlink still directs a write to its target name.
    // Preserve '..' until realpath has resolved any intermediate symlinks.
    path = isAbsolute(target) ? target : `${parent}${sep}${target}`;
  }
}

async function fileKeys(path: string): Promise<string[]> {
  const name = await canonicalName(path);
  // The usual Windows destination lookup is case-insensitive even before creation.
  const keys = [`name:${process.platform === "win32" ? name.toLowerCase() : name}`];
  try {
    const { dev, ino } = await stat(name, { bigint: true });
    if (ino !== 0n) keys.push(`inode:${dev}:${ino}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return keys;
}

interface Reservation {
  keys: readonly string[];
  tryStart(): void;
}

const reservations = new Map<string, Set<Reservation>>();

function release(entry: Reservation): void {
  const candidates = new Set<Reservation>();
  for (const key of entry.keys) {
    const queue = reservations.get(key);
    if (!queue) continue;
    const wasFirst = queue.values().next().value === entry;
    queue.delete(entry);
    const next = queue.values().next().value;
    if (!next) reservations.delete(key);
    else if (wasFirst) candidates.add(next);
  }
  for (const candidate of candidates) candidate.tryStart();
}

/** Process-local transaction; callers must not reacquire a held file inside the action. */
export async function withDiagramFiles<T>(
  paths: readonly string[], signal: AbortSignal | undefined, action: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const identities = await Promise.all([...new Set(paths)].map(fileKeys));
  const keys = [...new Set(identities.flat())].sort();
  signal?.throwIfAborted();

  let entry!: Reservation;
  const turn = new Promise<void>((resolve, reject) => {
    const listener = signal && addAbortListener(signal, () => reject(signal.reason));
    entry = {
      keys,
      tryStart() {
        if (keys.every((key) => reservations.get(key)?.values().next().value === entry)) {
          listener?.[Symbol.dispose]();
          resolve();
        }
      },
    };
    // Reserve every key in a single turn. The same predecessor order on all
    // shared keys prevents opposite-order transactions from deadlocking.
    for (const key of keys) {
      let queue = reservations.get(key);
      if (!queue) reservations.set(key, queue = new Set());
      queue.add(entry);
    }
    entry.tryStart();
  });
  try {
    await turn;
    signal?.throwIfAborted();
    return await action();
  } finally {
    release(entry);
  }
}
