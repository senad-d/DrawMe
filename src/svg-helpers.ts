import { DOMParser, type Element } from "@xmldom/xmldom";
import { ELEMENT_NODE, type DomEl } from "./dom";

/** Quote an arbitrary draw.io cell ID as a CSS attribute-selector string. */
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

/** Root-inclusive, left-to-right preorder, without recursion on deep SVGs. */
export function walkElements(root: DomEl): DomEl[] {
  const elements: DomEl[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const next = pending.pop()!;
    elements.push(next);
    for (let index = next.childNodes.length - 1; index >= 0; index--) {
      const child = next.childNodes[index];
      if (child.nodeType === ELEMENT_NODE) pending.push(child);
    }
  }
  return elements;
}

const XLINK_NS = "http://www.w3.org/1999/xlink";
const CSS_URL_ATTRIBUTES = ["fill", "stroke", "filter", "clip-path", "mask", "marker", "marker-start",
  "marker-mid", "marker-end", "cursor", "color-profile"];
const ASCII_WHITESPACE = /[\t\n\f\r ]/;

type ImageUrlMap = (url: string) => string;

function assertEmbedded(value: string): string {
  const url = value.trim();
  if (url === "" || url.startsWith("#") || /^data:image\/[\w.+-]+(?:;[^,]*)?,/i.test(url)) return value;
  throw new Error("animated SVG has an unresolved image resource; embed images as data URLs or remove external image references and export again");
}

/** Read HTML srcset candidates without splitting the commas inside data URLs. */
function mapSrcset(value: string, mapUrl: ImageUrlMap): string {
  let index = 0, previousEnd = 0, rewritten = "";
  while (index < value.length) {
    if (value[index] === "," || ASCII_WHITESPACE.test(value[index])) {
      index++;
      continue;
    }
    const start = index;
    while (index < value.length && !ASCII_WHITESPACE.test(value[index])) index++;
    let end = index;
    while (end > start && value[end - 1] === ",") end--;
    const url = value.slice(start, end);
    const mapped = mapUrl(url);
    if (mapped !== url) {
      rewritten += value.slice(previousEnd, start) + mapped;
      previousEnd = end;
    }
    if (end < index) continue;
    let parentheses = 0;
    while (index < value.length) {
      const char = value[index++];
      if (char === "," && parentheses === 0) break;
      if (char === "(") parentheses++;
      if (char === ")" && parentheses > 0) parentheses--;
    }
  }
  return rewritten + value.slice(previousEnd);
}

function decodeCssEscapes(value: string): string {
  return value.replace(/\\(?:([0-9a-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\s\S]))/gi, (_match, hex, char) => {
    if (!hex) return /[\n\r\f]/.test(char) ? "" : char;
    const code = Number.parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
  });
}

function cssUrlAt(css: string, index: number): { url: string; end: number } | undefined {
  while (ASCII_WHITESPACE.test(css[index] ?? "")) index++;
  const quote = css[index] === '"' || css[index] === "'" ? css[index++] : undefined;
  const start = index;
  const escape = /(?:[0-9a-f]{1,6}(?:\r\n|[\t\n\f\r ])?|\r\n|[\s\S])/iy;
  while (index < css.length) {
    const char = css[index];
    if (char === "\\") {
      escape.lastIndex = index + 1;
      if (!escape.test(css)) return undefined;
      index = escape.lastIndex;
    } else if (quote ? char === quote : char === ")" || ASCII_WHITESPACE.test(char)) {
      const url = css.slice(start, index);
      if (quote) index++;
      while (ASCII_WHITESPACE.test(css[index] ?? "")) index++;
      return css[index] === ")" ? { url, end: index + 1 } : undefined;
    } else {
      if (quote ? /[\n\f\r]/.test(char) : char === "(" || char === '"' || char === "'") return undefined;
      index++;
    }
  }
}

/** Map CSS URL functions and image-set strings, not unrelated strings or comments. */
function mapCssUrls(css: string, mapUrl: ImageUrlMap): string {
  let previousEnd = 0, rewritten = "";
  const tokens = /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?:[\w\u0080-\uFFFF-]|\\(?:[0-9a-f]{1,6}(?:\r\n|[\t\n\f\r ])?|[^\n\r\f]))+|[()]/gi;
  const imageSets: number[] = [];
  let depth = 0;
  for (let match = tokens.exec(css); match; match = tokens.exec(css)) {
    const token = match[0];
    if (token === "(") {
      depth++;
      continue;
    }
    if (token === ")") {
      if (imageSets.at(-1) === depth) imageSets.pop();
      depth = Math.max(0, depth - 1);
      continue;
    }
    const quoted = token[0] === '"' || token[0] === "'";
    let argument: string;
    if (quoted) {
      // Only direct strings are candidates; type("image/png") is a descriptor.
      if (imageSets.at(-1) !== depth) continue;
      argument = token.slice(1, -1);
    } else {
      if (css[tokens.lastIndex] !== "(" || token.startsWith("/*")) continue;
      const name = decodeCssEscapes(token).toLowerCase();
      if (name === "image-set" || name === "-webkit-image-set") {
        imageSets.push(++depth);
        tokens.lastIndex++; // The opening parenthesis was counted here.
        continue;
      }
      if (name !== "url") continue;
      const parsed = cssUrlAt(css, tokens.lastIndex + 1);
      if (!parsed) continue; // Malformed CSS URL, not a resource that the viewer can load.
      argument = parsed.url;
      tokens.lastIndex = parsed.end;
    }
    const url = decodeCssEscapes(argument);
    const mapped = mapUrl(url);
    if (mapped !== url) {
      const replacement = cssString(mapped);
      rewritten += css.slice(previousEnd, match.index) + (quoted ? replacement : `url(${replacement})`);
      previousEnd = tokens.lastIndex;
    }
  }
  return rewritten + css.slice(previousEnd);
}

/** Visit image references in SVG or rich HTML labels without loading any resources. */
export function mapImageUrls(root: Element, mapUrl: ImageUrlMap): void {
  for (const node of walkElements(root as unknown as DomEl)) {
    const element = node as unknown as Element;
    const mapAttribute = (name: string, map: ImageUrlMap = mapUrl) => {
      const value = element.getAttribute(name);
      if (value === null) return;
      const mapped = map(value);
      if (mapped !== value) element.setAttribute(name, mapped);
    };
    switch (element.localName) {
      case "image":
      case "feImage":
      case "use": {
        mapAttribute("href");
        const link = element.getAttributeNodeNS(XLINK_NS, "href");
        if (link) {
          const mapped = mapUrl(link.value);
          if (mapped !== link.value) element.setAttributeNS(XLINK_NS, link.name, mapped);
        } else {
          mapAttribute("xlink:href");
        }
        break;
      }
      case "img":
      case "source":
        mapAttribute("src");
        mapAttribute("srcset", (value) => mapSrcset(value, mapUrl));
        break;
      case "style": {
        const css = element.textContent ?? "";
        const mapped = mapCssUrls(css, mapUrl);
        if (mapped !== css) element.textContent = mapped;
        break;
      }
    }
    const mapCss = (value: string) => mapCssUrls(value, mapUrl);
    mapAttribute("style", mapCss);
    for (const attribute of CSS_URL_ATTRIBUTES) mapAttribute(attribute, mapCss);
  }
}

/** Animated SVGs must carry their image data; never read or fetch referenced resources. */
export function assertStandaloneImages(svg: string): void {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (root?.localName !== "svg") throw new Error("draw.io output is not valid SVG");
  mapImageUrls(root, assertEmbedded);
}
