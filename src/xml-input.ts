import { constants, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";

export const DEFAULT_MAX_XML_BYTES = 16 * 1024 * 1024;

/** Lets callers distinguish an intake budget stop from an ordinary read failure. */
export class DiagramXmlTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`diagram XML exceeds the ${maxBytes} byte limit`);
    this.name = "DiagramXmlTooLargeError";
  }
}

function checkDiagramFile(info: Stats, maxBytes: number): void {
  if (!info.isFile()) throw new Error("diagram XML input is not a regular file");
  if (info.size > maxBytes) throw new DiagramXmlTooLargeError(maxBytes);
}

/** Read UTF-8 diagram XML without trusting a preflight size to remain stable. */
export async function readDiagramXml(path: string, maxBytes = DEFAULT_MAX_XML_BYTES): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("XML byte limit must be a nonnegative safe integer");
  }
  checkDiagramFile(await stat(path), maxBytes);
  // The path may have changed since stat. Avoid blocking on a substituted FIFO.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    checkDiagramFile(info, maxBytes);

    // Reserve one extra byte to distinguish EOF at the limit from an overrun.
    let buffer = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) return buffer.toString("utf8", 0, length);
      length += bytesRead;
      if (length > maxBytes) throw new DiagramXmlTooLargeError(maxBytes);
      if (length === buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, maxBytes + 1));
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
    }
  } finally {
    await file.close();
  }
}
