import { colName, isBlankRow } from "./grid.js";
import type { ColumnRules, ConditionState, ConvertOptions, Grid, Line, NameRule, Seg, SegKind } from "./types.js";

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

const NUM = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
/** Numeric text that survives a round-trip through a JS number (≤ 15 significant digits). */
export const isNum = (t: string) => NUM.test(t) && t.replace(/[^0-9]/g, "").length <= 15;

export const stripQuotes = (x: string) => x.replace(/["“”]/g, "");

const BOOLF = { lower: ["true", "false"], title: ["True", "False"], upper: ["TRUE", "FALSE"], short: ["t", "f"] } as const;
export const fmtBool = (o: ConvertOptions, b: boolean) => (BOOLF[o.boolFmt] ?? BOOLF.lower)[b ? 0 : 1];
export const fmtNull = (o: ConvertOptions) => (["null", "Null", "NULL", "None"].includes(o.nullFmt) ? o.nullFmt : "null");

/** Matches a cell whose whole value is true/false/null/none (any case), optionally wrapped in quotes. */
export const LITERAL = /^(\s*["“”]?)(true|false|null|none)(["“”]?\s*)$/i;

/** Re-case an exact true/false/null value to the selected literal format, keeping surrounding quotes. */
export function recaseLiteral(o: ConvertOptions, raw: string): string {
  const m = raw.match(LITERAL);
  if (!m) return raw;
  const w = m[2].toLowerCase();
  const word = w === "true" ? fmtBool(o, true) : w === "false" ? fmtBool(o, false) : fmtNull(o);
  return m[1] + word + m[3];
}

/** Plain-conversion type inference (Table → JSON with conditions off). */
export function inferValue(o: ConvertOptions, s: string): unknown {
  if (s === "") return o.empty === "null" ? null : o.empty === "str" ? "" : undefined;
  if (!o.infer) return s;
  const t = s.trim();
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  if (isNum(t)) return Number(t);
  return s;
}

function words(s: string) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
}
function caseSeg(o: ConvertOptions, s: string) {
  if (o.keys === "asis") return s;
  const w = words(s.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  if (!w.length) return s;
  if (o.keys === "snake") return w.map((x) => x.toLowerCase()).join("_");
  return w.map((x, i) => (i ? x[0].toUpperCase() + x.slice(1).toLowerCase() : x.toLowerCase())).join("");
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

export const width = (g: Grid) => g[0]?.length ?? 0;
export const dataRows = (st: ConditionState) => (st.opts.hdr ? st.grid.slice(1) : st.grid);
export const headerText = (st: ConditionState, j: number) => (st.opts.hdr ? String(st.grid[0]?.[j] ?? "") : colName(j));

/** Unique JSON keys for every column, after key-case transform. */
export function headerKeys(st: ConditionState): string[] {
  const w = width(st.grid);
  const seen: Record<string, number> = {};
  return Array.from({ length: w }, (_, j) => {
    let raw = st.opts.hdr ? String(st.grid[0][j] ?? "").trim() : colName(j);
    if (!raw) raw = "column_" + (j + 1);
    let k = st.opts.nest ? raw.split(".").map((x) => caseSeg(st.opts, x)).join(".") : caseSeg(st.opts, raw);
    if (seen[k]) {
      seen[k]++;
      k = k + "_" + seen[k];
    } else seen[k] = 1;
    return k;
  });
}

/** Default rules: quote values unless every value in the column is numeric. */
export function defaultRules(st: ConditionState, j: number): ColumnRules {
  const vals = dataRows(st)
    .map((r) => (r[j] ?? "").trim())
    .filter(Boolean);
  return { na: false, n: false, q: !(vals.length > 0 && vals.every(isNum)), tf: false, t10: false, r: false, def: "" };
}

/** Rules for every column, filling gaps with defaults. Returns a new array. */
export function resolveRules(st: ConditionState): ColumnRules[] {
  return Array.from({ length: width(st.grid) }, (_, j) => {
    const c = st.cond[j];
    return c ? { ...defaultRules(st, j), ...c, def: c.def ?? "" } : defaultRules(st, j);
  });
}

/** Column order as a valid permutation (falls back to table order). */
export function colOrder(st: ConditionState): number[] {
  const w = width(st.grid);
  const o = Array.isArray(st.order) ? st.order : [];
  if (o.length !== w || new Set(o).size !== w || o.some((j) => !(j >= 0 && j < w))) return Array.from({ length: w }, (_, j) => j);
  return o.slice();
}
export const tableOrder = (st: ConditionState) => Array.from({ length: width(st.grid) }, (_, j) => j);
export const renderOrder = (st: ConditionState) => (st.opts.renderOrder === "table" ? tableOrder(st) : colOrder(st));
export const listOrder = (st: ConditionState) => (st.opts.listOrder === "table" ? tableOrder(st) : colOrder(st));

/** Move column `j` to position `toPos` within the rearranged order. Returns the new order. */
export function moveColumn(st: ConditionState, j: number, toPos: number): number[] {
  const o = colOrder(st);
  const from = o.indexOf(j);
  if (from < 0) return o;
  o.splice(from, 1);
  o.splice(Math.max(0, Math.min(o.length, toPos)), 0, j);
  return o;
}

// ---------------------------------------------------------------------------
// Column-conditioned output
// ---------------------------------------------------------------------------

export interface Entry {
  j: number;
  name: string;
  val: string;
  cls: SegKind;
}

/** Apply column rules to one data row. `skipFirst` drops column 0 (used as the key in keyed output). */
export function condEntries(st: ConditionState, row: string[], skipFirst = false, rules = resolveRules(st)): Entry[] {
  const keys = headerKeys(st);
  const nr: NameRule = st.nameRule ?? { n: false, q: true };
  const o = st.opts;
  const out: Entry[] = [];
  for (const j of renderOrder(st)) {
    if (skipFirst && j === 0) continue;
    const cfg = rules[j];
    if (cfg.na) continue;
    const cell = (row[j] ?? "") === "" && cfg.def ? cfg.def : row[j] ?? "";
    const raw0 = cfg.n ? stripQuotes(cell) : cell;
    const t = raw0.trim();
    let val: string;
    let cls: SegKind;
    if (raw0 === "") {
      if (o.empty === "omit") continue;
      if (o.empty === "null") {
        val = fmtNull(o);
        cls = "l";
      } else {
        val = '""';
        cls = "s";
      }
    } else if (cfg.tf && (t === "1" || t === "0")) {
      val = fmtBool(o, (t === "1") !== !!cfg.r);
      cls = "l";
    } else if (cfg.t10 && /^(true|false)$/i.test(t)) {
      val = (t.toLowerCase() === "true") !== !!cfg.r ? "1" : "0";
      cls = "n";
    } else {
      const raw = recaseLiteral(o, raw0);
      if (cfg.q) {
        val = JSON.stringify(raw);
        cls = "s";
      } else {
        val = raw;
        cls = isNum(t) ? "n" : LITERAL.test(t) ? "l" : "u";
      }
    }
    const nm = nr.n ? stripQuotes(keys[j]) : keys[j];
    out.push({ j, name: nr.q ? JSON.stringify(nm) : nm, val, cls });
  }
  return out;
}

/** Format entries as `name: value,` lines. */
export function condLines(ents: Entry[], pad: string): Line[] {
  return ents.map((e, i) => {
    const comma = i < ents.length - 1 ? "," : "";
    const segs: Seg[] = [{ t: "w", v: pad }, { t: "k", v: e.name }, { t: "p", v: ":" }, { t: "w", v: " " }, { t: e.cls, v: e.val }];
    if (comma) segs.push({ t: "p", v: comma });
    return { text: `${pad}${e.name}: ${e.val}${comma}`, segs, col: e.j };
  });
}

// ---------------------------------------------------------------------------
// Highlighting for plain JSON text
// ---------------------------------------------------------------------------

const TOK = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}\[\],])/g;
export function tokenize(line: string): Seg[] {
  const out: Seg[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOK.lastIndex = 0;
  while ((m = TOK.exec(line))) {
    if (m.index > last) out.push({ t: "u", v: line.slice(last, m.index) });
    if (m[1]) {
      if (m[2]) {
        out.push({ t: "k", v: m[1] }, { t: "p", v: m[2] });
      } else out.push({ t: "s", v: m[1] });
    } else if (m[3]) out.push({ t: "l", v: m[3] });
    else if (m[4]) out.push({ t: "n", v: m[4] });
    else out.push({ t: "p", v: m[5] });
    last = TOK.lastIndex;
  }
  if (last < line.length) out.push({ t: "u", v: line.slice(last) });
  return out;
}
export const plainLine = (text: string): Line => ({ text, segs: tokenize(text) });

// ---------------------------------------------------------------------------
// Whole-table rendering
// ---------------------------------------------------------------------------

export const padOf = (o: ConvertOptions) => (o.indent === "tab" ? "\t" : " ".repeat(Number(o.indent)));
const indentOf = (o: ConvertOptions): string | number => (o.indent === "tab" ? "\t" : Number(o.indent));

function rowToObj(st: ConditionState, r: string[], keys: string[], skipFirst: boolean) {
  const o: Record<string, unknown> = {};
  keys.forEach((k, j) => {
    if (skipFirst && j === 0) return;
    const v = inferValue(st.opts, r[j] ?? "");
    if (v === undefined) return;
    if (st.opts.nest && k.includes(".")) {
      const p = k.split(".").filter(Boolean);
      let cur: Record<string, unknown> = o;
      let ok = true;
      for (let i = 0; i < p.length - 1; i++) {
        if (cur[p[i]] === undefined) cur[p[i]] = {};
        else if (typeof cur[p[i]] !== "object" || cur[p[i]] === null) {
          ok = false;
          break;
        }
        cur = cur[p[i]] as Record<string, unknown>;
      }
      if (ok) {
        cur[p[p.length - 1]] = v;
        return;
      }
    }
    o[k] = v;
  });
  return o;
}

export interface RenderedItem {
  /** Key (keyed shape) or undefined. */
  key?: string;
  lines: Line[];
  /** Element text without the trailing comma, unindented. */
  text: string;
  duplicate?: boolean;
}
export interface Rendered {
  open: Line;
  close: Line;
  items: RenderedItem[];
  text: string;
  duplicateKeys: string[];
}

/** Render the whole table (Table → JSON tab). One item per data row. */
export function renderTable(st: ConditionState): Rendered {
  const o = st.opts;
  const pad = padOf(o);
  const keys = headerKeys(st);
  const rows = dataRows(st);
  const keyed = o.shape === "keyed";
  const rules = resolveRules(st);
  const counts: Record<string, number> = {};
  const dupes = new Set<string>();
  const items: RenderedItem[] = rows.map((r, i) => {
    const k = (r[0] ?? "").trim() || `row_${i}`;
    if (keyed) {
      counts[k] = (counts[k] || 0) + 1;
      if (counts[k] > 1) dupes.add(k);
    }
    let lines: Line[];
    if (o.applyCond) {
      const ents = condEntries(st, r, keyed, rules);
      if (o.shape === "arrays") {
        lines = [plainLine(pad + "[" + ents.map((e) => e.val).join(", ") + "]")];
      } else {
        const head = pad + (keyed ? JSON.stringify(k) + ": " : "") + "{";
        lines = [plainLine(head), ...condLines(ents, pad + pad), plainLine(pad + "}")];
      }
    } else {
      const val = o.shape === "arrays" ? r.map((v) => inferValue(o, v) ?? null) : rowToObj(st, r, keys, keyed);
      const txt = ((keyed ? JSON.stringify(k) + ": " : "") + JSON.stringify(val, null, indentOf(o))).split("\n").map((l) => pad + l);
      lines = txt.map(plainLine);
    }
    return { key: keyed ? k : undefined, lines, text: "" };
  });
  items.forEach((it, i) => {
    if (i < items.length - 1) {
      const last = it.lines[it.lines.length - 1];
      it.lines[it.lines.length - 1] = { ...last, text: last.text + ",", segs: [...last.segs, { t: "p", v: "," }] };
    }
    it.text = it.lines.map((l) => l.text.slice(pad.length)).join("\n").replace(/,$/, "");
    if (keyed && it.key && dupes.has(it.key)) it.duplicate = true;
  });
  const open = plainLine(keyed ? "{" : "[");
  const close = plainLine(keyed ? "}" : "]");
  const text = items.length ? [open.text, ...items.flatMap((it) => it.lines.map((l) => l.text)), close.text].join("\n") : open.text + close.text;
  return { open, close, items, text, duplicateKeys: [...dupes] };
}

/** Render one row with column conditions (Column conditions tab). */
export function renderRow(st: ConditionState, rowIndex: number): { lines: Line[]; text: string } {
  const r = dataRows(st)[rowIndex];
  if (!r) return { lines: [plainLine("{}")], text: "{}" };
  const body = condLines(condEntries(st, r), padOf(st.opts));
  const lines = [plainLine("{"), ...body, plainLine("}")];
  return { lines, text: lines.map((l) => l.text).join("\n") };
}

/** Condition every non-blank data row; returns each row as an object-literal block at the given indent. */
export function conditionedBlocks(
  st: ConditionState,
  basePad: string,
  extra?: (rowIndex: number) => Entry[],
): { rowIndex: number; text: string }[] {
  const pad = padOf(st.opts);
  const rules = resolveRules(st);
  const out: { rowIndex: number; text: string }[] = [];
  dataRows(st).forEach((r, i) => {
    if (isBlankRow(r)) return;
    const ents = condEntries(st, r, false, rules).concat(extra ? extra(i) : []);
    const body = condLines(ents, basePad + pad).map((l) => l.text);
    out.push({ rowIndex: i, text: [basePad + "{", ...body, basePad + "}"].join("\n") });
  });
  return out;
}

/** Name formatted per the name rule (used for extra keys such as mqtt_topic). */
export function formatName(st: ConditionState, name: string) {
  const nr = st.nameRule ?? { n: false, q: true };
  const nm = nr.n ? stripQuotes(name) : name;
  return nr.q ? JSON.stringify(nm) : nm;
}
