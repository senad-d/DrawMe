/**
 * Search 10k+ official draw.io shapes for their exact `style=` strings using the
 * bundled `assets/data/shape-index.json.gz` file (upstream draw.io shape data;
 * see the notice beside it). Resolves a keyword query such as "aws lambda" or
 * "uml actor" to the real palette style instead of a guess.
 *
 * Prefers exact normalized titles, then uses exact + Soundex tag matches with
 * strict AND first, a scored OR fallback, and a verbatim-title tiebreaker.
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export interface Shape {
  style: string;
  w: number;
  h: number;
  title: string;
  tags?: string;
  type?: string;
}
export interface ShapeMatch {
  style: string;
  w: number;
  h: number;
  title: string;
}

const SOUNDEX_MAP = "01230120022455012603010202"; // A..Z digit codes

/**
 * Strip a trailing run of dots followed by digits before Soundex (e.g. "s3" → "s",
 * "ec2" → "ec"). Equivalent to the old /\.*\d*$/ but linear (no backtracking).
 */
function stripTrail(name: string): string {
  let end = name.length;
  while (end > 0 && name[end - 1] >= "0" && name[end - 1] <= "9") end--;
  while (end > 0 && name[end - 1] === ".") end--;
  return name.slice(0, end);
}

function soundex(name: string): string {
  if (!name) return "";
  const s: string[] = [name[0].toUpperCase()];
  for (const ch of name.slice(1)) {
    const c = (ch.toUpperCase().codePointAt(0) ?? 0) - 65;
    if (c >= 0 && c <= 25 && SOUNDEX_MAP[c] !== "0") {
      const code = SOUNDEX_MAP[c];
      if (code !== s.at(-1)) {
        s.push(code);
        if (s.length > 4) break;
      }
    }
  }
  while (s.length < 4) s.push("0");
  return s.slice(0, 4).join("");
}

function buildTagMap(shapes: Shape[]): Map<string, Set<number>> {
  const tagMap = new Map<string, Set<number>>();
  const add = (key: string, i: number) => {
    let set = tagMap.get(key);
    if (!set) {
      set = new Set();
      tagMap.set(key, set);
    }
    set.add(i);
  };
  for (let i = 0; i < shapes.length; i++) {
    const raw = shapes[i].tags;
    if (!raw) continue;
    const seen = new Set<string>();
    for (const token of raw.toLowerCase().replace(/[/,()]/g, " ").split(" ")) {
      if (token.length < 2 || seen.has(token)) continue;
      seen.add(token);
      add(token, i);
      const sx = soundex(stripTrail(token));
      if (sx && sx !== token && !seen.has(sx)) {
        seen.add(sx);
        add(sx, i);
      }
    }
  }
  return tagMap;
}

function normalizeWords(text: string): string {
  return text
    // Split AWSLambda, but keep alphanumeric terms such as IPv6 intact.
    .replace(/([A-Z])([A-Z][a-z])(?![0-9])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function buildTitleMap(shapes: Shape[]): Map<string, number[]> {
  const titles = new Map<string, number[]>();
  for (const [i, shape] of shapes.entries()) {
    for (const title of new Set([shape.title.toLowerCase(), normalizeWords(shape.title)])) {
      const matches = titles.get(title);
      if (matches) matches.push(i);
      else titles.set(title, [i]);
    }
  }
  return titles;
}

interface TermMatch {
  exact: Set<number>;
  phonetic: Set<number>;
}

function matchTerm(tagMap: Map<string, Set<number>>, term: string): TermMatch {
  const exact = new Set<number>(tagMap.get(term) ?? new Set<number>());
  let phonetic = new Set<number>();
  const sx = soundex(stripTrail(term));
  if (sx && sx !== term) {
    phonetic = new Set([...(tagMap.get(sx) ?? new Set<number>())].filter((i) => !exact.has(i)));
  }
  return { exact, phonetic };
}

/** Strict AND across all terms (exact ∪ phonetic per term). Null when there are no terms. */
function intersectAll(termMatches: TermMatch[]): Set<number> | null {
  let andSet: Set<number> | null = null;
  for (const { exact, phonetic } of termMatches) {
    const combined = new Set<number>([...exact, ...phonetic]);
    if (andSet === null) {
      andSet = combined;
    } else {
      const prev: Set<number> = andSet;
      andSet = new Set<number>([...prev].filter((i) => combined.has(i)));
    }
    if (andSet.size === 0) break;
  }
  return andSet;
}

/** Score: +1.0 exact, +0.5 Soundex-only, per term. Restrict to `pool` (AND results) if given. */
function scoreMatches(termMatches: TermMatch[], pool: Set<number> | null): Map<number, number> {
  const scores = new Map<number, number>();
  for (const { exact, phonetic } of termMatches) {
    for (const idx of exact) if (pool === null || pool.has(idx)) scores.set(idx, (scores.get(idx) ?? 0) + 1.0);
    for (const idx of phonetic)
      if ((pool === null || pool.has(idx)) && !exact.has(idx)) scores.set(idx, (scores.get(idx) ?? 0) + 0.5);
  }
  return scores;
}

/** Rank by whole-title match, then tag score, title hits, title, and index. */
function rankMatches(
  scores: Map<number, number>,
  exactTitles: Set<number>,
  verbatim: string,
  shapes: Shape[],
  terms: string[],
  limit: number,
): ShapeMatch[] {
  const termSet = new Set(terms);
  const titleHits = (idx: number): number => {
    const toks = new Set(shapes[idx].title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let n = 0;
    for (const t of termSet) if (toks.has(t)) n++;
    return n;
  };

  const ranked = [...new Set([...exactTitles, ...scores.keys()])].sort((a, b) => {
    const aVerbatim = shapes[a].title.toLowerCase() === verbatim, bVerbatim = shapes[b].title.toLowerCase() === verbatim;
    if (aVerbatim !== bVerbatim) return aVerbatim ? -1 : 1;
    if (exactTitles.has(a) !== exactTitles.has(b)) return exactTitles.has(a) ? -1 : 1;
    const ds = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (ds !== 0) return ds;
    const dh = titleHits(b) - titleHits(a);
    if (dh !== 0) return dh;
    const ta = shapes[a].title.toLowerCase();
    const tb = shapes[b].title.toLowerCase();
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return a - b;
  });
  return ranked.slice(0, limit).map((i) => ({ style: shapes[i].style, w: shapes[i].w, h: shapes[i].h, title: shapes[i].title }));
}

interface ShapeIndex {
  shapes: Shape[];
  tagMap: Map<string, Set<number>>;
  titleMap: Map<string, number[]>;
}

const INDEX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "data", "shape-index.json.gz");
let cachedIndex: ShapeIndex | null = null;

function load(): ShapeIndex {
  if (!cachedIndex) {
    const shapes = JSON.parse(gunzipSync(readFileSync(INDEX_PATH)).toString("utf8")) as Shape[];
    cachedIndex = { shapes, tagMap: buildTagMap(shapes), titleMap: buildTitleMap(shapes) };
  }
  return cachedIndex;
}

/** Search the bundled shape index; returns up to `limit` matches ranked by relevance. */
export function searchShapes(query: string, limit = 10): ShapeMatch[] {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError("shape search limit must be a nonnegative integer");
  if (limit === 0) return [];
  const normalized = normalizeWords(query);
  if (!normalized) return [];

  const { shapes, tagMap, titleMap } = load();
  const terms = [...new Set(normalized.split(" ").filter((term) => term.length >= 2))];
  const termMatches = terms.map((t) => matchTerm(tagMap, t));
  const andSet = intersectAll(termMatches);
  const pool = andSet?.size ? andSet : null; // AND results if any, else OR across all terms
  const scores = scoreMatches(termMatches, pool);
  const verbatim = query.trim().toLowerCase();
  const exactTitles = new Set([...(titleMap.get(verbatim) ?? []), ...(titleMap.get(normalized) ?? [])]);
  return rankMatches(scores, exactTitles, verbatim, shapes, terms, limit);
}
