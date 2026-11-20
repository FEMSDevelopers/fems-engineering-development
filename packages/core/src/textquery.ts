import { wildcardToRegExp } from "./docscan.js";

/**
 * Text query of a column filter ("Contains…" / "Does not contain…"), case-insensitive:
 *  - `DS|DOC` (or `DS OR DOC`): either term;  `DS&IG` (or `DS AND IG`): both terms; AND binds tighter than OR.
 *  - Wildcards (glob): `*` any characters, `?` one character, `[abc]` / `[0-9]` one of, `[!abc]` none of; `\` escapes.
 *  - A term matches anywhere in the cell; `=term` must match the whole cell (`=` alone: empty cell).
 *  - `"…"` literal text (spaces, | & * ? kept as typed); `!term`: the cell must not match the term.
 */
export type TextQuery = (text: string) => boolean;

interface Term { re: RegExp | null; neg: boolean; empty: boolean }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Split on | and & (and the words OR / AND) outside quotes: OR groups of AND terms (raw text, quotes kept). */
function split(q: string): string[][] {
  const groups: string[][] = [[]];
  let cur = "";
  let inQ = false;
  const endTerm = () => {
    if (cur.trim()) groups[groups.length - 1].push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < q.length; i++) {
    const c = q[i];
    if (c === "\\" && i + 1 < q.length) {
      cur += c + q[++i];
      continue;
    }
    if (c === '"') {
      inQ = !inQ;
      cur += c;
      continue;
    }
    if (!inQ) {
      const word = /^\s+(AND|OR)\s+/.exec(q.slice(i));
      if (c === "|" || word?.[1] === "OR") {
        endTerm();
        groups.push([]);
        if (word) i += word[0].length - 1;
        continue;
      }
      if (c === "&" || word?.[1] === "AND") {
        endTerm();
        if (word) i += word[0].length - 1;
        continue;
      }
    }
    cur += c;
  }
  endTerm();
  return groups.filter((g) => g.length);
}

function term(raw: string): Term {
  let s = raw.trim();
  let neg = false;
  if (s.startsWith("!") && s.length > 1) (neg = true), (s = s.slice(1).trim());
  let whole = false;
  if (s.startsWith("=")) (whole = true), (s = s.slice(1).trim());
  if (whole && !s) return { re: null, neg, empty: true };
  if (/^".*"$/.test(s) && s.length >= 2) {
    const lit = esc(s.slice(1, -1));
    return { re: new RegExp(whole ? `^${lit}$` : lit, "i"), neg, empty: false };
  }
  // Quotes inside a term (e.g. =\"a b\"*) are just removed; an invalid wildcard falls back to literal text.
  const p = s.replace(/"/g, "");
  return { re: wildcardToRegExp(p, whole) ?? new RegExp(whole ? `^${esc(p)}$` : esc(p), "i"), neg, empty: false };
}

/** Compiled query, or null when the query is empty (matches everything). */
export function compileTextQuery(q: string | undefined): TextQuery | null {
  if (!q?.trim()) return null;
  const groups = split(q).map((g) => g.map(term));
  if (!groups.length) return null;
  return (text: string) => {
    const t = text ?? "";
    return groups.some((g) => g.every((x) => {
      const hit = x.empty ? !t.trim() : !!x.re?.test(t);
      return x.neg ? !hit : hit;
    }));
  };
}

const cache = new Map<string, TextQuery | null>();
/** compileTextQuery with a small cache (filters test every row with the same query). */
export function textQuery(q: string | undefined): TextQuery | null {
  const k = q ?? "";
  if (!cache.has(k)) {
    if (cache.size > 200) cache.clear();
    cache.set(k, compileTextQuery(k));
  }
  return cache.get(k)!;
}
