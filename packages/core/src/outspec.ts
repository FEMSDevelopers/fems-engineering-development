/**
 * Customisable output columns (Parts & BOM → Outputs): equipment lists and the purchasing roll-up can show built-in
 * columns plus any field of the master parts list (general, purchasing, mechanical, power, specification values).
 */
import { explode, itemNumbers, unitLabelOf, type BomCtx, type BomLine, type BomNode, type Part, type RollupRow } from "./bom.js";
import type { Grid } from "./types.js";

export interface OutCol {
  key: string;
  /** Header text (default: the column's label). */
  label?: string;
}

const s = (v: unknown) => (v == null ? "" : Array.isArray(v) ? v.filter((x) => x != null && x !== "").join(v.length === 2 && typeof v[0] !== "string" ? "–" : ", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
const num = (v: number | null | undefined) => (v == null ? "" : String(Math.round(v * 1000) / 1000));

/** Fields of the master parts list available as output columns (`part:<key>`, `spec:<key>`). */
export const PART_FIELDS: { key: string; label: string; group: string; get: (p: Part, sub: string) => string }[] = [
  { key: "category", label: "CATEGORY", group: "General", get: (p) => p.category },
  { key: "sub", label: "SUBCATEGORY", group: "General", get: (_p, sub) => sub },
  { key: "manufacturer", label: "MANUFACTURER (MASTER)", group: "General", get: (p) => p.manufacturer },
  { key: "series", label: "PRODUCT SERIES", group: "General", get: (p) => p.series },
  { key: "partNumber", label: "PART NUMBER (MASTER)", group: "General", get: (p) => p.partNumber },
  { key: "description", label: "DESCRIPTION (MASTER)", group: "General", get: (p) => p.description },
  { key: "oemDesc", label: "OEM DESCRIPTION", group: "General", get: (p) => p.oemDesc ?? "" },
  { key: "notes", label: "NOTES", group: "General", get: (p) => p.notes },
  { key: "status", label: "STATUS", group: "General", get: (p) => p.status },
  { key: "tagPrefix", label: "TAG PREFIX", group: "General", get: (p) => p.tagPrefix },
  { key: "sku", label: "SKU", group: "Configuration", get: (p) => p.sku ?? "" },
  { key: "effPn", label: "EFFECTIVE PART NUMBER", group: "Configuration", get: (p) => p.effPn || p.partNumber },
  { key: "effDesc", label: "EFFECTIVE DESCRIPTION", group: "Configuration", get: (p) => p.effDesc || p.description },
  { key: "effPrice", label: "EFFECTIVE PRICE", group: "Configuration", get: (p) => { const v = p.effApply && p.effPrice != null ? p.effPrice : p.price; return v == null ? "" : v.toFixed(2); } },
  { key: "configCode1", label: "CONFIG CODE 1", group: "Configuration", get: (p) => p.configCode1 ?? "" },
  { key: "configCode2", label: "CONFIG CODE 2", group: "Configuration", get: (p) => p.configCode2 ?? "" },
  { key: "configCode3", label: "CONFIG CODE 3", group: "Configuration", get: (p) => p.configCode3 ?? "" },
  { key: "vendor", label: "VENDOR", group: "Purchasing", get: (p) => p.vendor },
  { key: "vendorContact", label: "VENDOR CONTACT", group: "Purchasing", get: (p) => p.vendorContact },
  { key: "price", label: "UNIT PRICE", group: "Purchasing", get: (p) => (p.price == null ? "" : p.price.toFixed(2)) },
  { key: "stock", label: "IN STOCK", group: "Purchasing", get: (p) => num(p.stock) },
  { key: "onOrder", label: "ON ORDER", group: "Purchasing", get: (p) => num(p.onOrder) },
  { key: "mount", label: "MOUNTING", group: "Mechanical", get: (p) => p.mech.mount },
  { key: "rackUnits", label: "RACK U", group: "Mechanical", get: (p) => num(p.mech.rackUnits) },
  { key: "dinWidthMm", label: "DIN WIDTH (MM)", group: "Mechanical", get: (p) => num(p.mech.dinWidthMm) },
  { key: "widthMm", label: "WIDTH (MM)", group: "Mechanical", get: (p) => num(p.mech.widthMm) },
  { key: "heightMm", label: "HEIGHT (MM)", group: "Mechanical", get: (p) => num(p.mech.heightMm) },
  { key: "depthMm", label: "DEPTH (MM)", group: "Mechanical", get: (p) => num(p.mech.depthMm) },
  { key: "weightKg", label: "WEIGHT (KG)", group: "Mechanical", get: (p) => num(p.mech.weightKg) },
  { key: "powerInKind", label: "POWER FEED", group: "Power", get: (p) => p.powerIn?.kind ?? "" },
  { key: "powerInV", label: "INPUT V", group: "Power", get: (p) => num(p.powerIn?.voltage) },
  { key: "powerInRange", label: "INPUT RANGE", group: "Power", get: (p) => p.powerIn?.range ?? "" },
  { key: "powerInW", label: "INPUT W", group: "Power", get: (p) => num(p.powerIn?.watts) },
  { key: "powerInA", label: "INPUT A", group: "Power", get: (p) => num(p.powerIn?.amps) },
  { key: "powerOutV", label: "OUTPUT V", group: "Power", get: (p) => num(p.powerOut?.voltage) },
  { key: "powerOutW", label: "OUTPUT W", group: "Power", get: (p) => num(p.powerOut?.watts) },
  { key: "powerOutA", label: "OUTPUT A", group: "Power", get: (p) => num(p.powerOut?.amps) },
];
const PF = new Map(PART_FIELDS.map((f) => [f.key, f]));

/** Specification fields of every subcategory (union by key) — `spec:<key>` columns. */
export function specFields(ctx?: BomCtx): { key: string; label: string }[] {
  const m = new Map<string, string>();
  for (const sc of ctx?.subcats?.values() ?? []) for (const f of sc.fields) if (!m.has(f.key)) m.set(f.key, `${f.label}${f.unit ? ` (${f.unit})` : ""}`.toUpperCase());
  return [...m].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
}
/** Value of a master-part column (`part:<key>` / `spec:<key>`) for a part; "" when unknown. */
export function partColValue(key: string, p: Part | undefined, ctx?: BomCtx): string {
  if (!p) return "";
  const sub = ctx?.subcats?.get(p.subcategoryId ?? "")?.name ?? "";
  if (key.startsWith("part:")) return PF.get(key.slice(5))?.get(p, sub) ?? "";
  if (key.startsWith("spec:")) return s(p.custom?.[key.slice(5)]);
  return "";
}
export function partColLabel(key: string, ctx?: BomCtx): string {
  if (key.startsWith("part:")) return PF.get(key.slice(5))?.label ?? key;
  if (key.startsWith("spec:")) return specFields(ctx).find((f) => f.key === key.slice(5))?.label ?? key.slice(5).toUpperCase();
  return key;
}

// ───────────────────────── equipment lists ─────────────────────────

export const EQ_BUILTIN: { key: string; label: string }[] = [
  { key: "no", label: "No." },
  { key: "mfr", label: "MANUFACTURER" },
  { key: "pn", label: "PART NUMBER" },
  { key: "desc", label: "DESCRIPTION" },
  { key: "qty", label: "QTY" },
  { key: "prefix", label: "PREFIX" },
  { key: "total", label: "TOTAL" },
  { key: "tags", label: "DEVICE TAGS" },
  { key: "unit", label: "UNIT" },
  { key: "localTags", label: "LOCAL TAGS" },
];
export interface EqListSpec {
  cols: OutCol[];
  /** Group / section rows (sub-headers). Default true. */
  groups?: boolean;
}
export const DEFAULT_EQ_SPEC: EqListSpec = { cols: ["no", "mfr", "pn", "desc", "qty", "prefix", "total", "tags"].map((key) => ({ key })), groups: true };

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
function eqHeader(c: OutCol, u: BomNode, ctx?: BomCtx): string {
  if (c.label) return c.label;
  if (c.key === "qty" && (u.qty || 1) > 1) return `QTY/${u.tags[0]?.replace(/[.\d]+$/, "") || "UNIT"}`;
  return EQ_BUILTIN.find((b) => b.key === c.key)?.label ?? partColLabel(c.key, ctx);
}
function eqCell(c: OutCol, l: BomLine, isSection: boolean, ctx?: BomCtx): string {
  switch (c.key) {
    case "no": return l.itemNo;
    case "mfr": return l.manufacturer;
    case "pn": return l.projectPn ?? l.partNumber;
    case "desc": return l.description;
    case "qty": return isSection || l.line ? "" : fmtQty(l.perUnit);
    case "prefix": return l.prefixCell;
    case "total": return isSection ? "" : fmtQty(l.total);
    case "tags": return (l.kind === "part" ? l.fullTags : []).join(", ");
    case "unit": return l.unit;
    case "localTags": return l.tags.join(", ");
    default: return l.kind === "part" || l.partNumber ? partColValue(c.key, l.partId ? ctx?.parts.get(l.partId) : undefined, ctx) : "";
  }
}
export interface EqGrid {
  name: string;
  title: string;
  grid: Grid;
  /** Row indices of group / section rows (sub-headers). */
  groupRows: number[];
  /** Row indices of rows with full content (a part number). */
  fullRows: number[];
}
/**
 * One equipment list per unit with the chosen columns. TOTAL is only shown for units with several instances unless it
 * was given a label of its own.
 */
export function equipmentLists(units: BomNode[], ctx?: BomCtx, spec: EqListSpec = DEFAULT_EQ_SPEC): EqGrid[] {
  const all = explode(units, ctx);
  return units.map((u) => {
    const multi = (u.qty || 1) > 1;
    const cols = spec.cols.filter((c) => c.key !== "total" || multi || c.label);
    const title = `EQUIPMENT LIST - ${u.tags.length > 1 ? (u.tags[0].replace(/[.\d]+$/, "") || u.name) : u.tags[0] || u.name}`;
    const grid: Grid = [cols.map((c) => eqHeader(c, u, ctx))];
    const groupRows: number[] = [];
    const fullRows: number[] = [];
    for (const l of all.filter((x) => x.unitId === u.id && (!x.line || x.alias))) {
      const isSection = l.kind === "group" && !l.manufacturer && !l.partNumber && !l.tags.length;
      const full = !!(l.projectPn ?? l.partNumber);
      if (l.kind === "group" && spec.groups === false && !full) continue;
      if (l.kind === "group") groupRows.push(grid.length);
      if (full) fullRows.push(grid.length);
      grid.push(cols.map((c) => eqCell(c, l, isSection, ctx)));
    }
    return { name: unitLabelOf(u).slice(0, 31), title, grid, groupRows, fullRows };
  });
}

/** Tab-separated text for the clipboard (pastes as cells in Excel / AutoCAD tables). */
export function toTsv(rows: Grid): string {
  return rows.map((r) => r.map((c) => String(c ?? "").replace(/[\t\r\n]+/g, " ")).join("\t")).join("\r\n");
}
/**
 * Clipboard copies of an equipment list:
 * body — every row (sub-headers included) without the column-header row;
 * full — the column-header row plus only rows with full content (sub-header rows without a part number left out).
 */
export function eqCopyRows(g: EqGrid, mode: "body" | "full"): Grid {
  if (mode === "body") return g.grid.slice(1);
  const keep = new Set(g.fullRows);
  return [g.grid[0], ...g.grid.filter((_r, i) => keep.has(i))];
}

// ───────────────────────── purchasing roll-up ─────────────────────────

export const ROLLUP_BUILTIN: { key: string; label: string; num?: boolean }[] = [
  { key: "vendor", label: "VENDOR" },
  { key: "mfr", label: "MANUFACTURER" },
  { key: "sub", label: "SUBCATEGORY" },
  { key: "category", label: "CATEGORY" },
  { key: "series", label: "PRODUCT SERIES" },
  { key: "pn", label: "PART NUMBER" },
  { key: "desc", label: "DESCRIPTION" },
  { key: "items", label: "BOM ITEMS" },
  { key: "units", label: "(QTY PER UNIT)" },
  { key: "total", label: "TOTAL", num: true },
  { key: "stock", label: "IN STOCK", num: true },
  { key: "onOrder", label: "ON ORDER", num: true },
  { key: "toBuy", label: "TO BUY", num: true },
  { key: "price", label: "UNIT PRICE", num: true },
  { key: "ext", label: "EXT. PRICE", num: true },
];
export interface RollupSortKey {
  key: string;
  desc?: boolean;
}
export interface RollupSpec {
  cols: OutCol[];
  /** python = the Outputs "Sort order" key; keys = the levels below. */
  sortMode: "python" | "keys";
  sort: RollupSortKey[];
}
export const DEFAULT_ROLLUP_SPEC: RollupSpec = {
  cols: ["mfr", "pn", "desc", "units", "total", "stock", "onOrder", "toBuy", "price", "ext"].map((key) => ({ key })),
  sortMode: "python",
  sort: [{ key: "pn" }],
};
export interface RollupExtra {
  /** BOM item numbers per part id. */
  items?: Map<string, string[]>;
}
/** Raw value of a roll-up column for sorting (numbers stay numbers). */
export function rollupValue(key: string, r: RollupRow, ctx?: BomCtx, x: RollupExtra = {}): string | number | null {
  const p = r.partId ? ctx?.parts.get(r.partId) : undefined;
  switch (key) {
    case "vendor": return p?.vendor ?? "";
    case "mfr": return r.manufacturer;
    case "sub": return p ? ctx?.subcats?.get(p.subcategoryId ?? "")?.name ?? "" : "";
    case "category": return p?.category ?? "";
    case "series": return p?.series ?? "";
    case "pn": return r.partNumber;
    case "desc": return r.description;
    case "items": return (r.partId ? x.items?.get(r.partId) ?? [] : []).join(", ");
    case "total": return r.total;
    case "stock": return r.stock;
    case "onOrder": return r.onOrder;
    case "toBuy": return r.toBuy;
    case "price": return r.price;
    case "ext": return r.price == null ? null : r.price * r.total;
    default: return partColValue(key, p, ctx);
  }
}
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
/** One level of a multi-level sort: a column key and its direction. */
export type SortLevel = RollupSortKey;
type SortVal = string | number | null | undefined;
/** A plain decimal number written as text ("12", "-40", "1,250.5") is compared as a number. */
const asNum = (v: SortVal): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/^\u2212/, "-");
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};
/** Compare two values: numbers numerically, text in natural order (A2 < A10), case-insensitive. */
export function compareSortValues(a: SortVal, b: SortVal): number {
  const na = asNum(a);
  const nb = asNum(b);
  if (na != null && nb != null) return na - nb;
  return natural.compare(String(a ?? ""), String(b ?? ""));
}
/**
 * Multi-level sort: each level compares `value(key, row)`; ties go to the next level, then keep the
 * original order (stable). Empty values (null, "") go last whatever the direction.
 */
export function multiSort<T>(rows: T[], levels: SortLevel[], value: (key: string, row: T) => SortVal): T[] {
  if (!levels.length) return rows.slice();
  const idx = new Map(rows.map((r, i) => [r, i]));
  const cache = levels.map(() => new Map<T, SortVal>());
  const val = (li: number, r: T) => {
    const c = cache[li];
    if (!c.has(r)) c.set(r, value(levels[li].key, r));
    return c.get(r);
  };
  return rows.slice().sort((a, b) => {
    for (let li = 0; li < levels.length; li++) {
      const va = val(li, a);
      const vb = val(li, b);
      const ea = va == null || va === "";
      const eb = vb == null || vb === "";
      if (ea || eb) {
        if (ea && eb) continue;
        return ea ? 1 : -1;
      }
      const d = compareSortValues(va, vb);
      if (d) return levels[li].desc ? -d : d;
    }
    return (idx.get(a) ?? 0) - (idx.get(b) ?? 0);
  });
}
/** Multi-level sort of roll-up rows; empty values go last whatever the direction. */
export function sortRollup(rows: RollupRow[], keys: RollupSortKey[], ctx?: BomCtx, x: RollupExtra = {}): RollupRow[] {
  return multiSort(rows, keys, (k, r) => rollupValue(k, r, ctx, x));
}
/** Header of the roll-up with the chosen columns ("units" expands to one column per unit). */
export function rollupGridSpec(rows: RollupRow[], unitLabels: string[], spec: RollupSpec, ctx?: BomCtx, x: RollupExtra = {}): Grid {
  const head: string[] = [];
  for (const c of spec.cols) {
    if (c.key === "units") head.push(...unitLabels);
    else head.push(c.label || (ROLLUP_BUILTIN.find((b) => b.key === c.key)?.label ?? partColLabel(c.key, ctx)));
  }
  const cell = (c: OutCol, r: RollupRow): string[] => {
    if (c.key === "units") return unitLabels.map((u) => (r.byUnit[u] ? fmtQty(r.byUnit[u]) : ""));
    const v = rollupValue(c.key, r, ctx, x);
    if (v == null) return [""];
    if (typeof v === "number") return [c.key === "price" || c.key === "ext" ? v.toFixed(2) : fmtQty(v)];
    return [v];
  };
  return [head, ...rows.map((r) => spec.cols.flatMap((c) => cell(c, r)))];
}
/** BOM item numbers per master part (for the BOM ITEMS column). */
export function itemsByPart(units: BomNode[]): Map<string, string[]> {
  const nos = itemNumbers(units);
  const m = new Map<string, string[]>();
  const rec = (ns: BomNode[]) => ns.forEach((n) => {
    if (n.kind === "part" && n.partId) m.set(n.partId, [...(m.get(n.partId) ?? []), nos.get(n.id) ?? ""].filter(Boolean));
    rec(n.children);
  });
  rec(units);
  return m;
}
