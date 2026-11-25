import type { Element } from "@xmldom/xmldom";
import { type DomEl, ELEMENT_NODE, attr } from "./dom";

/** Quote an arbitrary draw.io cell id as a CSS attribute-selector string. */
export function cssString(value: string): string {
  let escaped = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === "\\") escaped += `\\${char}`;
    else if (code <= 0x1f || code === 0x7f) escaped += `\\${code.toString(16)} `;
    else escaped += char;
  }
  return `${escaped}"`;
}

/** Preorder traversal including the root, skipping non-element nodes. */
export function walkElements(root: DomEl): DomEl[] {
  const elements: DomEl[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const element = pending.pop()!;
    elements.push(element);
    for (let i = element.childNodes.length - 1; i >= 0; i--) {
      const child = element.childNodes[i];
      if (child?.nodeType === ELEMENT_NODE) pending.push(child);
    }
  }
  return elements;
}

const XLINK_NS = "http://www.w3.org/1999/xlink";
const HTML_NS = "http://www.w3.org/1999/xhtml";
export const SVG_NS = "http://www.w3.org/2000/svg";

function verifyImageReference(reference: string | null): void {
  const url = reference?.trim();
  if (url && !url.startsWith("#") && !/^data:/i.test(url)) {
    throw new Error("animated SVG contains a linked image; embed the image in the diagram and export again");
  }
}

/** srcset URL tokens can themselves contain commas (notably in data: URLs). */
function verifyImageCandidates(srcset: string): void {
  const tokens = /[^\t\n\f\r ,][^\t\n\f\r ]*/g;
  for (let token = tokens.exec(srcset); token; token = tokens.exec(srcset)) {
    verifyImageReference(token[0]);
    if (!token[0].endsWith(",")) {
      // Skip this candidate's descriptor, e.g. "2x", up to the next candidate.
      const next = srcset.indexOf(",", tokens.lastIndex);
      if (next < 0) break;
      tokens.lastIndex = next + 1;
    }
  }
}

/** Check renderer-emitted image elements, including images in HTML labels. Never resolve or fetch URLs. */
export function verifyStandaloneImages(elements: readonly DomEl[]): void {
  for (const node of elements) {
    const element = node as unknown as Element;
    const { localName, namespaceURI } = element;
    if ((namespaceURI === SVG_NS || !namespaceURI) && (localName === "image" || localName === "feImage")) {
      verifyImageReference(attr(node, "href"));
      // Older SVG viewers may read the XLink fallback even if href is present.
      verifyImageReference(element.getAttributeNS(XLINK_NS, "href"));
    } else if (namespaceURI === HTML_NS && (localName === "img" || localName === "source")) {
      if (localName === "img") verifyImageReference(attr(node, "src"));
      verifyImageCandidates(attr(node, "srcset") ?? "");
    }
  }
}
