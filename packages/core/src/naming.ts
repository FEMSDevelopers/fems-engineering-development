/**
 * Document naming standard: one file-name pattern per document type, so datasheets, manuals, certificates… of every OEM
 * are named the same way in every project. Placeholders:
 *   {prefix} custom prefix of the document   {suffix} custom suffix of the document   {mfr} manufacturer   {mfra} manufacturer alias   {pn} part number   {series}   {sub} subcategory
 *   {kind} document type   {code} type code (DS, MAN…)   {title} document title   {std} certified standard (certificates)
 *   {n} sequence among the part's documents of the same type   {date} YYYYMMDD
 */
import { DOC_KINDS } from "./bom.js";

export interface NamingRule {
  kind: string;
  code: string;
  pattern: string;
}
export interface NamingStandard {
  rules: NamingRule[];
  /** Used for document types without a rule. */
  defaultPattern: string;
  case: "upper" | "lower" | "asis";
  /** Replaces spaces and other separators inside values. */
  sep: "_" | "-" | " ";
  maxLen: number;
}

export const DOC_CODES: Record<string, string> = {
  Datasheet: "DS", Manual: "MAN", "User guide": "UG", "Installation guide": "IG", Flyer: "FLY", Certificate: "CERT", "Drawing / CAD": "CAD", Software: "SW", "Specification sheet": "SS", Image: "IMG", Other: "DOC",
};
export const DEFAULT_NAMING: NamingStandard = {
  rules: DOC_KINDS.map((k) => ({ kind: k, code: DOC_CODES[k] ?? "DOC", pattern: k === "Certificate" ? "{prefix}_{mfr}_{pn}_{code}_{std}_{suffix}" : "{prefix}_{mfr}_{pn}_{code}_{suffix}" })),
  defaultPattern: "{prefix}_{mfr}_{pn}_{code}_{title}_{suffix}",
  case: "upper",
  sep: "_",
  maxLen: 120,
};
export const NAMING_PLACEHOLDERS = ["prefix", "suffix", "mfr", "mfra", "pn", "series", "sub", "kind", "code", "title", "std", "year", "n", "date"];
/** Placeholder → what it is (field panel of the naming editor). */
export const NAMING_PLACEHOLDER_HELP: Record<string, string> = {
  prefix: "custom prefix of the document (Edit part → Documents)", suffix: "custom suffix of the document", mfr: "manufacturer", mfra: "manufacturer alias (short hand; the manufacturer when none)",
  pn: "part number", series: "product series", sub: "subcategory", kind: "document type", code: "document type code (DS, MAN…)", title: "document title",
  std: "certified standard (certificates)", year: "year the document was published (Edit part → Documents; empty when not set)", n: "sequence among the part's documents of the same type", date: "today, YYYYMMDD",
};

export interface NamingDoc {
  kind: string;
  title: string;
  fileName: string;
  prefix?: string;
  suffix?: string;
  ref?: string;
  /** Year published ({year}). */
  year?: number | null;
}
export interface NamingPart {
  manufacturer: string;
  partNumber: string;
  series?: string;
  /** Manufacturer alias ({mfra}); the manufacturer when absent. */
  mfrAlias?: string;
}

const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]+/g;
/** File name for a document under a naming standard (the original extension is kept). */
export function docFileName(std: NamingStandard, d: NamingDoc, p: NamingPart, extra: { sub?: string; n?: number; date?: Date; before?: string; after?: string } = {}): string {
  const rule = std.rules.find((r) => r.kind.toLowerCase() === d.kind.toLowerCase());
  const pattern = rule?.pattern || std.defaultPattern;
  const ext = (d.fileName.match(/\.[A-Za-z0-9]{1,6}$/)?.[0] ?? (d.fileName ? "" : ".url")).toLowerCase();
  const dt = extra.date ?? new Date();
  const clean = (v: string) => {
    let x = (v ?? "").replace(ILLEGAL, " ").trim();
    x = x.replace(/[\s_\-.,;]+/g, std.sep);
    if (std.case === "upper") x = x.toUpperCase();
    if (std.case === "lower") x = x.toLowerCase();
    return x;
  };
  const vals: Record<string, string> = {
    prefix: d.prefix ? clean(d.prefix) : "",
    suffix: d.suffix ? clean(d.suffix) : "",
    mfr: clean(p.manufacturer),
    mfra: clean(p.mfrAlias || p.manufacturer),
    pn: clean(p.partNumber),
    series: clean(p.series ?? ""),
    sub: clean(extra.sub ?? ""),
    kind: clean(d.kind),
    code: clean(rule?.code ?? DOC_CODES[d.kind] ?? "DOC"),
    title: clean(d.title.replace(/\.[A-Za-z0-9]{1,6}$/, "")),
    std: clean((d.ref ?? "").replace(/^(cert|ctype):/, "")),
    year: d.year ? String(d.year) : "",
    n: extra.n != null ? String(extra.n) : "",
    date: `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, "0")}${String(dt.getDate()).padStart(2, "0")}`,
  };
  let name = pattern.replace(/\{(\w+)\}/g, (_m, k: string) => vals[k.toLowerCase()] ?? "");
  // A prefix / suffix typed on the document is never lost: added at the start / end when the pattern has no place for it.
  if (vals.prefix && !/\{prefix\}/i.test(pattern)) name = `${vals.prefix}${std.sep}${name}`;
  if (vals.suffix && !/\{suffix\}/i.test(pattern)) name = `${name}${std.sep}${vals.suffix}`;
  // Project prefix / suffix keep their dots (part lines like A2.1); only spaces become the separator.
  const light = (v: string) => {
    let x = v.replace(ILLEGAL, " ").trim().replace(/\s+/g, std.sep);
    if (std.case === "upper") x = x.toUpperCase();
    if (std.case === "lower") x = x.toLowerCase();
    return x;
  };
  if (extra.before) name = `${light(extra.before)}${std.sep}${name}`;
  if (extra.after) name = `${name}${std.sep}${light(extra.after)}`;
  // Tidy separators left by empty placeholders.
  const s = std.sep === " " ? " " : `\\${std.sep}`;
  name = name.replace(new RegExp(`(${s}){2,}`, "g"), std.sep).replace(new RegExp(`^(${s})+|(${s})+$`, "g"), "").replace(ILLEGAL, "_");
  const max = Math.max(10, std.maxLen - ext.length);
  if (name.length > max) name = name.slice(0, max).replace(new RegExp(`(${s})+$`), "");
  return `${name || "DOCUMENT"}${ext}`;
}

/** Names for a set of documents: duplicates get _2, _3 … (case-insensitive). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    if (c === 1) return n;
    const m = n.match(/^(.*?)(\.[^.]*)?$/)!;
    return `${m[1]}_${c}${m[2] ?? ""}`;
  });
}

/** Names for all documents of one part (with {n} counted per document type). */
export function partDocNames(std: NamingStandard, docs: NamingDoc[], p: NamingPart, sub?: string, wrap: { before?: string; after?: string } = {}): string[] {
  const count = new Map<string, number>();
  return uniqueNames(
    docs.map((d) => {
      const k = d.kind + (d.ref ?? "");
      const n = (count.get(k) ?? 0) + 1;
      count.set(k, n);
      return docFileName(std, d, p, { sub, n, ...wrap });
    }),
  );
}
