/**
 * Describe a `.drawio` as structured Markdown — a pure-TypeScript port of the
 * skill's `scripts/explain.py`. The inverse of authoring: it lists components
 * (grouped by container/swimlane/tier), the relations between them (edge labels
 * become the relation verb), and a per-page breakdown for multi-page files.
 * Handy for a README/PR summary or a text-only read-back. Local-only, no network.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { type DomEl, attr, childrenByTag, elemChildren, firstByTag } from "./dom";

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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Strip HTML tags/entities draw.io stores in labels; collapse whitespace. */
function clean(text: string | null): string {
  if (!text) return "";
  let t = text.replace(/<br\s*\/?>/gi, " ");
  t = t.replace(/<[^>]+>/g, "");
  return decodeEntities(t).replace(/\s+/g, " ").trim();
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

/** Entries for a page, unwrapping UserObject/object wrappers; null for a compressed/empty page. */
function cellsOf(page: DomEl): Entry[] | null {
  const model = firstByTag(page, "mxGraphModel");
  const root = model ? firstByTag(model, "root") : null;
  if (!root) return null;
  const out: Entry[] = [];
  for (const child of elemChildren(root)) {
    if (child.tagName === "mxCell") {
      out.push({ cell: child, id: attr(child, "id"), label: clean(attr(child, "value")) });
    } else if (child.tagName === "UserObject" || child.tagName === "object") {
      const inner = firstByTag(child, "mxCell");
      if (inner) {
        inner.setAttribute("id", attr(child, "id") ?? "");
        out.push({ cell: inner, id: attr(child, "id"), label: clean(attr(child, "label") ?? attr(child, "value")) });
      }
    }
  }
  return out;
}

function describePage(page: DomEl): string[] {
  const cells = cellsOf(page);
  if (cells === null) return ["_(compressed page — cannot describe)_"];

  const label = new Map<string | null, string>();
  const style = new Map<string | null, string>();
  for (const e of cells) {
    label.set(e.id, e.label);
    style.set(e.id, attr(e.cell, "style") ?? "");
  }
  const parents = new Set<string>();
  for (const e of cells) {
    const p = attr(e.cell, "parent");
    if (p) parents.add(p);
  }

  const vertices = cells.filter((e) => e.cell.getAttribute("vertex") === "1");
  const containers = new Set<string>();
  for (const e of vertices) if (e.id !== null && parents.has(e.id)) containers.add(e.id);
  const leaves = vertices.filter(
    (e) => (e.id === null || !containers.has(e.id)) && !(style.get(e.id) ?? "").includes("edgeLabel"),
  );

  // Group leaves by their container's label (else "Ungrouped").
  const groups = new Map<string, string[]>();
  const order: string[] = [];
  for (const e of leaves) {
    const parent = attr(e.cell, "parent");
    let gname = parent !== null && containers.has(parent) ? label.get(parent) || "" : "";
    gname = gname || "Ungrouped";
    if (!groups.has(gname)) {
      groups.set(gname, []);
      order.push(gname);
    }
    const typ = shapeOf(style.get(e.id) ?? "");
    const name = label.get(e.id) || `(unlabeled ${e.id})`;
    groups.get(gname)!.push(name + (typ ? ` _${typ}_` : ""));
  }

  const lines: string[] = [`### Components (${leaves.length})`, ""];
  const single = order.length === 1 && order[0] === "Ungrouped";
  for (const gname of order) {
    if (!single) {
      lines.push(`- **${gname}**`);
      for (const item of groups.get(gname)!) lines.push(`  - ${item}`);
    } else {
      for (const item of groups.get(gname)!) lines.push(`- ${item}`);
    }
  }
  lines.push("");

  const edges = cells.filter((e) => e.cell.getAttribute("edge") === "1").map((e) => e.cell);
  const rels: string[] = [];
  for (const e of edges) {
    const s = label.get(attr(e, "source"));
    const t = label.get(attr(e, "target"));
    if (!s || !t) continue; // dangling endpoint — skip
    const verb = clean(attr(e, "value"));
    rels.push(verb ? `- ${s} —${verb}→ ${t}` : `- ${s} → ${t}`);
  }
  lines.push(`### Relations (${rels.length})`, "");
  lines.push(...(rels.length ? rels : ["_(none)_"]));
  lines.push("");
  return lines;
}

/** Describe a `.drawio` XML string as Markdown. */
export function explainXml(xml: string, title = "diagram"): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const rootEl = doc.documentElement as unknown as DomEl | null;
  if (!rootEl) throw new Error("no root element (malformed XML)");
  const pageList = childrenByTag(rootEl, "diagram");
  const pages = pageList.length ? pageList : [rootEl];

  const lines: string[] = [`# ${title}`, ""];
  pages.forEach((page, i) => {
    if (pages.length > 1) {
      const name = attr(page, "name");
      lines.push(name ? `## Page ${i + 1}: ${name}` : `## Page ${i + 1}`, "");
    }
    lines.push(...describePage(page));
  });
  return lines.join("\n").replace(/\s+$/, "") + "\n";
}

/** Read a `.drawio` file and describe it as Markdown. */
export async function explainFile(path: string): Promise<string> {
  const xml = await readFile(path, "utf8");
  const title = basename(path).replace(/\.[^.]*$/, "");
  return explainXml(xml, title);
}
