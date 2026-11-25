/**
 * Minimal shared helpers over `@xmldom/xmldom` nodes. Typed structurally so the
 * validation and explanation code reads cleanly without fighting xmldom's
 * exported types.
 */
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

export interface DomEl {
  nodeType: number;
  tagName?: string;
  nodeValue?: string | null;
  childNodes: { length: number; [i: number]: DomEl };
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
}

/** Element children only (skips text/comment nodes). */
export function elemChildren(el: DomEl): DomEl[] {
  const out: DomEl[] = [];
  for (const n of Array.from(el.childNodes)) {
    if (n?.nodeType === ELEMENT_NODE) out.push(n);
  }
  return out;
}

/** Direct element children with the given tag (non-recursive, like ElementTree.findall). */
export function childrenByTag(el: DomEl, tag: string): DomEl[] {
  return elemChildren(el).filter((c) => c.tagName === tag);
}

/** First direct child with the given tag, or null (like ElementTree.find). */
export function firstByTag(el: DomEl, tag: string): DomEl | null {
  for (const c of elemChildren(el)) if (c.tagName === tag) return c;
  return null;
}

/** Discover page envelopes without needing to inspect or decompress their content. */
export function diagramPages(root: DomEl): DomEl[] {
  switch (root.tagName) {
    case "mxfile": return childrenByTag(root, "diagram");
    case "diagram":
    case "mxGraphModel": return [root];
    default: throw new Error("expected <mxfile>, <diagram>, or <mxGraphModel> root");
  }
}

/** Select the uncompressed graph, if present. Compressed envelopes remain opaque. */
export function pageModel(page: DomEl): DomEl | null {
  return page.tagName === "mxGraphModel" ? page : firstByTag(page, "mxGraphModel");
}

/** Attribute value, or null when absent (distinguishes absent from empty). */
export function attr(el: DomEl, name: string): string | null {
  return el.hasAttribute(name) ? el.getAttribute(name) : null;
}

/** Direct (non-descendant) text of an element, mirroring ElementTree's `.text`. */
export function directText(el: DomEl): string {
  let s = "";
  for (const n of Array.from(el.childNodes)) {
    if (n?.nodeType === TEXT_NODE) s += n.nodeValue ?? "";
  }
  return s;
}
