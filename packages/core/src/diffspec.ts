/**
 * Purchasing comparison export (Parts & BOM → Compare): the columns of the "Purchasing changes" and "All parts" sheets
 * and their order, each column a Python expression per part number, sorted by a Python key.
 * Names: status, mfr, pn, desc, a, b, delta, delta_s ("+2"), notes, label_a, label_b, plus — when the part is in the
 * master list — everything of the part-number rules (General, Spec, PowerIn, series, sku, sub, cat, vendor, price…).
 */
import { partKey, type BomCtx, type RollupDiff } from "./bom.js";
import { evalNode, execCode, parseExpr, pyStr, type PyScope, type PyValue } from "./expr.js";
import { pnScope, type PnCtx } from "./pnformat.js";
import { compareKeys } from "./sortspec.js";
import type { Grid } from "./types.js";

export interface DiffCol {
  /** Header text; {A} / {B} are replaced by the labels of the compared versions. */
  header: string;
  /** Python expression (or code with return). */
  expr: string;
}
export interface DiffSheetSpec {
  cols: DiffCol[];
  /** Python sort key ("" = as compared). */
  sort: string;
  descending: boolean;
}
export interface DiffExportSpec {
  changes: DiffSheetSpec;
  all: DiffSheetSpec;
}
const BASE: DiffCol[] = [
  { header: "STATUS", expr: "status.upper()" },
  { header: "MANUFACTURER", expr: "mfr" },
  { header: "PART NUMBER", expr: "pn" },
  { header: "DESCRIPTION", expr: "desc" },
  { header: "QTY {A}", expr: "a" },
  { header: "QTY {B}", expr: "b" },
  { header: "Δ", expr: "delta_s" },
];
export const DEFAULT_DIFF_SPEC: DiffExportSpec = {
  changes: { cols: [...BASE, { header: "NOTES", expr: '"; ".join(notes)' }], sort: "", descending: false },
  all: { cols: BASE, sort: "", descending: false },
};

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
/** Python names of one compared part number. */
export function diffScope(r: RollupDiff, ctx: BomCtx | undefined, labels: { a: string; b: string }, pn: PnCtx = {}): PyScope {
  let part = undefined as import("./bom.js").Part | undefined;
  for (const p of ctx?.parts.values() ?? []) if (partKey(p.manufacturer, p.partNumber) === r.key) { part = p; break; }
  const sub = part ? ctx?.subcats?.get(part.subcategoryId ?? "")?.name ?? "" : "";
  const base: PyScope = part ? pnScope(part, sub, pn) : { mfr_alias: r.manufacturer, sub: "", nl: "\n" };
  return {
    ...base,
    status: r.status, mfr: r.manufacturer, manufacturer: r.manufacturer, pn: r.partNumber, desc: r.description,
    a: r.a, b: r.b, delta: r.delta, delta_s: (r.delta > 0 ? "+" : "") + fmtNum(r.delta), notes: r.notes,
    label_a: labels.a, label_b: labels.b,
    vendor: part?.vendor ?? "", price: part?.price ?? null, stock: part?.stock ?? null, on_order: part?.onOrder ?? null,
    ext_a: part?.price != null ? part.price * r.a : null, ext_b: part?.price != null ? part.price * r.b : null,
    in_master: !!part,
  };
}
const run = (src: string, sc: PyScope): PyValue => (/\breturn\b|\n/.test(src.trim()) ? execCode(src, sc) : evalNode(parseExpr(src.trim()), sc));
const cellText = (v: PyValue): string => (v == null ? "" : typeof v === "number" ? fmtNum(v) : pyStr(v));

export interface DiffSheetResult {
  grid: Grid;
  errors: string[];
}
/** Build one sheet: rows sorted by the key, one cell per column expression (errors leave the cell empty and are reported once). */
export function diffSheet(rows: RollupDiff[], spec: DiffSheetSpec, ctx: BomCtx | undefined, labels: { a: string; b: string }, pn: PnCtx = {}): DiffSheetResult {
  const errors = new Set<string>();
  const scopes = rows.map((r) => diffScope(r, ctx, labels, pn));
  let order = scopes.map((_s, i) => i);
  if (spec.sort.trim()) {
    const keys = scopes.map((s) => {
      try {
        return { k: run(spec.sort, s), ok: true };
      } catch (e) {
        errors.add(`Sort: ${(e as Error).message}`);
        return { k: null as PyValue, ok: false };
      }
    });
    order = order.sort((x, y) => (keys[x].ok !== keys[y].ok ? (keys[x].ok ? -1 : 1) : (spec.descending ? -1 : 1) * compareKeys(keys[x].k, keys[y].k) || x - y));
  }
  const head = spec.cols.map((c) => c.header.replace(/\{A\}/g, labels.a).replace(/\{B\}/g, labels.b));
  const body = order.map((i) => spec.cols.map((c) => {
    if (!c.expr.trim()) return "";
    try {
      return cellText(run(c.expr, scopes[i]));
    } catch (e) {
      errors.add(`${c.header}: ${(e as Error).message}`);
      return "";
    }
  }));
  return { grid: [head, ...body], errors: [...errors] };
}
