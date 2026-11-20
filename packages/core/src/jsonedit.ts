/**
 * JSON editor: raw sources (JSON documents and lookup tables), structure scan, array selection and
 * element conditioning with the point list builder's rules (incl. Expression / Python code).
 */
import { loadLibrary, PyDict, PyError, PyFloat, PyFunc, PyMap, pyStr, type PyValue } from "./expr.js";
import { applyRule, type PlCtx, type PlRule } from "./plbuilder.js";
import type { Ver } from "./version.js";

// ---------------------------------------------------------------- sources

export type JsColType = "text" | "integer" | "number" | "boolean" | "date" | "time" | "datetime";
/** Column types (JSON Schema / ISO 8601 conventions). */
export const JS_COL_TYPES: [JsColType, string, string][] = [
  ["text", "Text", "Any characters"],
  ["integer", "Integer", "Whole number, e.g. 42, -7"],
  ["number", "Number", "Decimal number with a dot, e.g. 3.14, 1e-3"],
  ["boolean", "Boolean", "true / false (also yes/no, 1/0)"],
  ["date", "Date", "ISO 8601 YYYY-MM-DD, e.g. 2026-10-22"],
  ["time", "Time", "ISO 8601 HH:MM or HH:MM:SS, e.g. 14:05:30"],
  ["datetime", "Date-time", "ISO 8601 YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM], e.g. 2026-10-22T14:05:30Z"],
];
export interface JsTableCol {
  name: string;
  type: JsColType;
}
export interface JsSource {
  kind: "json" | "table";
  name: string;
  /** JSON text (kind json). */
  text?: string;
  /** Lookup table (kind table). */
  columns?: JsTableCol[];
  rows?: string[][];
}
export interface JsTableData {
  columns: JsTableCol[];
  rows: string[][];
}

const BOOL_T = ["true", "yes", "y", "1", "on"];
const BOOL_F = ["false", "no", "n", "0", "off"];
/** Validation message for a cell, or null when valid (empty cells are valid). */
export function checkCell(type: JsColType, v: string): string | null {
  const t = v.trim();
  if (!t || type === "text") return null;
  switch (type) {
    case "integer": return /^[+-]?\d+$/.test(t) ? null : "not an integer (e.g. 42)";
    case "number": return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) ? null : "not a number (e.g. 3.14)";
    case "boolean": return [...BOOL_T, ...BOOL_F].includes(t.toLowerCase()) ? null : "not true/false";
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
      if (!m) return "not a date (YYYY-MM-DD)";
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? null : "no such date";
    }
    case "time": return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?$/.test(t) ? null : "not a time (HH:MM[:SS])";
    case "datetime": return /^\d{4}-\d{2}-\d{2}[T ]([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(t) && checkCell("date", t.slice(0, 10)) === null ? null : "not a date-time (YYYY-MM-DDTHH:MM[:SS])";
  }
  return null;
}
/** Cell text → Python value by column type (empty → None). */
export function typedCell(type: JsColType, v: string): PyValue {
  const t = (v ?? "").trim();
  if (!t) return null;
  if (checkCell(type, t)) return t;
  if (type === "integer") return parseInt(t, 10);
  if (type === "number") return new PyFloat(Number(t));
  if (type === "boolean") return BOOL_T.includes(t.toLowerCase());
  return t;
}
/** Guess column types from pasted rows: the first type that at least 3 of 4 values satisfy (the rest are then flagged). */
export function guessColType(values: string[]): JsColType {
  const vs = values.map((v) => v.trim()).filter(Boolean);
  if (!vs.length) return "text";
  for (const t of ["integer", "number", "date", "datetime", "time", "boolean"] as JsColType[]) {
    const ok = vs.filter((v) => checkCell(t, v) === null).length;
    if (ok === vs.length || (vs.length >= 4 && ok / vs.length >= 0.75)) return t;
  }
  return "text";
}
export function tableIssues(t: JsTableData): { row: number; col: number; msg: string }[] {
  const out: { row: number; col: number; msg: string }[] = [];
  t.rows.forEach((r, i) => t.columns.forEach((c, j) => {
    const m = checkCell(c.type, r[j] ?? "");
    if (m) out.push({ row: i, col: j, msg: `${c.name}: "${r[j]}" ${m}` });
  }));
  const names = t.columns.map((c) => c.name.trim().toLowerCase());
  names.forEach((n, j) => {
    if (!n) out.push({ row: -1, col: j, msg: `Column ${j + 1} has no name` });
    else if (names.indexOf(n) !== j) out.push({ row: -1, col: j, msg: `Duplicate column name "${t.columns[j].name}"` });
  });
  return out;
}

/** Position of the first JSON syntax error (a small scanner; JSON.parse does the actual parsing). */
function jsonErrorAt(t: string): { pos: number; msg: string } {
  let i = 0;
  const ws = () => {
    while (i < t.length && " \t\r\n".includes(t[i])) i++;
  };
  const fail = (msg: string): never => {
    throw { pos: i, msg };
  };
  const value = (): void => {
    ws();
    const c = t[i];
    if (c === "{") {
      i++;
      ws();
      if (t[i] === "}") return void i++;
      for (;;) {
        ws();
        if (t[i] !== '"') fail(t[i] === "'" ? "keys and text need double quotes, not single quotes" : `expected a "key" but found ${t[i] ? `'${t[i]}'` : "the end"}`);
        str();
        ws();
        if (t[i] !== ":") fail(`expected ':' after the key`);
        i++;
        value();
        ws();
        if (t[i] === ",") {
          i++;
          ws();
          if (t[i] === "}") fail("trailing comma before '}'");
          continue;
        }
        if (t[i] === "}") return void i++;
        fail(`expected ',' or '}' but found ${t[i] ? `'${t[i]}'` : "the end"}`);
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (t[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (t[i] === ",") {
          i++;
          ws();
          if (t[i] === "]") fail("trailing comma before ']'");
          continue;
        }
        if (t[i] === "]") return void i++;
        fail(`expected ',' or ']' but found ${t[i] ? `'${t[i]}'` : "the end"}`);
      }
    }
    if (c === '"') return str();
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?|^true|^false|^null/.exec(t.slice(i));
    if (!m) fail(c ? `unexpected '${c}'${c === "'" ? " (JSON needs double quotes)" : ""}` : "unexpected end of JSON");
    i += m![0].length;
  };
  const str = () => {
    i++;
    while (i < t.length && t[i] !== '"') {
      if (t[i] === "\\") i++;
      else if (t[i] === "\n") fail("line break inside a string");
      i++;
    }
    if (i >= t.length) fail("unterminated string");
    i++;
  };
  try {
    value();
    ws();
    if (i < t.length) fail(`unexpected '${t[i]}' after the end of the JSON`);
  } catch (e) {
    if (e && typeof e === "object" && "pos" in e) return e as { pos: number; msg: string };
    throw e;
  }
  return { pos: -1, msg: "" };
}
/** Parse JSON with a readable error (line:column). */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const at = jsonErrorAt(text);
    if (at.pos < 0) return { ok: false, error: (e as Error).message };
    const before = text.slice(0, at.pos);
    const line = before.split("\n").length;
    const col = at.pos - before.lastIndexOf("\n");
    return { ok: false, error: `${at.msg[0].toUpperCase()}${at.msg.slice(1)} at line ${line}, column ${col}` };
  }
}

// ---------------------------------------------------------------- structure

const ident = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
export const childPath = (p: string, k: string) => (ident(k) ? `${p}.${k}` : `${p}[${JSON.stringify(k)}]`);
const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

export interface JsNode {
  /** Pattern path, e.g. $.devices[*].points ([*] = every element). */
  path: string;
  kind: "array" | "object";
  depth: number;
  /** Last segment, for display. */
  label: string;
  parent: string | null;
  /** How many places this path occurs (e.g. one points array per device). */
  instances: number;
  /** Arrays: total elements over all instances. Objects: distinct keys. */
  count: number;
  min: number;
  max: number;
  /** Kinds of the array elements, e.g. { object: 48 }. */
  itemKinds: Record<string, number>;
}

/** Every array and object in a document, depth first. */
export function scanJson(root: unknown): JsNode[] {
  const map = new Map<string, JsNode & { keys?: Set<string> }>();
  const order: string[] = [];
  const visit = (v: unknown, path: string, depth: number, parent: string | null, label: string) => {
    if (v === null || typeof v !== "object") return;
    let n = map.get(path);
    if (!n) {
      n = { path, kind: Array.isArray(v) ? "array" : "object", depth, label, parent, instances: 0, count: 0, min: Infinity, max: 0, itemKinds: {}, keys: new Set() };
      map.set(path, n);
      order.push(path);
    }
    n.instances++;
    if (Array.isArray(v)) {
      n.count += v.length;
      n.min = Math.min(n.min, v.length);
      n.max = Math.max(n.max, v.length);
      for (const x of v) n.itemKinds[kindOf(x)] = (n.itemKinds[kindOf(x)] ?? 0) + 1;
      for (const x of v) visit(x, `${path}[*]`, depth + 1, path, "[*]");
    } else {
      const ks = Object.keys(v as object);
      ks.forEach((k) => n!.keys!.add(k));
      n.min = Math.min(n.min, ks.length);
      n.max = Math.max(n.max, ks.length);
      for (const k of ks) visit((v as Record<string, unknown>)[k], childPath(path, k), depth + 1, path, k);
    }
  };
  visit(root, "$", 0, null, "$");
  return order.map((p) => {
    const { keys, ...n } = map.get(p)!;
    if (n.kind === "object") n.count = keys!.size;
    if (n.min === Infinity) n.min = 0;
    return n;
  });
}

type Seg = { k: "key"; v: string } | { k: "all" } | { k: "idx"; v: number };
/** "$.a.b[*][\"x y\"][3]" → segments. */
export function parsePath(path: string): Seg[] {
  const out: Seg[] = [];
  const re = /\.([A-Za-z_][A-Za-z0-9_]*)|\[\*\]|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]|^\$/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(path))) {
    if (m.index !== last) throw new Error(`Invalid path near "${path.slice(last)}"`);
    last = re.lastIndex;
    if (m[0] === "$") continue;
    if (m[0] === "[*]") out.push({ k: "all" });
    else if (m[1] !== undefined) out.push({ k: "key", v: m[1] });
    else if (m[2] !== undefined) out.push({ k: "idx", v: Number(m[2]) });
    else out.push({ k: "key", v: JSON.parse(m[3]) });
    if (m[0] === "") re.lastIndex++;
  }
  if (last !== path.length) throw new Error(`Invalid path near "${path.slice(last)}"`);
  return out;
}

export interface JsElem {
  value: unknown;
  /** Concrete path, e.g. $.devices[3].points[7]. */
  ptr: string;
  /** Index within its own array. */
  index: number;
  /** Enclosing containers from the root down to (not including) the element. */
  ancestors: unknown[];
  /** Nearest enclosing object (e.g. the device that holds the points array), or null. */
  parent: Record<string, unknown> | null;
}

/** Elements of every array matched by a pattern path (the selected array). */
export function arrayElements(root: unknown, path: string): JsElem[] {
  let cur: { v: unknown; ptr: string; anc: unknown[] }[] = [{ v: root, ptr: "$", anc: [] }];
  for (const s of parsePath(path)) {
    const next: typeof cur = [];
    for (const c of cur) {
      if (s.k === "all") {
        if (Array.isArray(c.v)) c.v.forEach((x, i) => next.push({ v: x, ptr: `${c.ptr}[${i}]`, anc: [...c.anc, c.v] }));
      } else if (s.k === "idx") {
        if (Array.isArray(c.v) && s.v < c.v.length) next.push({ v: c.v[s.v], ptr: `${c.ptr}[${s.v}]`, anc: [...c.anc, c.v] });
      } else if (c.v && typeof c.v === "object" && !Array.isArray(c.v) && s.v in (c.v as object)) {
        next.push({ v: (c.v as Record<string, unknown>)[s.v], ptr: childPath(c.ptr, s.v), anc: [...c.anc, c.v] });
      }
    }
    cur = next;
  }
  const out: JsElem[] = [];
  for (const c of cur) {
    if (!Array.isArray(c.v)) continue;
    const anc = [...c.anc, c.v];
    const parent = [...anc].reverse().find((a) => a && typeof a === "object" && !Array.isArray(a)) as Record<string, unknown> | undefined;
    c.v.forEach((x, i) => out.push({ value: x, ptr: `${c.ptr}[${i}]`, index: i, ancestors: anc, parent: parent ?? null }));
  }
  return out;
}

export interface JsKey {
  /** Path within the element: name, meta.bay, tags (arrays are not expanded). "" = the element itself. */
  path: string;
  count: number;
  kinds: Record<string, number>;
  samples: string[];
}
export const shortJson = (v: unknown, max = 40): string => {
  if (v === undefined) return "(missing)";
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).length} keys}`;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
};
/** Every repeated element title (leaf path) of the selected array, with coverage and samples. */
export function elementKeys(elems: JsElem[]): JsKey[] {
  const m = new Map<string, JsKey>();
  const add = (path: string, v: unknown) => {
    const k = m.get(path) ?? { path, count: 0, kinds: {}, samples: [] };
    k.count++;
    k.kinds[kindOf(v)] = (k.kinds[kindOf(v)] ?? 0) + 1;
    const s = shortJson(v);
    if (k.samples.length < 3 && !k.samples.includes(s)) k.samples.push(s);
    m.set(path, k);
  };
  const walk = (v: unknown, path: string) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, path ? (ident(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`) : ident(k) ? k : `[${JSON.stringify(k)}]`);
    } else add(path, v);
  };
  for (const e of elems) walk(e.value, "");
  return [...m.values()];
}

/** Read a path inside a value: "meta.bay", "tags[0]", '["odd key"]'. */
export function getIn(v: unknown, path: string): unknown {
  if (!path) return v;
  let cur = v;
  for (const s of parsePath(path.startsWith("$") ? path : path.startsWith("[") ? "$" + path : "$." + path)) {
    if (cur == null || typeof cur !== "object") return undefined;
    if (s.k === "key") cur = Array.isArray(cur) ? undefined : (cur as Record<string, unknown>)[s.v];
    else if (s.k === "idx") cur = Array.isArray(cur) ? cur[s.v] : undefined;
    else return undefined;
  }
  return cur;
}
/** Write a path inside an object (creates missing objects). */
export function setIn(obj: unknown, path: string, value: unknown): boolean {
  const segs = parsePath(path.startsWith("[") ? "$" + path : "$." + path);
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const last = i === segs.length - 1;
    if (s.k === "all" || cur == null || typeof cur !== "object") return false;
    const key = s.k === "idx" ? s.v : s.v;
    if (last) {
      (cur as Record<string | number, unknown>)[key] = value;
      return true;
    }
    let nx = (cur as Record<string | number, unknown>)[key];
    if (nx == null || typeof nx !== "object") {
      nx = {};
      (cur as Record<string | number, unknown>)[key] = nx;
    }
    cur = nx as Record<string, unknown>;
  }
  return false;
}

// ---------------------------------------------------------------- Python bridge

export function toPy(v: unknown): PyValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isInteger(v) ? v : new PyFloat(v);
  if (Array.isArray(v)) return v.map(toPy);
  return new PyMap(Object.entries(v as object).map(([k, x]) => [k, toPy(x)]));
}
export function fromPy(v: PyValue): unknown {
  if (v instanceof PyFloat) return v.v;
  if (Array.isArray(v)) return v.map(fromPy);
  if (v instanceof PyMap) return Object.fromEntries([...v.m.entries()].map(([k, x]) => [String(k), fromPy(x)]));
  if (v instanceof PyDict) return Object.fromEntries(v.keys().map((k) => [k, fromPy(v.get(k) ?? null)]));
  if (v instanceof PyFunc) return null;
  return v;
}
const cellText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));

/** lookup / lookup_row / rows / to_json / from_json functions over the loaded lookup tables. */
export function lookupFns(tables: Record<string, JsTableData>): Record<string, PyValue> {
  const tab = (name: PyValue) => {
    const n = pyStr(name ?? "");
    const t = tables[n] ?? Object.entries(tables).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
    if (!t) throw new PyError(`lookup table '${n}' is not loaded — add it under Lookup tables (loaded: ${Object.keys(tables).join(", ") || "none"})`);
    return t;
  };
  const colIdx = (t: JsTableData, c: PyValue) => {
    const n = pyStr(c ?? "").trim().toLowerCase();
    const j = t.columns.findIndex((x) => x.name.trim().toLowerCase() === n);
    if (j < 0) throw new PyError(`column '${pyStr(c ?? "")}' not in the table (columns: ${t.columns.map((x) => x.name).join(", ")})`);
    return j;
  };
  const rowDict = (t: JsTableData, r: string[]) => new PyMap(t.columns.map((c, j) => [c.name, typedCell(c.type, r[j] ?? "")]));
  const find = (t: JsTableData, j: number, v: PyValue) => {
    const key = pyStr(v ?? "").trim().toLowerCase();
    return t.rows.find((r) => (r[j] ?? "").trim().toLowerCase() === key);
  };
  return {
    /** lookup(table, match_column, value, return_column, default=None) — VLOOKUP, exact match (case-insensitive). */
    lookup: new PyFunc("lookup", ([t0, mc, v, rc, d], kw) => {
      const t = tab(t0);
      const r = find(t, colIdx(t, mc), v ?? null);
      if (!r) return d ?? kw?.default ?? null;
      const j = colIdx(t, rc);
      return typedCell(t.columns[j].type, r[j] ?? "");
    }),
    /** lookup_row(table, match_column, value) — the whole matching row as a dict (left join), None if no match. */
    lookup_row: new PyFunc("lookup_row", ([t0, mc, v]) => {
      const t = tab(t0);
      const r = find(t, colIdx(t, mc), v ?? null);
      return r ? rowDict(t, r) : null;
    }),
    /** rows(table) — every row as a dict. */
    rows: new PyFunc("rows", ([t0]) => {
      const t = tab(t0);
      return t.rows.map((r) => rowDict(t, r));
    }),
    to_json: new PyFunc("to_json", ([v]) => JSON.stringify(fromPy(v ?? null))),
    from_json: new PyFunc("from_json", ([v]) => {
      try {
        return toPy(JSON.parse(pyStr(v ?? "")));
      } catch (e) {
        throw new PyError(`from_json: ${(e as Error).message}`);
      }
    }),
  };
}

// ---------------------------------------------------------------- conditioning

export type JsOutType = "auto" | "text" | "number" | "integer" | "boolean" | "json";
export const JS_OUT_TYPES: [JsOutType, string][] = [["auto", "Auto (keep the original type)"], ["text", "Text"], ["number", "Number"], ["integer", "Integer"], ["boolean", "Boolean"], ["json", "JSON (object / array text)"]];
export interface JsField {
  id: string;
  /** Element key written (existing or new; dotted paths create nested objects). */
  target: string;
  /** Element key the value starts from ("" = empty). parent.x / root.x read outside the element. */
  source: string;
  rules: PlRule[];
  out: JsOutType;
  off?: boolean;
}
export interface JsLookupRef {
  /** Name used in lookup("alias", …). */
  alias: string;
  sourceId: string | null;
  ver: Ver | null;
}
export interface JsCond {
  fields: JsField[];
  lookups: JsLookupRef[];
  /** Function libraries available to Expression / Python code rules. */
  libs?: JsLibRef[];
}
/** A function library used by a conditioning: a saved library (null version = latest), or "draft" = the Functions tab. */
export interface JsLibRef {
  id: string;
  ver: Ver | null;
}
export const emptyCond = (): JsCond => ({ fields: [], lookups: [] });

export interface JsElemResult {
  ptr: string;
  index: number;
  /** Per target: value before, value written (null if unchanged/failed) and warnings. */
  fields: Record<string, { before: unknown; after: unknown; text: string; warn: string[] }>;
  changed: boolean;
}
export interface JsCondResult {
  out: unknown;
  elems: JsElemResult[];
  changed: number;
  warnings: number;
}

function convertOut(text: string, type: JsOutType, before: unknown, warn: (m: string) => void): unknown {
  const t = text.trim();
  const asNum = () => {
    const n = Number(t);
    if (!t || !Number.isFinite(n)) {
      warn(`"${text}" is not a number — written as text`);
      return text;
    }
    return n;
  };
  switch (type) {
    case "text": return text;
    case "number": return asNum();
    case "integer": {
      const n = asNum();
      return typeof n === "number" ? Math.trunc(n) : n;
    }
    case "boolean": return BOOL_T.includes(t.toLowerCase()) || t === "True" ? true : BOOL_F.includes(t.toLowerCase()) || t === "False" ? false : (warn(`"${text}" is not true/false — written as text`), text);
    case "json": {
      try {
        return JSON.parse(t);
      } catch {
        warn(`not valid JSON — written as text (use to_json(…) in an expression)`);
        return text;
      }
    }
  }
  // auto: keep the type of the existing value
  if (typeof before === "number" && t && Number.isFinite(Number(t))) return Number(t);
  if (typeof before === "boolean" && /^(true|false)$/i.test(t)) return /^true$/i.test(t);
  if (before && typeof before === "object") {
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Condition the elements of the selected array. Each field starts from an element key, runs its rule chain
 * (all point-list rules, Expression and Python code with el, parent, root, index, lookup, lookup_row, rows)
 * and writes the result to its target key. Returns the new document and per-element results.
 */
export function runCond(
  root: unknown, path: string, cond: JsCond, tables: Record<string, JsTableData>,
  opts: { only?: number[]; limit?: number; dry?: boolean; log?: (ptr: string, s: string) => void; libs?: string[] } = {},
): JsCondResult {
  // dry: preview only — no copy of the document, nothing written
  const out = opts.dry ? root : structuredClone(root);
  const elems = arrayElements(out, path);
  const fns = lookupFns(tables);
  // Function libraries see lookup(), rows()… and each other (in order).
  let libNames: Record<string, PyValue> = {};
  for (const code of opts.libs ?? []) {
    const L = loadLibrary(code, { ...fns, ...libNames });
    libNames = { ...libNames, ...L.names };
  }
  const rootObj = root && typeof root === "object" && !Array.isArray(root) ? (root as Record<string, unknown>) : null;
  const pyRoot: PyValue = rootObj ? new PyDict((k) => (k in rootObj ? toPy(rootObj[k]) : undefined), () => Object.keys(rootObj)) : toPy(root);
  const res: JsElemResult[] = [];
  let changed = 0;
  let warnings = 0;
  const fields = cond.fields.filter((f) => !f.off && f.target.trim());
  elems.forEach((e, n) => {
    if (opts.only && !opts.only.includes(n)) return;
    if (opts.limit != null && res.length >= opts.limit) return;
    const orig = structuredClone(e.value);
    const r: JsElemResult = { ptr: e.ptr, index: e.index, fields: {}, changed: false };
    const outVals: Record<string, string> = {};
    const read = (p: string): unknown => {
      const t = p.trim();
      if (t === "" || t === "value") return orig;
      if (t.startsWith("parent.") || t === "parent") return getIn(e.parent, t.replace(/^parent\.?/, ""));
      if (t.startsWith("root.") || t.startsWith("$")) return getIn(root, t.replace(/^root\.?/, "$."));
      return getIn(orig, t);
    };
    const extra: Record<string, PyValue> = {
      ...fns,
      ...libNames,
      el: toPy(orig),
      parent: toPy(e.parent),
      root: pyRoot,
      index: e.index,
      path: e.ptr,
      ...(opts.log ? { __log: new PyFunc("print", (a) => (opts.log!(e.ptr, a.map(pyStr).join(" ")), null)) } : {}),
    };
    for (const f of fields) {
      const warn: string[] = [];
      const x: PlCtx = {
        n: n + 1,
        row: e.index,
        col: (h) => cellText(read(h)),
        out: outVals,
        warn: (m) => warn.push(m),
        outName: (nm) => outVals[nm],
        extra,
        immediate: true,
      };
      let s = f.source ? cellText(read(f.source)) : "";
      if (f.source && read(f.source) === undefined) warn.push(`Key "${f.source}" not found in this element`);
      for (const rule of f.rules) s = applyRule(s, rule, x, 1);
      outVals[f.target] = s;
      const before = getIn(orig, f.target);
      const value = convertOut(s, f.out, before, (m) => warn.push(m));
      if (opts.dry) {
        /* preview */
      } else if (e.value && typeof e.value === "object" && !Array.isArray(e.value)) setIn(e.value, f.target, value);
      else warn.push("The element is not an object — select an array of objects to write keys");
      r.fields[f.target] = { before, after: value, text: s, warn };
      if (JSON.stringify(before) !== JSON.stringify(value)) r.changed = true;
      warnings += warn.length;
    }
    if (r.changed) changed++;
    res.push(r);
  });
  return { out, elems: res, changed, warnings };
}

/** Names offered by the expression popup for an array: element keys, parent keys, functions. */
export function condPalette(elems: JsElem[]): { element: JsKey[]; parent: JsKey[] } {
  const parents = elems.map((e) => e.parent).filter((p, i, a) => p && a.indexOf(p) === i) as Record<string, unknown>[];
  return {
    element: elementKeys(elems),
    parent: elementKeys(parents.map((p, i) => ({ value: p, ptr: "", index: i, ancestors: [], parent: null }))),
  };
}

// ---------------------------------------------------------------- instances

/** Output embedded in an instance by release r23/r24 (now stored as conditioning sets of the instance). */
export interface JsOutputDef {
  id: string;
  name: string;
  /** Array path, e.g. $.devices[*].points */
  path: string;
  cond: JsCond;
}
/**
 * A JSON editor instance: one source document, versioned as a whole. Its conditioning sets are saved
 * separately (linked to the instance); each set's output is computed on this document.
 */
export interface JsInstance {
  source: { name: string; text: string };
  /** Pre-r25 instances only: outputs embedded in the instance (converted to conditioning sets on open). */
  outputs?: JsOutputDef[];
  current?: string;
}
export const emptyInstance = (): JsInstance => ({ source: { name: "", text: "" } });
/** Version metadata shown in lists (source name, size). */
export function instanceMeta(i: JsInstance): Record<string, unknown> {
  const kb = Math.round(((i.source?.text ?? "").length / 1024) * 10) / 10;
  return { source: i.source?.name ?? "", kb, rows: kb, cols: 1 };
}
/** Embedded (pre-r25) outputs worth converting: those with rules or an array. */
export const legacyOutputs = (i: JsInstance | null | undefined): JsOutputDef[] => (i?.outputs ?? []).filter((o) => o.cond?.fields?.length || o.path);
