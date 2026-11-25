/**
 * Describe a `.drawio` as structured Markdown. The inverse of authoring: it
 * lists components (grouped by container/swimlane/tier), the relations between
 * them (edge labels become the relation verb), and a per-page breakdown for
 * multi-page files. Handy for a README/PR summary or a text-only read-back.
 */
import { basename } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { type DomEl, attr, diagramPages, directText, elemChildren, firstByTag, pageModel } from "./dom";
import { isEdgeLabel } from "./geometry";
import { readDiagramXml } from "./xml-input";

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

const NUMERIC_REFERENCE = /&#(?:x([0-9a-fA-F]+)|(\d+));/g;

function scalarValue(hex: string | undefined, decimal: string): number | null {
  const value = hex === undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex, 16);
  return value <= 0x10FFFF && (value < 0xD800 || value > 0xDFFF) ? value : null;
}

/** Decode the HTML entities draw.io may leave in a doubly-encoded label. */
function decodeEntities(s: string): string {
  return s
    .replace(NUMERIC_REFERENCE, (_reference, hex, decimal) => String.fromCodePoint(scalarValue(hex, decimal) ?? 0xFFFD))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

/** Strip tag-shaped spans in linear time while preserving unmatched delimiters. */
function stripTags(text: string): string {
  const parts: string[] = [];
  let copiedThrough = 0;
  let tagStart = -1;

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "<" && tagStart === -1) {
      tagStart = i;
    } else if (text[i] === ">" && tagStart !== -1) {
      if (/^\/?[a-z][\w-]*(?=\s|\/|$)/i.test(text.slice(tagStart + 1, i))) {
        parts.push(text.slice(copiedThrough, tagStart));
        copiedThrough = i + 1;
      }
      tagStart = -1;
    }
  }

  parts.push(text.slice(copiedThrough));
  return parts.join("");
}

/** Strip HTML tags/entities draw.io stores in labels; collapse whitespace. */
function clean(text: string | null): string {
  if (!text) return "";
  const withLineBreaks = text.replace(/<br\s*\/?>/gi, " ");
  return decodeEntities(stripTags(withLineBreaks)).replace(/\s+/g, " ").trim();
}

/** Emit one line of literal text; escape GFM autolinks as well as Markdown delimiters. */
function markdownText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    // The empty angle pair is already literal; other angles can start tags or quotes.
    .replace(/<>|[\\`*_{}[\]<>#|!+.:=@~&-]/g, (token) => token === "<>" ? token : `\\${token}`)
    .replace(/^(\d+)\)(?= |$)/, "$1\\)");
}

function shapeOf(style: string): string | null {
  for (const [frag, noun] of SHAPE_TYPES) if (style.includes(frag)) return noun;
  return null;
}

interface Entry {
  cell: DomEl;
  id: string | null;
  label: string;
}

/** Read the effective ID and label without changing wrapped cells. */
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
          id: attr(child, "id") ?? attr(inner, "id"),
          label: clean(attr(child, "label")) || clean(attr(child, "value")) || clean(attr(inner, "value")),
        });
      }
    }
  }
  return out;
}

interface PageIndex {
  byId: Map<string, Entry>;
  containers: Set<Entry>;
  edgeChildren: Set<Entry>;
  edgeLabels: Map<Entry, Set<string>>;
}

/** Index all terminals, then collect distinct edge labels in document order. */
function indexPage(cells: Entry[]): PageIndex {
  const byId = new Map<string, Entry>();
  for (const e of cells) if (e.id) byId.set(e.id, e);

  const containers = new Set<Entry>();
  const edgeChildren = new Set<Entry>();
  const edgeLabels = new Map<Entry, Set<string>>();
  for (const e of cells) {
    const parent = byId.get(attr(e.cell, "parent") ?? "");
    if (parent?.cell.getAttribute("vertex") === "1") containers.add(parent);
    const childLabel = e.cell.getAttribute("vertex") === "1" && parent?.cell.getAttribute("edge") === "1";
    if (childLabel) edgeChildren.add(e);
    const edge = e.cell.getAttribute("edge") === "1" ? e : childLabel ? parent : undefined;
    if (edge && e.label) {
      let labels = edgeLabels.get(edge);
      if (!labels) edgeLabels.set(edge, (labels = new Set()));
      labels.add(e.label);
    }
  }
  return { byId, containers, edgeChildren, edgeLabels };
}

function entryName(e: Entry): string {
  return e.label || `(unlabeled ${e.id})`;
}

/** Group leaf vertices by their container's label, keeping first-seen order. */
function renderComponents(cells: Entry[], idx: PageIndex): string[] {
  const groups = new Map<string, Entry[]>();
  let count = 0;
  for (const e of cells) {
    if (e.cell.getAttribute("vertex") !== "1" || idx.containers.has(e) || idx.edgeChildren.has(e) || isEdgeLabel(e.cell)) {
      continue;
    }
    const parent = idx.byId.get(attr(e.cell, "parent") ?? "");
    const groupName = (parent && idx.containers.has(parent) && parent.label) || "Ungrouped";
    let group = groups.get(groupName);
    if (!group) groups.set(groupName, (group = []));
    group.push(e);
    count++;
  }

  const lines: string[] = [`### Components (${count})`, ""];
  const grouped = !(groups.size === 1 && groups.has("Ungrouped"));
  for (const [name, group] of groups) {
    if (grouped) lines.push(`- **${markdownText(name)}**`);
    for (const e of group) {
      const typ = shapeOf(attr(e.cell, "style") ?? "");
      lines.push(`${grouped ? "  " : ""}- ${markdownText(entryName(e))}${typ ? ` _${typ}_` : ""}`);
    }
  }
  lines.push("");
  return lines;
}

function renderRelations(cells: Entry[], idx: PageIndex): string[] {
  const rels: string[] = [];
  for (const e of cells) {
    if (e.cell.getAttribute("edge") !== "1") continue;
    const source = idx.byId.get(attr(e.cell, "source") ?? "");
    const target = idx.byId.get(attr(e.cell, "target") ?? "");
    if (!source || !target) continue; // dangling endpoint — skip
    const verb = Array.from(idx.edgeLabels.get(e) ?? [], markdownText).join("; ");
    rels.push(`- ${markdownText(entryName(source))} ${verb ? `—${verb}→` : "→"} ${markdownText(entryName(target))}`);
  }
  return [`### Relations (${rels.length})`, "", ...(rels.length ? rels : ["_(none)_"]), ""];
}

function describePage(page: DomEl): string[] {
  const model = pageModel(page);
  if (!model) {
    const reason = directText(page).trim() ? "compressed page" : "missing graph model";
    return [`_(${reason} — cannot describe)_`];
  }
  const root = firstByTag(model, "root");
  if (!root) return ["_(missing graph root — cannot describe)_"];
  const cells = cellsOf(root);
  const idx = indexPage(cells);
  return [...renderComponents(cells, idx), ...renderRelations(cells, idx)];
}

/** Describe a `.drawio` XML string as Markdown. */
export function explainXml(xml: string, title = "diagram"): string {
  // Keep valid references for XML parsing, but don't let the parser coerce invalid scalars.
  const safeXml = xml.replace(NUMERIC_REFERENCE, (reference, hex, decimal) =>
    scalarValue(hex, decimal) === null ? "&#xFFFD;" : reference,
  );
  const doc = new DOMParser().parseFromString(safeXml, "text/xml");
  const rootEl = doc.documentElement as unknown as DomEl | null;
  if (!rootEl) throw new Error("no root element (malformed XML)");
  const pages = diagramPages(rootEl);

  const lines: string[] = [`# ${markdownText(title)}`, ""];
  pages.forEach((page, i) => {
    if (pages.length > 1) {
      const name = markdownText(attr(page, "name") ?? "");
      lines.push(name ? `## Page ${i + 1}: ${name}` : `## Page ${i + 1}`, "");
    }
    lines.push(...describePage(page));
  });
  return lines.join("\n").trimEnd() + "\n";
}

/** Read a `.drawio` file and describe it as Markdown. */
export async function explainFile(path: string): Promise<string> {
  const xml = await readDiagramXml(path);
  const title = basename(path).replace(/\.[^.]*$/, "");
  return explainXml(xml, title);
}
