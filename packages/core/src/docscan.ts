/**
 * Document folder scan: find files whose name contains a part number and classify them by the
 * file-name prefix (DS_… datasheet, IG_… installation guide, SS_… specification sheet; any other
 * or no prefix → Other).
 */

export interface DocPrefix {
  /** Leading token of the file name, e.g. "DS" (case-insensitive); "" = any prefix. */
  prefix: string;
  /**
   * Optional wildcard text the file name must contain (glob syntax, case-insensitive):
   * `*` any characters, `?` one character, `[abc]` / `[a-z]` one of, `[!abc]` none of;
   * e.g. `spec*sheet`, `*_IOM_*`, `rev?`, `*.docx`. With a prefix too, both must match.
   */
  contains?: string;
  /** Document kind it files under, e.g. "Datasheet". */
  kind: string;
}
export const DEFAULT_DOC_PREFIXES: DocPrefix[] = [
  { prefix: "DS", kind: "Datasheet" },
  { prefix: "IG", kind: "Installation guide" },
  { prefix: "SS", kind: "Specification sheet" },
];
export const DOC_SCAN_OTHER = "Other";
/**
 * Optional second rule, used only when the prefix is unknown or missing: a word written anywhere in
 * the file name ("A1.1_SR42UB-DataSheet.pdf", "SCE-24P24_cutsheet.pdf"); case, spaces and
 * punctuation are ignored. The first word of the list that is found wins.
 */
export interface DocWord {
  word: string;
  kind: string;
}
export const DEFAULT_DOC_WORDS: DocWord[] = [
  { word: "datasheet", kind: "Datasheet" },
  { word: "spec sheet", kind: "Specification sheet" },
  { word: "cutsheet", kind: "Specification sheet" },
  { word: "installation guide", kind: "Installation guide" },
  { word: "install guide", kind: "Installation guide" },
  { word: "user guide", kind: "User guide" },
  { word: "manual", kind: "Manual" },
];
export const DEFAULT_DOC_EXTS = ["pdf"];

export interface ScanPart {
  id: string;
  partNumber: string;
  /** Optional extra code also searched (SKU / order code). */
  sku?: string;
}
export interface DocMatch {
  /** "prefix" / "contains" (from the prefix table), "word" (from the word list) or "" (Other). */
  by?: "prefix" | "contains" | "word" | "";
  /** Parts whose part number (or SKU) is in the file name. */
  partIds: string[];
  /** Codes found, in file-name order. */
  codes: string[];
  /** Prefix of the file name ("" when none). */
  prefix: string;
  kind: string;
}

const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Codes shorter than this (alphanumerics) are not searched: too many false hits. */
export const MIN_CODE_LEN = 4;
const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
/**
 * Regex of a part number inside a file name: case-insensitive; any punctuation of the part number
 * may be written as any (or no) separator ("5SY4110-7" matches "5SY4110_7", "5SY41107");
 * the code must not continue with a letter or digit ("S201-C2" does not match "S201-C20").
 */
export function codePattern(code: string): RegExp | null {
  const a = alnum(code);
  if (a.length < MIN_CODE_LEN) return null;
  const parts = code.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const body = parts.map(esc).join("[^A-Z0-9]*");
  return new RegExp(`(^|[^A-Z0-9])(${body})(?![A-Z0-9])`, "gi");
}

/** Item numbers of drawing-set part lines ("A1.1", "B1.4d", "2.4A", "P1.5a"): ignored when looking for the prefix. */
export const PART_LINE_RE = /^[A-Za-z]{0,2}\d{1,3}(\.\d{1,3})*[A-Za-z]?$/;
/**
 * Prefix of a file name = the text before the first part number, part-line numbers left out: a known
 * prefix among its tokens wins ("Siemens_DS_5SY4110-7" → "DS"), else its first token
 * ("UM_2907595" → "UM"); "" when only part lines (or nothing) come before the part number.
 */
export function docPrefixOf(base: string, codeStart: number, prefixes: DocPrefix[]): string {
  if (codeStart <= 0) return "";
  const toks = base.slice(0, codeStart).split(/[^A-Za-z0-9.]+/).map((t) => t.replace(/^\.+|\.+$/g, "")).filter(Boolean);
  const known = toks.flatMap((t) => [t, ...t.split(".")]).find((t) => prefixes.some((p) => p.prefix.trim().toUpperCase() === t.toUpperCase()));
  if (known) return known;
  return toks.find((t) => !PART_LINE_RE.test(t)) ?? "";
}
/** Kind from the word list (first word found in the file name), or null. */
export function kindOfWords(base: string, words: DocWord[]): string | null {
  const hay = base.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const w of words) {
    const n = w.word.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (n.length >= 3 && hay.includes(n)) return w.kind;
  }
  return null;
}
/**
 * Glob wildcard → RegExp (POSIX fnmatch / Windows wildcard syntax): `*` `?` `[…]` `[!…]` (also `[^…]`);
 * `\` escapes the next character. `whole` = the pattern must match the whole text, else it may match
 * anywhere ("contains"). Always case-insensitive. Returns null for an empty or invalid pattern.
 */
export function wildcardToRegExp(pattern: string, whole = false): RegExp | null {
  const p = pattern.trim();
  if (!p) return null;
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) re += esc(p[++i]);
    else if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = p.indexOf("]", i + 2);
      if (end < 0) {
        re += "\\[";
        continue;
      }
      let body = p.slice(i + 1, end);
      const neg = body[0] === "!" || body[0] === "^";
      if (neg) body = body.slice(1);
      re += `[${neg ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&").replace(/^\^/, "\\^")}]`;
      i = end;
    } else re += esc(c);
  }
  try {
    return new RegExp(whole ? `^${re}$` : re, "i");
  } catch {
    return null;
  }
}
/** Does the file name contain the wildcard text? (empty pattern = yes) */
export function nameContains(fileName: string, pattern: string | undefined): boolean {
  if (!pattern?.trim()) return true;
  return wildcardToRegExp(pattern)?.test(fileName) ?? false;
}
/**
 * Rule of the table that fits the file: rows in order, the first whose filled-in conditions all match
 * (prefix = the file's prefix; contains = wildcard text found in the file name). A row with neither is ignored.
 */
export function docRuleFor(fileName: string, prefix: string, rules: DocPrefix[]): DocPrefix | null {
  for (const r of rules) {
    const px = r.prefix.trim();
    const ct = r.contains?.trim() ?? "";
    if (!px && !ct) continue;
    if (px && px.toUpperCase() !== prefix.toUpperCase()) continue;
    if (ct && !nameContains(fileName, ct)) continue;
    return r;
  }
  return null;
}
export function kindOfPrefix(prefix: string, prefixes: DocPrefix[]): string {
  if (!prefix) return DOC_SCAN_OTHER;
  return prefixes.find((p) => p.prefix.trim().toUpperCase() === prefix.toUpperCase())?.kind ?? DOC_SCAN_OTHER;
}

export interface CodeIndex {
  entries: { code: string; re: RegExp; ids: string[]; len: number }[];
}
/** Precompiled patterns of every part number (and SKU) — longest codes first. */
export function buildCodeIndex(parts: ScanPart[], useSku = false): CodeIndex {
  const by = new Map<string, { code: string; ids: string[] }>();
  const add = (code: string, id: string) => {
    const k = alnum(code);
    if (k.length < MIN_CODE_LEN) return;
    const e = by.get(k) ?? { code, ids: [] };
    if (!e.ids.includes(id)) e.ids.push(id);
    by.set(k, e);
  };
  for (const p of parts) {
    add(p.partNumber, p.id);
    if (useSku && p.sku) add(p.sku, p.id);
  }
  const entries = [...by.entries()].map(([k, e]) => ({ code: e.code, re: codePattern(e.code)!, ids: e.ids, len: k.length })).filter((e) => e.re);
  entries.sort((a, b) => b.len - a.len);
  return { entries };
}

/**
 * Match one file name (with or without extension) against the part numbers. Longer codes win over
 * codes they contain, and a file naming several part numbers goes to each of them.
 */
export function matchDocFile(fileName: string, index: CodeIndex, prefixes: DocPrefix[] = DEFAULT_DOC_PREFIXES, words: DocWord[] = []): DocMatch | null {
  const full = fileName.replace(/^.*[\\/]/, "");
  const base = full.replace(/\.[A-Za-z0-9]{1,6}$/, "");
  const taken: [number, number][] = [];
  const hits: { at: number; code: string; ids: string[] }[] = [];
  for (const e of index.entries) {
    e.re.lastIndex = 0;
    for (let m = e.re.exec(base); m; m = e.re.exec(base)) {
      const at = m.index + m[1].length;
      const end = at + m[2].length;
      if (!taken.some(([a, b]) => at < b && end > a)) {
        taken.push([at, end]);
        hits.push({ at, code: e.code, ids: e.ids });
      }
      if (m[0].length === 0) e.re.lastIndex++;
    }
  }
  if (!hits.length) {
    // A known prefix written directly before the part number: "DS5SY4110-7".
    const p = prefixes.find((x) => x.prefix.trim() && base.toUpperCase().startsWith(x.prefix.trim().toUpperCase()) && /[A-Za-z0-9]/.test(base.charAt(x.prefix.trim().length)));
    if (!p) return null;
    const rest = matchDocFile(base.slice(p.prefix.trim().length), index, []);
    if (!rest) return null;
    const px = base.slice(0, p.prefix.trim().length);
    const r = docRuleFor(full, px, prefixes);
    return { ...rest, prefix: px, kind: r?.kind ?? DOC_SCAN_OTHER, by: r ? (r.prefix.trim() ? "prefix" : "contains") : "" };
  }
  hits.sort((a, b) => a.at - b.at);
  const prefix = docPrefixOf(base, hits[0].at, prefixes);
  const rule = docRuleFor(full, prefix, prefixes);
  let kind = rule?.kind ?? DOC_SCAN_OTHER;
  let by: DocMatch["by"] = rule ? (rule.prefix.trim() ? "prefix" : "contains") : "";
  if (!by && words.length) {
    const w = kindOfWords(base, words);
    if (w) (kind = w), (by = "word");
  }
  return {
    partIds: [...new Set(hits.flatMap((h) => h.ids))],
    codes: [...new Set(hits.map((h) => h.code))],
    prefix,
    kind,
    by,
  };
}

/** Normalised extension list: "PDF, .docx" → ["pdf", "docx"]. */
export function normExts(exts: string[] | string): string[] {
  const l = Array.isArray(exts) ? exts : exts.split(/[,;\s]+/);
  return [...new Set(l.map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter((e) => /^[a-z0-9]{1,8}$/.test(e)))];
}
export const DOC_MIME: Record<string, string> = {
  pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", txt: "text/plain",
  zip: "application/zip", dwg: "application/acad", dxf: "image/vnd.dxf", stp: "model/step", step: "model/step", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
};

/**
 * Does a file name resemble a part number or SKU? Compared on letters and digits only, case-insensitive: the code inside
 * the name (`AP7552_3D.zip` ~ `AP7552`), the name inside the code (`AP7552.stp` ~ `AP7552-01`), or a shared run of at
 * least 70 % of the code (min. 5 characters; `6EP3436-8SB00` ~ `6EP3436-8SB00-0AY0`). Empty codes are ignored.
 */
export function nameResembles(fileName: string, codes: (string | null | undefined)[]): boolean {
  const n = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  const name = n(fileName.split(/[\\/]/).pop()!.replace(/\.[A-Za-z0-9]{1,6}$/, ""));
  if (!name) return false;
  for (const raw of codes) {
    const c = n(raw ?? "");
    if (c.length < 3) continue;
    if (name.includes(c) || (name.length >= 4 && c.includes(name))) return true;
    const need = Math.max(5, Math.ceil(c.length * 0.7));
    if (need <= c.length && longestCommon(name, c) >= need) return true;
  }
  return false;
}
function longestCommon(a: string, b: string): number {
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = t;
    }
  }
  return best;
}
