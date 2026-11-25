import { addAbortListener } from "node:events";
import { readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

type Release = () => void;
/** Each entry represents one held key and its FIFO waiters. */
const locks = new Map<string, Set<() => void>>();

// Supply a separate registry for each coordination domain; rendering inside an edit must not reacquire its edit lock.
export function acquireKey(registry: Map<string, Set<() => void>>, key: string, signal?: AbortSignal): Promise<Release> {
  signal?.throwIfAborted();
  const waiting = registry.get(key);
  const queue = waiting ?? new Set<() => void>();
  const release = () => {
    const next = queue.values().next().value;
    if (next === undefined) {
      registry.delete(key);
    } else {
      queue.delete(next);
      next();
    }
  };
  if (!waiting) {
    registry.set(key, queue);
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    function advance() {
      abort?.[Symbol.dispose]();
      resolve(release);
    }
    const abort = signal && addAbortListener(signal, () => {
      queue.delete(advance);
      reject(signal.reason);
    });
    queue.add(advance);
  });
}

async function canonicalName(path: string): Promise<string> {
  for (;;) {
    try {
      return await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = await realpath(dirname(path));
    const entry = join(parent, basename(path));
    try {
      const target = await readlink(entry);
      // A dangling final symlink can still name a file that writeFile will create.
      // Leave '..' intact until the filesystem resolves any symlinked directories.
      path = isAbsolute(target) ? target : `${parent}${sep}${target}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EINVAL") throw error;
      return entry;
    }
  }
}

async function identify(path: string): Promise<{ name: string; inode?: string }> {
  const name = `name:${await canonicalName(path)}`;
  try {
    const { dev, ino } = await stat(path, { bigint: true });
    return { name, inode: `inode:${dev}:${ino}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { name };
  }
}

/**
 * Coordinate cooperating writers in this process, from read through save and any dependent render.
 * Cancellation removes a waiter; once started, the action must honor its own signal. Its locks
 * stay held until it settles, even on abort, so another writer cannot see an unfinished edit.
 */
export async function withSourceEdits<T>(
  paths: readonly string[], action: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    const identities = await Promise.all(paths.map(identify));
    const keys = new Set<string>();
    for (const { name, inode } of identities) {
      keys.add(name);
      if (inode !== undefined) keys.add(inode);
    }
    const held: Release[] = [];
    try {
      // The whole set uses the same order, including when two edits swap input and output.
      for (const key of [...keys].sort()) held.push(await acquireKey(locks, key, signal));
      signal?.throwIfAborted();
      const current = await Promise.all(paths.map(identify));
      signal?.throwIfAborted();
      // A queued path may have been created, replaced, or retargeted while we waited.
      if (current.every(({ name, inode }, i) => name === identities[i].name && inode === identities[i].inode)) {
        return await action();
      }
    } finally {
      for (const release of held.reverse()) release();
    }
  }
}
