/**
 * Describe a `.drawio` as structured Markdown. The inverse of authoring: it
 * lists components (grouped by container/swimlane/tier), the relations between
 * them (edge labels become the relation verb), and a per-page breakdown for
 * multi-page files. Handy for a README/PR summary or a text-only read-back.
 */
import { basename } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { diagramPages, pageModel, readDiagramXml } from "./diagram-files";
import { type DomEl, attr, elemChildren, firstByTag } from "./dom";
import { geometryIsRelative, isEdgeLabel } from "./geometry";

// style fragment -> human noun. First match wins; order matters (specific first).
const SHAPE_TYPES: [string, string][] = [
  ["mxgraph.aws", "AWS"],
  ["img/lib/azure", "Azure"],
  ["mxgraph.gcp", "GCP"],
  ["mxgraph.kubernetes", "Kubernetes"],
  ["umlActor", "actor"],
  ["shape=actor", "actor"],
  ["shape=cylinder", "data store"],
  ["shape=datastore", "data store"],
  ["shape=cloud", "cloud"],
  ["rhombus", "decision"],
  ["mscae", "Azure"],
  ["shape=process", "process"],
  ["shape=hexagon", "queue"],
];

/** Decode the HTML entities draw.io may leave in a doubly-encoded label. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (reference, hex: string | undefined, decimal: string) => {
      const code = hex === undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
      return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : reference;
    })
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

/** Strip HTML label formatting in linear time, not literal angle-delimited URLs or email addresses. */
function stripTags(text: string): string {
  const parts: string[] = [];
  let copiedThrough = 0;
  let tagStart = -1;

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "<") {
      tagStart = i;
    } else if (text[i] === ">" && tagStart !== -1) {
      if (/^<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>$/i.test(text.slice(tagStart, i + 1))) {
        parts.push(text.slice(copiedThrough, tagStart));
        copiedThrough = i + 1;
      }
      tagStart = -1;
    }
  }

  parts.push(text.slice(copiedThrough));
  return parts.join("");
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Strip HTML tags/entities draw.io stores in labels; collapse whitespace. */
function clean(text: string | null): string {
  if (!text) return "";
  const withLineBreaks = text.replace(/<br\s*\/?>/gi, " ");
  return singleLine(decodeEntities(stripTags(withLineBreaks)));
}

/** Encode ASCII punctuation as literal Markdown text (including GFM autolinks). */
function literal(text: string): string {
  // Empty angle brackets are already literal; keep the readable spelling.
  return singleLine(text).replace(/<>|[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, (c) =>
    c === "<>" ? c : `&#${c.charCodeAt(0)};`,
  );
}

function shapeOf(style: string): string | null {
  for (const [frag, noun] of SHAPE_TYPES) if ((style || "").includes(frag)) return noun;
  return null;
}

interface Entry {
  cell: DomEl;
  id: string | null;
  label: string;
}

/** Collect cells in document order without modifying wrapped cells. */
function cellsOf(root: DomEl): Entry[] {
  const out: Entry[] = [];
  for (const child of elemChildren(root)) {
    if (child.tagName === "mxCell") {
      out.push({ cell: child, id: attr(child, "id"), label: clean(attr(child, "value")) });
    } else if (child.tagName === "UserObject" || child.tagName === "object") {
      const inner = firstByTag(child, "mxCell");
      if (inner) {
        out.push({
          cell: inner,
          id: attr(child, "id"),
          label: clean(attr(child, "label") ?? attr(child, "value") ?? attr(inner, "value")),
        });
      }
    }
  }
  return out;
}

type ById = Map<string, Entry>;

function lookup(byId: ById, cell: DomEl, key: "parent" | "source" | "target"): Entry | undefined {
  return byId.get(attr(cell, key) ?? "");
}

function nameOf(e: Entry): string {
  return e.label ? literal(e.label) : `(unlabeled ${literal(e.id ?? "null")})`;
}

function indexPage(cells: Entry[]) {
  const byId: ById = new Map();
  const parents = new Set<string>();
  for (const e of cells) {
    if (e.id) byId.set(e.id, e);
    const parent = attr(e.cell, "parent");
    if (parent) parents.add(parent);
  }

  const leaves: Entry[] = [];
  const edgeLabels = new Map<Entry, string[]>();
  for (const e of cells) {
    if (e.cell.getAttribute("vertex") !== "1") continue;
    const parent = lookup(byId, e.cell, "parent");
    const parentEdge = parent?.cell.getAttribute("edge") === "1" ? parent : undefined;
    if (isEdgeLabel(e.cell) || (parentEdge && geometryIsRelative(e.cell))) {
      if (parentEdge && e.label) {
        const labels = edgeLabels.get(parentEdge);
        if (labels) labels.push(e.label);
        else edgeLabels.set(parentEdge, [e.label]);
      }
    } else if (!e.id || !parents.has(e.id)) {
      leaves.push(e);
    }
  }
  return { byId, leaves, edgeLabels };
}

function renderComponents(leaves: Entry[], byId: ById): string[] {
  const groups = new Map<string, string[]>();
  for (const e of leaves) {
    const parent = lookup(byId, e.cell, "parent");
    const group = (parent?.cell.getAttribute("vertex") === "1" && parent.label) || "Ungrouped";
    const type = shapeOf(attr(e.cell, "style") ?? "");
    const item = nameOf(e) + (type ? ` _${type}_` : "");
    const items = groups.get(group);
    if (items) items.push(item);
    else groups.set(group, [item]);
  }

  const lines: string[] = [`### Components (${leaves.length})`, ""];
  for (const [group, items] of groups) {
    const ungrouped = groups.size === 1 && group === "Ungrouped";
    if (!ungrouped) lines.push(`- **${literal(group)}**`);
    for (const item of items) lines.push(`${ungrouped ? "" : "  "}- ${item}`);
  }
  return [...lines, ""];
}

function renderRelations(cells: Entry[], byId: ById, edgeLabels: Map<Entry, string[]>): string[] {
  const rels: string[] = [];
  for (const e of cells) {
    if (e.cell.getAttribute("edge") !== "1") continue;
    const s = lookup(byId, e.cell, "source");
    const t = lookup(byId, e.cell, "target");
    if (!s || !t) continue;
    const verbs = [e.label, ...(edgeLabels.get(e) ?? [])].filter(Boolean).map(literal).join("; ");
    rels.push(verbs ? `- ${nameOf(s)} —${verbs}→ ${nameOf(t)}` : `- ${nameOf(s)} → ${nameOf(t)}`);
  }
  return [`### Relations (${rels.length})`, "", ...(rels.length ? rels : ["_(none)_"]), ""];
}

function describePage(page: DomEl): string[] {
  const model = pageModel(page);
  if (!model) return ["_(compressed page — cannot describe)_"];
  const root = firstByTag(model, "root");
  if (!root) return ["_(graph model has no root — cannot describe)_"];
  const cells = cellsOf(root);
  const { byId, leaves, edgeLabels } = indexPage(cells);
  return [...renderComponents(leaves, byId), ...renderRelations(cells, byId, edgeLabels)];
}

/** Describe a `.drawio` XML string as Markdown. */
export function explainXml(xml: string, title = "diagram"): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const rootEl = doc.documentElement as unknown as DomEl | null;
  if (!rootEl) throw new Error("no root element (malformed XML)");
  const pages = diagramPages(rootEl);

  const lines: string[] = [`# ${literal(title)}`, ""];
  pages.forEach((page, i) => {
    if (pages.length > 1) {
      const name = literal(attr(page, "name") ?? "");
      lines.push(name ? `## Page ${i + 1}: ${name}` : `## Page ${i + 1}`, "");
    }
    for (const line of describePage(page)) lines.push(line);
  });
  return lines.join("\n").trimEnd() + "\n";
}

/** Read a `.drawio` file and describe it as Markdown. */
export async function explainFile(path: string): Promise<string> {
  const xml = await readDiagramXml(path);
  const title = basename(path).replace(/\.[^.]*$/, "");
  return explainXml(xml, title);
}
