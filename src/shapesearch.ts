/**
 * Search 10k+ official draw.io shapes for their exact `style=` strings — a
 * pure-TypeScript port of the skill's `scripts/shapesearch.py`, over the bundled
 * `assets/data/shape-index.json.gz` (upstream draw.io shape data; see the notice
 * beside it). Resolves a keyword query (e.g. "aws lambda", "uml actor") to the
 * real palette style so a diagram uses the official shape instead of a guess.
 * Local-only, no network.
 *
 * Algorithm mirrors upstream (tag map with exact + Soundex matching, strict AND
 * first, scored OR fallback) plus the skill's verbatim-title tiebreaker.
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

function splitCompound(token: string): string[] {
  const spaced = token
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-zA-Z])/g, "$1 $2");
  return spaced
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length >= 2);
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

/** Sub-terms for a raw query word: its compound splits, else the whole word if long enough. */
function pickTerms(subs: string[], raw: string): string[] {
  if (subs.length) return subs;
  return raw.length >= 2 ? [raw] : [];
}

/** Tokenize the query into unique search terms (compound-split, deduped, order-preserving). */
function parseTerms(query: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const t of pickTerms(splitCompound(raw), raw)) {
      if (!seen.has(t)) {
        seen.add(t);
        terms.push(t);
      }
    }
  }
  return terms;
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

/** Rank scored shapes: by score, then verbatim-title hits, then title, then index. */
function rankMatches(scores: Map<number, number>, shapes: Shape[], terms: string[], limit: number): ShapeMatch[] {
  const termSet = new Set(terms);
  const titleHits = (idx: number): number => {
    const toks = new Set(shapes[idx].title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    let n = 0;
    for (const t of termSet) if (toks.has(t)) n++;
    return n;
  };

  const ranked = [...scores.keys()].sort((a, b) => {
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

function search(shapes: Shape[], tagMap: Map<string, Set<number>>, query: string, limit: number): ShapeMatch[] {
  if (!query) return [];
  const terms = parseTerms(query);
  if (!terms.length) return [];

  const termMatches = terms.map((t) => matchTerm(tagMap, t));
  const andSet = intersectAll(termMatches);
  const pool = andSet?.size ? andSet : null; // AND results if any, else OR across all terms
  const scores = scoreMatches(termMatches, pool);
  return rankMatches(scores, shapes, terms, limit);
}

const INDEX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "data", "shape-index.json.gz");
let cachedShapes: Shape[] | null = null;
let cachedTagMap: Map<string, Set<number>> | null = null;

function load(): { shapes: Shape[]; tagMap: Map<string, Set<number>> } {
  if (!cachedShapes || !cachedTagMap) {
    cachedShapes = JSON.parse(gunzipSync(readFileSync(INDEX_PATH)).toString("utf8")) as Shape[];
    cachedTagMap = buildTagMap(cachedShapes);
  }
  return { shapes: cachedShapes, tagMap: cachedTagMap };
}

/** Search the bundled shape index; returns up to `limit` matches ranked by relevance. */
export function searchShapes(query: string, limit = 10): ShapeMatch[] {
  const { shapes, tagMap } = load();
  return search(shapes, tagMap, query, limit);
}
