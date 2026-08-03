/**
 * Minimal shared helpers over `@xmldom/xmldom` nodes. Typed structurally so the
 * `.drawio` ports (validate, explain) read like the ElementTree originals without
 * fighting xmldom's exported types. Local-only, no network.
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
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n && n.nodeType === ELEMENT_NODE) out.push(n);
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

/** Attribute value, or null when absent (distinguishes absent from empty). */
export function attr(el: DomEl, name: string): string | null {
  return el.hasAttribute(name) ? el.getAttribute(name) : null;
}

/** Direct (non-descendant) text of an element, mirroring ElementTree's `.text`. */
export function directText(el: DomEl): string {
  let s = "";
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n && n.nodeType === TEXT_NODE) s += n.nodeValue ?? "";
  }
  return s;
}
