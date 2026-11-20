/**
 * Part representation rules written in Python (safe subset, see expr.ts) over the fields of a master part:
 *   - Project PN: how a part number is written in bills of material, e.g.  f"{pn} ({sku})" if sku else pn
 *   - Assembly descriptions: the left / right text of a device in mechanical cabinet layouts (the middle is kept for
 *     the device tags of the referenced project BOM), e.g.  f"{mfr_alias}{nl}{pn}"
 * A rule applies to a scope — manufacturer / subcategory / product series, or a Python criteria — never to one part.
 * The most specific matching rule wins: criteria (8) > series (4) > manufacturer (2) > subcategory (1) > "*".
 *
 * Names available to every expression: General, PowerIn, PowerOut, Spec, Config (dicts: General["PartNumber"] or
 * General.PartNumber), and the shorthands pn, mfr, mfr_alias, series, sku, config1, config2, config3, desc, sub, cat, nl.
 * Rules saved by older versions as templates ({General.PartNumber} /nl …) still render; templateToPython converts them.
 */
import type { Part } from "./bom.js";
import { PyDict, evalNode, parseExpr, runCode, truthy, evalExpr, execCode, type PyScope, type PyValue } from "./expr.js";

export interface PnRule {
  /** Subcategory name, or "*" for any subcategory. */
  subcategory: string;
  /** Manufacturer the rule is limited to ("" / absent = any). */
  manufacturer?: string;
  /** Product series the rule is limited to ("" / absent = any), e.g. Siemens 3VA vs 3VJ (FXD) vs QR MCCBs. */
  series?: string;
  /** Python criteria (expression or code with return); the rule applies only to parts where it is true. */
  when?: string;
  /** "python" for every new rule; "template" only for rules saved by older versions. */
  mode: "template" | "python";
  expr: string;
}
export interface PnFormat {
  rules: PnRule[];
}
export const DEFAULT_PN_FORMAT: PnFormat = {
  rules: [
    { subcategory: "*", mode: "python", expr: "pn" },
    { subcategory: "Fuse", mode: "python", expr: "pn" },
    { subcategory: "MCB", mode: "python", expr: 'f"{pn} ({sku})" if sku else pn' },
    { subcategory: "Sensor", mode: "python", expr: "nl.join(x for x in [pn, config1, config2, config3] if x)" },
  ],
};

/** Assembly descriptions shown in mechanical cabinet layouts: left- and right-aligned text per scope. */
export interface AsmDescFormat {
  left: PnRule[];
  right: PnRule[];
}
export const DEFAULT_ASM_DESC: AsmDescFormat = {
  left: [{ subcategory: "*", mode: "python", expr: 'f"{mfr_alias}{nl}{pn}"' }],
  right: [{ subcategory: "*", mode: "python", expr: '""' }],
};

/** Manufacturer → short-hand alias (case-insensitive lookup). */
export type MfrAliases = Record<string, string>;
export const aliasOf = (aliases: MfrAliases | undefined, mfr: string) => {
  if (!aliases || !mfr) return mfr;
  const k = Object.keys(aliases).find((x) => x.trim().toLowerCase() === mfr.trim().toLowerCase());
  return (k && aliases[k]?.trim()) || mfr;
};
export interface PnCtx {
  aliases?: MfrAliases;
}

type Src = Pick<Part, "partNumber" | "manufacturer" | "series" | "description" | "category" | "vendor" | "powerIn" | "powerOut" | "custom"> & Partial<Pick<Part, "sku" | "configCode1" | "configCode2" | "configCode3" | "effPn" | "effDesc" | "effApply">>;

const val = (v: unknown): PyValue => {
  if (v == null) return "";
  if (Array.isArray(v)) return v.length === 2 && (typeof v[0] === "number" || v[0] === null) ? `${v[0] ?? ""}–${v[1] ?? ""}` : (v as unknown[]).map((x) => String(x)).join(", ");
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return String(v);
};
const dict = (o: Record<string, unknown>) => {
  const keys = Object.keys(o);
  const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, "");
  return new PyDict((k) => {
    const hit = keys.find((x) => x === k) ?? keys.find((x) => norm(x) === norm(k));
    return hit == null ? "" : val(o[hit]);
  }, () => keys);
};

/** Field groups of a part as seen by rules (also listed in the editors' field panel). */
export function pnFields(p: Src, sub = "", ctx: PnCtx = {}) {
  const general = {
    partNumber: p.partNumber, manufacturer: p.manufacturer, manufacturerAlias: aliasOf(ctx.aliases, p.manufacturer), series: p.series, description: p.description,
    category: p.category, subcategory: sub, vendor: p.vendor,
  };
  const config = { sku: p.sku ?? "", configCode1: p.configCode1 ?? "", configCode2: p.configCode2 ?? "", configCode3: p.configCode3 ?? "" };
  return {
    general: { ...general, ...config }, config,
    powerIn: (p.powerIn ?? {}) as Record<string, unknown>, powerOut: (p.powerOut ?? {}) as Record<string, unknown>, spec: (p.custom ?? {}) as Record<string, unknown>,
  };
}
/** Shorthand names (python) → description. */
export const PN_SHORTHANDS: [string, string][] = [
  ["pn", "part number"], ["mfr", "manufacturer"], ["mfr_alias", "manufacturer alias (Parts → Manufacturer aliases…; the manufacturer when none)"], ["series", "product series"],
  ["sku", "SKU"], ["config1", "configuration code #1"], ["config2", "configuration code #2"], ["config3", "configuration code #3"], ["desc", "description"],
  ["sub", "subcategory"], ["cat", "category"], ["epn", "effective part number (Configuration; the part number when not applied)"], ["edesc", "effective description (Configuration; the description when not applied)"], ["nl", "new line"],
];

export function pnScope(p: Src, sub = "", ctx: PnCtx = {}): PyScope {
  const f = pnFields(p, sub, ctx);
  return {
    General: dict(f.general), Config: dict(f.config), PowerIn: dict(f.powerIn), PowerOut: dict(f.powerOut), Spec: dict(f.spec),
    pn: p.partNumber, mfr: p.manufacturer, mfr_alias: f.general.manufacturerAlias, series: p.series ?? "", sku: p.sku ?? "",
    config1: p.configCode1 ?? "", config2: p.configCode2 ?? "", config3: p.configCode3 ?? "", desc: p.description ?? "", sub, cat: p.category ?? "",
    epn: p.effPn || p.partNumber, edesc: p.effDesc || p.description || "", nl: "\n",
  };
}

/**
 * Effective part number of a part: its Python expression (or code with return) evaluated over the part's fields; empty
 * expression → the part number. An error (or an empty result) gives the part number, with the error.
 */
export function effectivePn(p: Src & { effPnExpr?: string }, sub = "", ctx: PnCtx = {}): { text: string; error?: string } {
  const src = (p.effPnExpr ?? "").trim();
  if (!src || p.effApply === false) return { text: p.partNumber };
  try {
    const t = runPy(src, { ...pnScope(p, sub, ctx), epn: p.partNumber }).trim();
    return t ? { text: t } : { text: p.partNumber, error: "Empty result: the part number is used" };
  } catch (e) {
    return { text: p.partNumber, error: (e as Error).message };
  }
}

const isCode = (src: string) => /\breturn\b|\n/.test(src.trim());
/** Evaluate Python (expression, or code with return) to text. */
export function runPy(src: string, scope: PyScope): string {
  const s = src.trim();
  return isCode(s) ? runCode(s, scope) : evalExpr(s, scope);
}
/** Evaluate Python criteria to true / false (errors → false, reported separately by checkCriteria). */
export function criteriaTrue(src: string, scope: PyScope): boolean {
  const s = src.trim();
  if (!s) return true;
  try {
    const v = isCode(s) ? execCode(s, scope) : evalNode(parseExpr(s), scope);
    return truthy(v as PyValue);
  } catch {
    return false;
  }
}
export function checkCriteria(src: string, scope: PyScope): { ok: boolean; error?: string } {
  const s = src.trim();
  if (!s) return { ok: true };
  try {
    const v = isCode(s) ? execCode(s, scope) : evalNode(parseExpr(s), scope);
    return { ok: truthy(v as PyValue) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const eq = (a: string | undefined, b: string | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
export interface RuleTarget {
  sub: string;
  mfr?: string;
  series?: string;
  /** The part, for Python criteria. */
  part?: Src;
  ctx?: PnCtx;
}
/** A rule applies to a whole manufacturer / subcategory / product series scope (or criteria), never to one part. */
export function ruleMatches(r: PnRule, t: RuleTarget): boolean {
  if (!(r.subcategory === "*" || !r.subcategory || eq(r.subcategory, t.sub))) return false;
  if (r.manufacturer?.trim() && !eq(r.manufacturer, t.mfr)) return false;
  if (r.series?.trim() && !eq(r.series, t.series)) return false;
  if (r.when?.trim()) return t.part ? criteriaTrue(r.when, pnScope(t.part, t.sub, t.ctx)) : false;
  return true;
}
export const ruleScore = (r: PnRule) => (r.when?.trim() ? 8 : 0) + (r.series?.trim() ? 4 : 0) + (r.manufacturer?.trim() ? 2 : 0) + (r.subcategory && r.subcategory !== "*" ? 1 : 0);
/** Most specific matching rule. Accepts (rules, sub, mfr, series) or (rules, target). */
export function ruleFor(f: PnFormat | PnRule[], sub: string | RuleTarget, mfr = "", series = ""): PnRule | undefined {
  const rules = Array.isArray(f) ? f : f.rules;
  const t: RuleTarget = typeof sub === "string" ? { sub, mfr, series } : sub;
  let best: PnRule | undefined;
  for (const r of rules) if (ruleMatches(r, t) && (!best || ruleScore(r) > ruleScore(best))) best = r;
  return best;
}
export const ruleTargetOf = (p: Src, sub: string, ctx?: PnCtx): RuleTarget => ({ sub, mfr: p.manufacturer, series: p.series, part: p, ctx });
/** Human label of a rule's scope. */
export const ruleScope = (r: PnRule) =>
  [r.manufacturer?.trim() || "", r.subcategory && r.subcategory !== "*" ? r.subcategory : "", r.series?.trim() ? `series ${r.series.trim()}` : "", r.when?.trim() ? `when ${r.when.trim().split("\n")[0].slice(0, 40)}` : ""]
    .filter(Boolean).join(" · ") || "* (all others)";

/** Convert a legacy template ({General.PartNumber} ({SKU}) /nl …) to an equivalent Python expression. */
export function templateToPython(tpl: string): string {
  const name = (path: string) => {
    const p = path.trim();
    const [a, b] = p.includes(".") ? p.split(/\.(.+)/) : ["", p];
    const k = (b ?? "").replace(/\s+/g, "");
    if (!a) {
      const s = k.toLowerCase();
      const short: Record<string, string> = { sku: "sku", partnumber: "pn", manufacturer: "mfr", series: "series", configcode1: "config1", configcode2: "config2", configcode3: "config3", description: "desc" };
      return short[s] ?? `General["${k}"]`;
    }
    const g = ({ general: "General", powerin: "PowerIn", powerout: "PowerOut", spec: "Spec", specification: "Spec" } as Record<string, string>)[a.toLowerCase()] ?? "General";
    if (g === "General") {
      const s = k.toLowerCase();
      const short: Record<string, string> = { partnumber: "pn", manufacturer: "mfr", sku: "sku", series: "series", configcode1: "config1", configcode2: "config2", configcode3: "config3", description: "desc" };
      if (short[s]) return short[s];
    }
    return `${g}["${k}"]`;
  };
  const lines = tpl.split(/\s*\/nl\s*/i).map((l) => l.trim()).filter(Boolean);
  const one = (l: string) => {
    const names = [...l.matchAll(/\{([^{}]+)\}/g)].map((m) => name(m[1]));
    const fs = `f"${l.replace(/"/g, '\\"').replace(/\{([^{}]+)\}/g, (_m, k: string) => `{${name(k)}}`)}"`;
    if (names.length === 1 && l.replace(/\{[^{}]+\}/, "").trim()) return `(${fs} if ${names[0]} else "")`;
    return fs;
  };
  if (lines.length <= 1) {
    const l = lines[0] ?? "";
    const m = l.match(/^(\{[^{}]+\})\s*(.*)$/);
    // "{pn} ({sku})" → f"{pn} ({sku})" if sku else pn
    if (m && m[2]) {
      const rest = [...m[2].matchAll(/\{([^{}]+)\}/g)].map((x) => name(x[1]));
      if (rest.length === 1) return `f"${l.replace(/\{([^{}]+)\}/g, (_x, k: string) => `{${name(k)}}`)}" if ${rest[0]} else ${name(m[1].slice(1, -1))}`;
    }
    return l.match(/^\{[^{}]+\}$/) ? name(l.slice(1, -1)) : one(l);
  }
  return `nl.join(x for x in [${lines.map((l) => (l.match(/^\{[^{}]+\}$/) ? name(l.slice(1, -1)) : one(l))).join(", ")}] if x)`;
}

function renderLegacy(rule: PnRule, p: Src, sub: string, ctx: PnCtx): string {
  const f = pnFields(p, sub, ctx);
  const look = (path: string): string => {
    const [a, b] = path.includes(".") ? path.split(/\.(.+)/) : ["", path];
    const groups: Record<string, Record<string, unknown>> = { general: f.general, powerin: f.powerIn, powerout: f.powerOut, spec: f.spec, specification: f.spec };
    const pick = (o: Record<string, unknown>, k: string) => {
      const hit = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase().replace(/\s+/g, ""));
      return hit == null ? undefined : o[hit];
    };
    if (a) return String(val(pick(groups[a.toLowerCase()] ?? {}, b)));
    return String(val(pick(f.general, b) ?? pick(f.spec, b) ?? pick(f.powerIn, b)));
  };
  const lines = rule.expr.split(/\s*\/nl\s*/i).map((line) => {
    let any = false;
    let filled = false;
    const out = line.replace(/\{([^{}]+)\}/g, (_m, k: string) => {
      any = true;
      const v = look(k.trim());
      if (v) filled = true;
      return v;
    });
    if (any && !filled) return "";
    return out.replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s{2,}/g, " ").replace(/[\s,;/-]+$/, "").trim();
  });
  return lines.filter(Boolean).join("\n");
}

/** Render one rule for a part. Errors come back as { error } with the fallback text. */
export function renderPn(rule: PnRule | undefined, p: Src, sub = "", ctx: PnCtx = {}, fallback: string = p.partNumber): { text: string; error?: string } {
  if (!rule || !rule.expr.trim()) return { text: fallback };
  try {
    if (rule.mode === "template") return { text: renderLegacy(rule, p, sub, ctx) || fallback };
    const out = runPy(rule.expr, pnScope(p, sub, ctx));
    return { text: out.replace(/\s*\/nl\s*/gi, "\n").trim() || fallback };
  } catch (e) {
    return { text: fallback, error: (e as Error).message };
  }
}

/** Part-number formatter for BOM outputs (subcategory name looked up by the caller). */
export function pnFormatter(f: PnFormat | null | undefined, subName: (p: Part) => string, ctx: PnCtx = {}) {
  if (!f) return undefined;
  return (p: Part) => {
    const sub = subName(p);
    return renderPn(ruleFor(f, ruleTargetOf(p, sub, ctx)), p, sub, ctx).text;
  };
}

/** Left / right description of a device in cabinet layouts. */
export function asmDescOf(f: AsmDescFormat | null | undefined, p: Src, sub: string, ctx: PnCtx = {}): { left: string; right: string } {
  const fmt = f ?? DEFAULT_ASM_DESC;
  const t = ruleTargetOf(p, sub, ctx);
  return {
    left: renderPn(ruleFor(fmt.left ?? [], t), p, sub, ctx, "").text,
    right: renderPn(ruleFor(fmt.right ?? [], t), p, sub, ctx, "").text,
  };
}

/** Effective description: the Python expression of the part (custom PN / DESC applied), else the description. */
export function effectiveDesc(p: Src & { effDescExpr?: string }, sub = "", ctx: PnCtx = {}): { text: string; error?: string } {
  const src = (p.effDescExpr ?? "").trim();
  const desc = p.description ?? "";
  if (!src || p.effApply === false) return { text: desc };
  try {
    const t = runPy(src, { ...pnScope(p, sub, ctx), edesc: desc }).trim();
    return t ? { text: t } : { text: desc, error: "Empty result: the description is used" };
  } catch (e) {
    return { text: desc, error: (e as Error).message };
  }
}
/** Effective price: the custom configuration's price when applied and set, else the unit price. */
export const effectivePrice = (p: Pick<Part, "price"> & Partial<Pick<Part, "effPrice" | "effApply">>): number | null => (p.effApply && p.effPrice != null ? p.effPrice : p.price ?? null);
