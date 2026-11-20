/**
 * Output order of the part list (purchasing roll-up, documentation package): a Python expression giving a sort key per
 * part line — a value or a tuple / list compared element by element, e.g.  (sub, mfr, pn)  or  [unit, item].
 * Names: everything of the part-number rules (General, Spec, pn, mfr, mfr_alias, sub, …) plus item (BOM item no. / part
 * line), items (all part lines), unit, units, qty, total and stock.
 */
import type { Part } from "./bom.js";
import { PyFloat, evalNode, execCode, parseExpr, type PyScope, type PyValue } from "./expr.js";
import { pnScope, type PnCtx } from "./pnformat.js";

export interface SortFormat {
  /** Python sort key (expression, or code with return). */
  key: string;
  descending: boolean;
}
export const DEFAULT_SORT: SortFormat = { key: "(sub, mfr, pn)", descending: false };

export interface SortRow {
  part?: Part | null;
  sub: string;
  partNumber: string;
  manufacturer: string;
  items: string[];
  units: string[];
  total: number;
}
const num = (v: PyValue): number | null => (typeof v === "number" ? v : v instanceof PyFloat ? v.v : typeof v === "boolean" ? Number(v) : null);
/** Item numbers compare naturally: A2 < A10, A2.1 < A2.10. */
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
export function compareKeys(a: PyValue, b: PyValue): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareKeys(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  const x = num(a);
  const y = num(b);
  if (x != null && y != null) return x - y;
  if (a == null && b != null) return 1;
  if (b == null && a != null) return -1;
  return natural(String(a ?? ""), String(b ?? ""));
}
export function sortScope(r: SortRow, ctx: PnCtx = {}): PyScope {
  const base = r.part ? pnScope(r.part, r.sub, ctx) : { pn: r.partNumber, mfr: r.manufacturer, mfr_alias: r.manufacturer, sub: r.sub, nl: "\n" };
  return { ...base, item: [...r.items].sort(natural)[0] ?? "", items: [...r.items].sort(natural), unit: r.units[0] ?? "", units: r.units, total: r.total, qty: r.total, stock: r.part?.stock ?? 0 };
}
/** Sort rows by the format; rows whose key fails keep their place at the end and the first error is reported. */
export function sortRows<T>(rows: T[], f: SortFormat | null | undefined, toRow: (t: T) => SortRow, ctx: PnCtx = {}): { rows: T[]; error?: string } {
  if (!f?.key.trim()) return { rows };
  let error: string | undefined;
  const src = f.key.trim();
  const keyed = rows.map((t, i) => {
    try {
      const sc = sortScope(toRow(t), ctx);
      const k = /\breturn\b|\n/.test(src) ? execCode(src, sc) : evalNode(parseExpr(src), sc);
      return { t, i, k: k as PyValue, ok: true };
    } catch (e) {
      error ??= (e as Error).message;
      return { t, i, k: null as PyValue, ok: false };
    }
  });
  keyed.sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : (f.descending ? -1 : 1) * compareKeys(a.k, b.k) || a.i - b.i));
  return { rows: keyed.map((x) => x.t), error };
}
