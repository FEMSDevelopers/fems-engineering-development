import { colOrder, headerText, resolveRules, width } from "./condition.js";
import type { BoolFmt, ColumnRules, ConditionState, NameRule, NullFmt } from "./types.js";

/** A reusable collection of column names + rules, applied to future tables column by column. */
export interface RuleSetSnapshot {
  columns: { name: string; rules: ColumnRules }[];
  nameRule: NameRule;
  boolFmt: BoolFmt;
  nullFmt: NullFmt;
}

export function captureRuleSet(st: ConditionState): RuleSetSnapshot {
  const rules = resolveRules(st);
  return {
    columns: colOrder(st).map((j) => ({ name: headerText(st, j), rules: { ...rules[j] } })),
    nameRule: { ...st.nameRule },
    boolFmt: st.opts.boolFmt,
    nullFmt: st.opts.nullFmt,
  };
}

export type MatchKind = "exact" | "suggested" | "none";
export interface ColumnMatch {
  name: string;
  rules: ColumnRules;
  /** Table column index, or -1 to skip. */
  target: number;
  kind: MatchKind;
}

export const normName = (x: string) => String(x).toLowerCase().replace(/[^a-z0-9]/g, "");

/** Match rule-set columns to table columns: exact header text first, then case/punctuation-insensitive. */
export function matchRuleSet(rs: RuleSetSnapshot, st: ConditionState): ColumnMatch[] {
  const heads = Array.from({ length: width(st.grid) }, (_, j) => headerText(st, j));
  const used = new Set<number>();
  return rs.columns.map((c) => {
    let target = heads.findIndex((h, j) => h === c.name && !used.has(j));
    let kind: MatchKind = "exact";
    if (target < 0) {
      const n = normName(c.name);
      target = n ? heads.findIndex((h, j) => normName(h) === n && !used.has(j)) : -1;
      kind = target < 0 ? "none" : "suggested";
    }
    if (target >= 0) used.add(target);
    return { name: c.name, rules: c.rules, target, kind };
  });
}

/** Apply matched rules to a state. Returns a new state. */
export function applyRuleSet(
  st: ConditionState,
  rs: RuleSetSnapshot,
  matches: ColumnMatch[],
  opt: { order: boolean; settings: boolean },
): ConditionState {
  const cond = resolveRules(st);
  for (const m of matches) if (m.target >= 0) cond[m.target] = { ...m.rules, def: m.rules.def ?? "" };
  let order = st.order;
  if (opt.order) {
    const first = matches.filter((m) => m.target >= 0).map((m) => m.target);
    const set = new Set(first);
    order = first.concat(colOrder(st).filter((j) => !set.has(j)));
  }
  const next: ConditionState = { ...st, cond, order };
  if (opt.settings) {
    next.nameRule = { ...rs.nameRule };
    next.opts = { ...st.opts, boolFmt: rs.boolFmt ?? st.opts.boolFmt, nullFmt: rs.nullFmt ?? st.opts.nullFmt };
  }
  return next;
}

export function ruleSummary(r: ColumnRules) {
  const f = [r.na && "NA", r.n && "#", r.q && '"#"', r.tf && "b_tf", r.t10 && "b_10", r.r && "b_r"].filter(Boolean).join(" ");
  return (f || "—") + (r.def ? ` · empty→${r.def}` : "");
}
