/**
 * A small, safe evaluator for Python expressions (no eval, no imports, no statements) used by the
 * point list builder's Expression rule. Supported:
 *   literals   'text' "text" f"…{expr:spec}…" 12 3.5 True False None [a, b]
 *   operators  + - * / // % **  == != < > <= >=  in, not in  and or not   a if cond else b
 *   access     x[i] x[a:b] obj.attr obj["name with spaces"]  function(...) str.method(...)
 *   functions  str int float round abs min max len hex format pad modicon bool
 *   methods    upper lower strip lstrip rstrip replace zfill rjust ljust center split join startswith endswith title capitalize find count
 * Columns, result values etc. are supplied by the caller as names (see PyDict).
 */

export class PyFloat {
  constructor(public v: number) {}
}
/** Dict-like value: d["key"] and d.key, case-insensitive fallback. */
export class PyDict {
  constructor(public get: (k: string) => PyValue | undefined, public keys: () => string[] = () => []) {}
}
export class PyFunc {
  /** Signature and docstring of a def'd function (for help panels). */
  sig?: string;
  doc?: string;
  constructor(public name: string, public call: (args: PyValue[], kw?: Record<string, PyValue>) => PyValue) {}
}
type MapKey = string | number | boolean | null;
/** Mutable dict (dict literals, JSON objects). Keys: str, int, bool, None. */
export class PyMap {
  m = new Map<MapKey, PyValue>();
  constructor(entries?: Iterable<[MapKey, PyValue]>) {
    if (entries) for (const [k, v] of entries) this.m.set(k, v);
  }
}
/** An exception object (raise / except … as e). */
export class PyExc {
  constructor(public type: string, public msg: string) {}
}
export type PyValue = string | number | boolean | null | PyFloat | PyValue[] | PyDict | PyMap | PyFunc | PyExc;
const mapKey = (k: PyValue): MapKey => {
  if (k instanceof PyFloat) return Number.isInteger(k.v) ? k.v : String(k.v);
  if (typeof k === "string" || typeof k === "number" || typeof k === "boolean" || k === null) return k;
  throw new PyError(`unhashable type: '${typeName(k)}'`);
};

export class PyError extends Error {
  /** Python exception type (ValueError, KeyError…); derived from the message when not set. */
  pyType?: string;
}
/** Built-in exception types that code can catch or raise. */
export const EXC_TYPES = ["Exception", "ValueError", "TypeError", "KeyError", "IndexError", "LookupError", "ZeroDivisionError", "ArithmeticError", "NameError", "AttributeError", "RuntimeError"];
const EXC_RULES: [RegExp, string][] = [
  [/stopped after \d+ steps/, "__limit"],
  [/^KeyError/, "KeyError"],
  [/index out of range|pop from empty list/, "IndexError"],
  [/division by zero|modulo by zero/, "ZeroDivisionError"],
  [/is not defined/, "NameError"],
  [/has no attribute|cannot set attribute|not found \(available/, "AttributeError"],
  [/invalid literal|could not convert|not in list|cannot unpack|range\(\) arg|empty sequence|Invalid format specifier|Unknown format code|range too large|from_json/, "ValueError"],
  [/unsupported operand|can only concatenate|not subscriptable|not callable|must be|bad operand|not supported between|unhashable|not iterable|indices must be|does not support|can only join|requires string|has no len|sequence item/, "TypeError"],
];
const stripLine = (m: string) => m.replace(/^(line \d+: )+/, "");
/** Python type of an error raised while running code. */
export function excType(e: unknown): string {
  if (e instanceof PyError && e.pyType) return e.pyType;
  const m = stripLine(e instanceof Error ? e.message : String(e));
  return EXC_RULES.find(([re]) => re.test(m))?.[1] ?? (e instanceof PyError ? "Exception" : "RuntimeError");
}
/** Does an `except T` clause catch an error of type t? */
const excMatches = (handler: string, t: string) =>
  t !== "__limit" && (handler === t || handler === "Exception" || handler === "BaseException" || (handler === "LookupError" && (t === "KeyError" || t === "IndexError")) || (handler === "ArithmeticError" && t === "ZeroDivisionError"));

// ---------------------------------------------------------------- tokens

type Tok = { t: "num" | "str" | "fstr" | "name" | "op" | "end"; v: string; pos: number };
const OPS = ["**", "//", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "+", "-", "*", "/", "%", "<", ">", "(", ")", "[", "]", "{", "}", ",", ".", ":", "="];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    // strings (optional f / r prefix)
    const pre = /^([fFrR]{0,2})(['"])/.exec(src.slice(i, i + 3));
    if (pre && (pre[1] === "" || /^[a-zA-Z]+$/.test(pre[1]))) {
      const isF = /f/i.test(pre[1]);
      const raw = /r/i.test(pre[1]);
      i += pre[1].length;
      const q = src[i];
      const triple = src.slice(i, i + 3) === q.repeat(3);
      const qq = triple ? q.repeat(3) : q;
      i += qq.length;
      let s = "";
      let depth = 0; // inside {…} of an f-string, quotes belong to the expression (Python 3.12+)
      for (;;) {
        if (i >= src.length) throw new PyError(`Unterminated string at ${start + 1}`);
        if (isF) {
          const ch0 = src[i];
          if (depth === 0 && (ch0 === "{" || ch0 === "}") && src[i + 1] === ch0) {
            s += ch0 + ch0;
            i += 2;
            continue;
          }
          if (ch0 === "{") depth++;
          else if (ch0 === "}" && depth > 0) depth--;
          if (depth > 0) {
            if (ch0 === "'" || ch0 === '"') {
              // copy a nested string literal verbatim
              let j = i + 1;
              while (j < src.length && src[j] !== ch0) j += src[j] === "\\" ? 2 : 1;
              s += src.slice(i, j + 1);
              i = j + 1;
              continue;
            }
            s += ch0;
            i++;
            continue;
          }
          if (ch0 === "}") {
            s += ch0;
            i++;
            continue;
          }
        }
        if (src.startsWith(qq, i)) {
          i += qq.length;
          break;
        }
        const ch = src[i];
        if (ch === "\\" && !raw) {
          const n = src[i + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", "'": "'", '"': '"', r: "\r", "0": "\0" };
          s += map[n] ?? "\\" + n;
          i += 2;
          continue;
        }
        if (ch === "\\" && raw) {
          s += ch + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        s += ch;
        i++;
      }
      out.push({ t: isF ? "fstr" : "str", v: s, pos: start });
      continue;
    }
    const num = /^0[xX][0-9a-fA-F]+|^(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num && /[\d.]/.test(c)) {
      out.push({ t: "num", v: num[0], pos: start });
      i += num[0].length;
      continue;
    }
    const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (nm) {
      out.push({ t: "name", v: nm[0], pos: start });
      i += nm[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op, pos: start });
      i += op.length;
      continue;
    }
    throw new PyError(`Unexpected character "${c}" at ${i + 1}`);
  }
  out.push({ t: "end", v: "", pos: src.length });
  return out;
}

// ---------------------------------------------------------------- AST

export type Node =
  | { k: "lit"; v: PyValue }
  | { k: "fstr"; parts: (string | { e: Node; conv?: string; spec?: Node | string })[] }
  | { k: "name"; n: string }
  | { k: "list"; items: Node[] }
  | { k: "dict"; items: [Node, Node][] }
  | { k: "comp"; e: Node; vars: string[]; it: Node; conds: Node[]; more?: { vars: string[]; it: Node; conds: Node[] }[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "cmp"; ops: string[]; items: Node[] }
  | { k: "bool"; op: "and" | "or"; a: Node; b: Node }
  | { k: "if"; c: Node; a: Node; b: Node }
  | { k: "call"; f: Node; args: Node[]; kw?: [string, Node][] }
  | { k: "attr"; o: Node; n: string }
  | { k: "idx"; o: Node; i: Node }
  | { k: "slice"; o: Node; a?: Node; b?: Node };

class Parser {
  i = 0;
  constructor(public t: Tok[]) {}
  peek = (o = 0) => this.t[this.i + o];
  is = (v: string, t?: Tok["t"]) => this.peek().v === v && (t ? this.peek().t === t : this.peek().t === "op" || this.peek().t === "name");
  eat(v: string) {
    if (!this.is(v)) throw new PyError(`Expected "${v}" at ${this.peek().pos + 1}${this.peek().t === "end" ? " (end of expression)" : ` but found "${this.peek().v}"`}`);
    this.i++;
  }
  parse(): Node {
    const n = this.expr();
    if (this.peek().t !== "end") throw new PyError(`Unexpected "${this.peek().v}" at ${this.peek().pos + 1}`);
    return n;
  }
  expr(): Node {
    const a = this.or();
    if (this.is("if", "name")) {
      this.i++;
      const c = this.or();
      this.eat("else");
      const b = this.expr();
      return { k: "if", c, a, b };
    }
    return a;
  }
  or(): Node {
    let a = this.and();
    while (this.is("or", "name")) {
      this.i++;
      a = { k: "bool", op: "or", a, b: this.and() };
    }
    return a;
  }
  and(): Node {
    let a = this.not();
    while (this.is("and", "name")) {
      this.i++;
      a = { k: "bool", op: "and", a, b: this.not() };
    }
    return a;
  }
  not(): Node {
    if (this.is("not", "name")) {
      this.i++;
      return { k: "un", op: "not", a: this.not() };
    }
    return this.cmp();
  }
  cmp(): Node {
    const items = [this.add()];
    const ops: string[] = [];
    for (;;) {
      const p = this.peek();
      if (p.t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(p.v)) {
        this.i++;
        ops.push(p.v);
      } else if (p.t === "name" && p.v === "in") {
        this.i++;
        ops.push("in");
      } else if (p.t === "name" && p.v === "is") {
        this.i++;
        if (this.is("not", "name")) {
          this.i++;
          ops.push("is not");
        } else ops.push("is");
      } else if (p.t === "name" && p.v === "not" && this.peek(1).v === "in") {
        this.i += 2;
        ops.push("not in");
      } else break;
      items.push(this.add());
    }
    return ops.length ? { k: "cmp", ops, items } : items[0];
  }
  add(): Node {
    let a = this.mul();
    while (this.peek().t === "op" && ["+", "-"].includes(this.peek().v)) {
      const op = this.t[this.i++].v;
      a = { k: "bin", op, a, b: this.mul() };
    }
    return a;
  }
  mul(): Node {
    let a = this.unary();
    while (this.peek().t === "op" && ["*", "/", "//", "%"].includes(this.peek().v)) {
      const op = this.t[this.i++].v;
      a = { k: "bin", op, a, b: this.unary() };
    }
    return a;
  }
  unary(): Node {
    if (this.peek().t === "op" && ["-", "+"].includes(this.peek().v)) {
      const op = this.t[this.i++].v;
      return { k: "un", op, a: this.unary() };
    }
    return this.pow();
  }
  pow(): Node {
    const a = this.postfix();
    if (this.peek().t === "op" && this.peek().v === "**") {
      this.i++;
      return { k: "bin", op: "**", a, b: this.unary() };
    }
    return a;
  }
  postfix(): Node {
    let n = this.atom();
    for (;;) {
      if (this.is("(", "op")) {
        this.i++;
        const args: Node[] = [];
        const kw: [string, Node][] = [];
        while (!this.is(")", "op")) {
          if (this.peek().t === "name" && this.peek(1).t === "op" && this.peek(1).v === "=") {
            const nm = this.peek().v;
            this.i += 2;
            kw.push([nm, this.expr()]);
          } else {
            const e = this.expr();
            // sum(x for x in xs): a generator argument behaves like a list
            args.push(this.is("for", "name") ? this.comp(e) : e);
          }
          if (!this.is(")", "op")) this.eat(",");
        }
        this.eat(")");
        n = kw.length ? { k: "call", f: n, args, kw } : { k: "call", f: n, args };
      } else if (this.is("[", "op")) {
        this.i++;
        let a: Node | undefined;
        if (!this.is(":", "op")) a = this.expr();
        if (this.is(":", "op")) {
          this.i++;
          const b = this.is("]", "op") ? undefined : this.expr();
          this.eat("]");
          n = { k: "slice", o: n, a, b };
        } else {
          this.eat("]");
          n = { k: "idx", o: n, i: a! };
        }
      } else if (this.is(".", "op")) {
        this.i++;
        const nm = this.peek();
        if (nm.t !== "name") throw new PyError(`Expected a name after "." at ${nm.pos + 1}`);
        this.i++;
        n = { k: "attr", o: n, n: nm.v };
      } else return n;
    }
  }
  /** [e for a, b in it if c for …] */
  comp(e: Node): Node {
    const loops: { vars: string[]; it: Node; conds: Node[] }[] = [];
    while (this.is("for", "name")) {
      this.i++;
      const vars: string[] = [];
      do {
        if (this.is(",", "op")) this.i++;
        const nm = this.peek();
        if (nm.t !== "name") throw new PyError(`Expected a name after "for" at ${nm.pos + 1}`);
        vars.push(nm.v);
        this.i++;
      } while (this.is(",", "op"));
      this.eat("in");
      const it = this.or();
      const conds: Node[] = [];
      while (this.is("if", "name")) {
        this.i++;
        conds.push(this.or());
      }
      loops.push({ vars, it, conds });
    }
    const [first, ...more] = loops;
    return { k: "comp", e, vars: first.vars, it: first.it, conds: first.conds, more };
  }
  atom(): Node {
    const p = this.peek();
    this.i++;
    if (p.t === "num") return { k: "lit", v: /^0x/i.test(p.v) ? parseInt(p.v, 16) : /[.eE]/.test(p.v) ? new PyFloat(Number(p.v)) : Number(p.v) };
    if (p.t === "str") {
      let s = p.v;
      // adjacent string literals concatenate
      while (this.peek().t === "str") s += this.t[this.i++].v;
      return { k: "lit", v: s };
    }
    if (p.t === "fstr") return parseF(p.v);
    if (p.t === "name") {
      if (p.v === "True") return { k: "lit", v: true };
      if (p.v === "False") return { k: "lit", v: false };
      if (p.v === "None") return { k: "lit", v: null };
      return { k: "name", n: p.v };
    }
    if (p.t === "op" && p.v === "(") {
      if (this.is(")", "op")) {
        this.i++;
        return { k: "list", items: [] };
      }
      const e = this.expr();
      if (this.is("for", "name")) {
        const c = this.comp(e);
        this.eat(")");
        return c;
      }
      if (this.is(",", "op")) {
        // tuple: treated as a list
        const items = [e];
        while (this.is(",", "op")) {
          this.i++;
          if (this.is(")", "op")) break;
          items.push(this.expr());
        }
        this.eat(")");
        return { k: "list", items };
      }
      this.eat(")");
      return e;
    }
    if (p.t === "op" && p.v === "[") {
      const items: Node[] = [];
      while (!this.is("]", "op")) {
        const e = this.expr();
        if (!items.length && this.is("for", "name")) {
          const c = this.comp(e);
          this.eat("]");
          return c;
        }
        items.push(e);
        if (!this.is("]", "op")) this.eat(",");
      }
      this.eat("]");
      return { k: "list", items };
    }
    if (p.t === "op" && p.v === "{") {
      const items: [Node, Node][] = [];
      while (!this.is("}", "op")) {
        const k = this.expr();
        this.eat(":");
        items.push([k, this.expr()]);
        if (!this.is("}", "op")) this.eat(",");
      }
      this.eat("}");
      return { k: "dict", items };
    }
    throw new PyError(p.t === "end" ? "Expression is incomplete" : `Unexpected "${p.v}" at ${p.pos + 1}`);
  }
}

/** Split an f-string body into literal text and {expression!conv:spec} parts. */
function parseF(body: string): Node {
  const parts: (string | { e: Node; conv?: string; spec?: Node | string })[] = [];
  let lit = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "{" && body[i + 1] === "{") {
      lit += "{";
      i += 2;
      continue;
    }
    if (c === "}" && body[i + 1] === "}") {
      lit += "}";
      i += 2;
      continue;
    }
    if (c !== "{") {
      lit += c;
      i++;
      continue;
    }
    // find the end of the replacement field, skipping nested brackets and strings
    let j = i + 1;
    let depth = 0;
    let q: string | null = null;
    let colon = -1;
    let bang = -1;
    for (; j < body.length; j++) {
      const d = body[j];
      if (q) {
        if (d === q) q = null;
        continue;
      }
      if (d === "'" || d === '"') q = d;
      else if ("([{".includes(d)) depth++;
      else if (")]".includes(d)) depth--;
      else if (d === "}" && depth > 0) depth--;
      else if (d === "}" && depth === 0) break;
      else if (d === ":" && depth === 0 && colon < 0) colon = j;
      else if (d === "!" && depth === 0 && colon < 0 && body[j + 1] !== "=") bang = j;
    }
    if (j >= body.length) throw new PyError("f-string: missing }");
    if (lit) parts.push(lit), (lit = "");
    const exprEnd = bang >= 0 ? bang : colon >= 0 ? colon : j;
    const e = new Parser(tokenize(body.slice(i + 1, exprEnd))).parse();
    const conv = bang >= 0 ? body.slice(bang + 1, colon >= 0 ? colon : j) : undefined;
    const specText = colon >= 0 ? body.slice(colon + 1, j) : undefined;
    const spec = specText && specText.includes("{") ? parseF(specText) : specText;
    parts.push({ e, conv, spec });
    i = j + 1;
  }
  if (lit) parts.push(lit);
  return { k: "fstr", parts };
}

export function parseExpr(src: string): Node {
  return new Parser(tokenize(src)).parse();
}

/** Names (top-level identifiers) used by an expression, e.g. to see whether it needs Result values. */
export function exprNames(src: string): Set<string> {
  const out = new Set<string>();
  const walk = (n: Node | string | undefined): void => {
    if (!n || typeof n === "string") return;
    switch (n.k) {
      case "name": out.add(n.n); return;
      case "fstr": n.parts.forEach((p) => typeof p !== "string" && (walk(p.e), walk(p.spec))); return;
      case "list": n.items.forEach(walk); return;
      case "dict": n.items.forEach(([a, b]) => (walk(a), walk(b))); return;
      case "comp": walk(n.e); walk(n.it); n.conds.forEach(walk); n.more?.forEach((m) => (walk(m.it), m.conds.forEach(walk))); return;
      case "un": walk(n.a); return;
      case "bin": case "bool": walk(n.a); walk(n.b); return;
      case "cmp": n.items.forEach(walk); return;
      case "if": walk(n.c); walk(n.a); walk(n.b); return;
      case "call": walk(n.f); n.args.forEach(walk); n.kw?.forEach(([, x]) => walk(x)); return;
      case "attr": walk(n.o); return;
      case "idx": walk(n.o); walk(n.i); return;
      case "slice": walk(n.o); walk(n.a); walk(n.b); return;
    }
  };
  try {
    walk(parseExpr(src));
  } catch {
    /* invalid: no names */
  }
  return out;
}

// ---------------------------------------------------------------- values

const isNum = (v: PyValue): v is number | PyFloat | boolean => typeof v === "number" || v instanceof PyFloat || typeof v === "boolean";
const nv = (v: PyValue): number => (v instanceof PyFloat ? v.v : typeof v === "boolean" ? (v ? 1 : 0) : (v as number));
const isFloat = (v: PyValue) => v instanceof PyFloat;
export const typeName = (v: PyValue): string =>
  v === null ? "NoneType" : typeof v === "string" ? "str" : typeof v === "boolean" ? "bool" : typeof v === "number" ? "int" : v instanceof PyFloat ? "float" : Array.isArray(v) ? "list" : v instanceof PyDict || v instanceof PyMap ? "dict" : v instanceof PyExc ? v.type : "function";
const mk = (x: number, float: boolean): PyValue => (float ? new PyFloat(x) : x);

function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  const s = String(x);
  return s.includes("e") ? s.replace(/e([+-])(\d)$/, "e$10$2") : s;
}
/** Python str(). */
export function pyStr(v: PyValue): string {
  if (v === null) return "None";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (v instanceof PyFloat) return floatRepr(v.v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v instanceof PyDict) return `{${v.keys().map((k) => `'${k}': ${pyRepr(v.get(k) ?? null)}`).join(", ")}}`;
  if (v instanceof PyExc) return v.msg;
  if (v instanceof PyMap) return `{${[...v.m.entries()].map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  return `<function ${v.name}>`;
}
const pyRepr = (v: PyValue) => (typeof v === "string" ? `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'` : pyStr(v));
export const truthy = (v: PyValue): boolean =>
  v === null ? false : typeof v === "string" || Array.isArray(v) ? v.length > 0 : isNum(v) ? nv(v) !== 0 : v instanceof PyMap ? v.m.size > 0 : true;

/** Python format() mini-language: [[fill]align][sign][#][0][width][,][.precision][type]. */
export function pyFormat(v: PyValue, spec: string): string {
  const m = /^(?:(.)?([<>^=]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGosxX%])?$/.exec(spec);
  if (!m) throw new PyError(`Invalid format specifier '${spec}'`);
  let [, fill, align, sign, , zero, width, group, prec, type] = m;
  let s: string;
  const numeric = isNum(v);
  if (!type) type = typeof v === "string" ? "s" : "";
  if (type === "s") {
    if (typeof v !== "string") s = pyStr(v);
    else s = v;
    if (prec) s = s.slice(0, Number(prec));
  } else {
    if (!numeric) throw new PyError(`Unknown format code '${type}' for object of type '${typeName(v)}'`);
    const x = nv(v);
    if ("dxXobc".includes(type) && type && isFloat(v)) throw new PyError(`Unknown format code '${type}' for object of type 'float'`);
    const a = Math.abs(x);
    switch (type) {
      case "d": s = String(Math.trunc(a)); break;
      case "x": s = Math.trunc(a).toString(16); break;
      case "X": s = Math.trunc(a).toString(16).toUpperCase(); break;
      case "o": s = Math.trunc(a).toString(8); break;
      case "b": s = Math.trunc(a).toString(2); break;
      case "f": case "F": s = a.toFixed(prec ? Number(prec) : 6); break;
      case "e": case "E": s = a.toExponential(prec ? Number(prec) : 6).replace(/e([+-])(\d)$/, "e$10$2"); if (type === "E") s = s.toUpperCase(); break;
      case "%": s = (a * 100).toFixed(prec ? Number(prec) : 6) + "%"; break;
      case "g": case "G": s = String(Number(a.toPrecision(prec ? Number(prec) || 1 : 6))); break;
      default: s = isFloat(v) ? floatRepr(a) : String(a);
    }
    if (group) {
      const [ip, fp] = s.split(".");
      s = ip.replace(/\B(?=(\d{3})+(?!\d))/g, group) + (fp != null ? "." + fp : "");
    }
    const neg = x < 0 || Object.is(x, -0) && isFloat(v);
    const sg = neg ? "-" : sign === "+" ? "+" : sign === " " ? " " : "";
    if (zero && !align) {
      fill = "0";
      align = "=";
    }
    if (align === "=") {
      const w = Number(width ?? 0) - sg.length;
      return sg + s.padStart(w, fill ?? " ");
    }
    s = sg + s;
  }
  const w = Number(width ?? 0);
  if (s.length >= w) return s;
  const f = fill ?? (zero && !align ? "0" : " ");
  const al = align ?? (numeric && type !== "s" ? ">" : "<");
  if (al === ">") return s.padStart(w, f);
  if (al === "^") {
    const left = Math.floor((w - s.length) / 2);
    return f.repeat(left) + s + f.repeat(w - s.length - left);
  }
  return s.padEnd(w, f);
}

function toInt(v: PyValue, base?: PyValue): number {
  if (typeof v === "string") {
    const t = v.trim().replace(/_/g, "");
    const b = base == null ? 10 : nv(base);
    const re = b === 16 ? /^[+-]?(0x)?[0-9a-f]+$/i : b === 2 ? /^[+-]?(0b)?[01]+$/i : b === 8 ? /^[+-]?(0o)?[0-7]+$/i : /^[+-]?\d+$/;
    if (!re.test(t)) throw new PyError(`invalid literal for int() with base ${b}: ${pyRepr(v)}`);
    return parseInt(t.replace(/^([+-]?)0[xbo]/i, "$1"), b);
  }
  if (isNum(v)) return Math.trunc(nv(v));
  throw new PyError(`int() argument must be a string or a number, not '${typeName(v)}'`);
}
function toFloat(v: PyValue): PyFloat {
  if (typeof v === "string") {
    const t = v.trim().replace(/_/g, "");
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(inf|nan)$/i.test(t)) throw new PyError(`could not convert string to float: ${pyRepr(v)}`);
    return new PyFloat(/inf/i.test(t) ? (t.startsWith("-") ? -Infinity : Infinity) : /nan/i.test(t) ? NaN : Number(t));
  }
  if (isNum(v)) return new PyFloat(nv(v));
  throw new PyError(`float() argument must be a string or a number, not '${typeName(v)}'`);
}
/** Python round(): half to even. */
function pyRound(x: number, nd: number): number {
  const f = 10 ** nd;
  const y = x * f;
  const r = Math.round(y);
  const half = Math.abs(y - Math.trunc(y)) === 0.5;
  return (half ? (r % 2 === 0 ? r : r - 1) : r) / f;
}

const iter = (v: PyValue): PyValue[] => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [...v];
  if (v instanceof PyMap) return [...v.m.keys()];
  if (v instanceof PyDict) return v.keys();
  throw new PyError(`'${typeName(v)}' object is not iterable`);
};
export const PY_FUNCS: Record<string, (a: PyValue[], kw?: Record<string, PyValue>) => PyValue> = {
  isinstance: ([v, t]) => {
    const names = (Array.isArray(t) ? t : [t]).map((x) => (x instanceof PyFunc ? x.name : pyStr(x ?? "")));
    const tn = v === null ? "NoneType" : typeName(v ?? null);
    return names.some((n) => n === tn || (n === "int" && tn === "bool") || (n === "Exception" && v instanceof PyExc));
  },
  range: ([a, b, c]) => {
    const [st, en, sp] = b == null ? [0, nv(a ?? 0), 1] : [nv(a!), nv(b), c == null ? 1 : nv(c)];
    if (sp === 0) throw new PyError("range() arg 3 must not be zero");
    const out: number[] = [];
    for (let x = st; sp > 0 ? x < en : x > en; x += sp) {
      out.push(x);
      if (out.length > 1e6) throw new PyError("range too large");
    }
    return out;
  },
  enumerate: ([v, s]) => iter(v ?? []).map((x, i) => [i + (s == null ? 0 : nv(s)), x]),
  zip: (a) => {
    const ls = a.map(iter);
    const n = Math.min(...ls.map((l) => l.length));
    return Array.from({ length: n }, (_, i) => ls.map((l) => l[i]));
  },
  sorted: ([v], kw) => {
    const l = [...iter(v ?? [])].sort(compare);
    return kw?.reverse && truthy(kw.reverse) ? l.reverse() : l;
  },
  reversed: ([v]) => [...iter(v ?? [])].reverse(),
  sum: ([v, st]) => iter(v ?? []).reduce((a, b) => bin("+", a, b), st ?? 0),
  any: ([v]) => iter(v ?? []).some(truthy),
  all: ([v]) => iter(v ?? []).every(truthy),
  list: ([v]) => (v == null ? [] : [...iter(v)]),
  dict: ([v], kw) => {
    const d = new PyMap();
    if (v instanceof PyMap) v.m.forEach((x, k) => d.m.set(k, x));
    else if (v instanceof PyDict) v.keys().forEach((k) => d.m.set(k, v.get(k) ?? null));
    else if (Array.isArray(v)) v.forEach((p) => Array.isArray(p) && d.m.set(mapKey(p[0]), p[1] ?? null));
    for (const [k, x] of Object.entries(kw ?? {})) d.m.set(k, x);
    return d;
  },
  str: ([v = ""]) => pyStr(v),
  int: (args) => toInt(args.length ? args[0] : 0, args[1]),
  float: (args) => toFloat(args.length ? args[0] : 0),
  bool: ([v]) => truthy(v ?? false),
  len: ([v]) => {
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    throw new PyError(`object of type '${typeName(v ?? null)}' has no len()`);
  },
  abs: ([v]) => (isNum(v) ? mk(Math.abs(nv(v)), isFloat(v)) : bad("abs", v)),
  round: ([v, n0], kw) => {
    const n = n0 ?? kw?.ndigits;
    if (!isNum(v)) return bad("round", v);
    if (n == null) return pyRound(nv(v), 0);
    const r = pyRound(nv(v), nv(n));
    return isFloat(v) ? new PyFloat(r) : r;
  },
  min: (a) => ext(a, -1),
  max: (a) => ext(a, 1),
  hex: ([v]) => (typeof v === "number" ? (v < 0 ? "-0x" : "0x") + Math.abs(v).toString(16) : bad("hex", v)),
  format: ([v, s]) => pyFormat(v ?? null, typeof s === "string" ? s : ""),
  /** pad(value, width, char="0"): right-aligned, padded on the left. */
  pad: ([v, w, c]) => pyStr(v ?? "").padStart(nv(w ?? 0), typeof c === "string" && c ? c[0] : "0"),
  /** modicon(space, address): HR 14 → "40015". */
  modicon: ([sp, a]) => {
    const pre: Record<string, string> = { CO: "0", DI: "1", IR: "3", HR: "4" };
    const p = pre[pyStr(sp ?? "").toUpperCase()];
    const one = toInt(a ?? 0) + 1;
    return p == null ? String(one - 1) : p + String(one).padStart(one <= 9999 ? 4 : 5, "0");
  },
};
function bad(f: string, v: PyValue | undefined): never {
  throw new PyError(`bad operand type for ${f}(): '${typeName(v ?? null)}'`);
}
function ext(a: PyValue[], dir: 1 | -1): PyValue {
  const l = a.length === 1 && Array.isArray(a[0]) ? (a[0] as PyValue[]) : a;
  if (!l.length) throw new PyError(`${dir > 0 ? "max" : "min"}() arg is an empty sequence`);
  return l.reduce((x, y) => (compare(y, x) * dir > 0 ? y : x));
}
function compare(a: PyValue, b: PyValue): number {
  if (isNum(a) && isNum(b)) return nv(a) - nv(b);
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  throw new PyError(`'<' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}
const eq = (a: PyValue, b: PyValue): boolean =>
  isNum(a) && isNum(b) ? nv(a) === nv(b) : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => eq(x, b[i])) : a === b;
function bindVars(vars: string[], item: PyValue): PyScope {
  if (vars.length === 1) return { [vars[0]]: item };
  const l = iter(item);
  if (l.length !== vars.length) throw new PyError(`cannot unpack ${l.length} values into ${vars.length} names`);
  return Object.fromEntries(vars.map((v, i) => [v, l[i]]));
}

function strMethod(s: string, name: string): PyFunc {
  const f = (impl: (a: PyValue[]) => PyValue) => new PyFunc(name, impl);
  const S = (v: PyValue | undefined) => (v == null ? undefined : pyStr(v));
  switch (name) {
    case "upper": return f(() => s.toUpperCase());
    case "lower": return f(() => s.toLowerCase());
    case "strip": return f(([c]) => (c == null ? s.trim() : trimSet(s, S(c)!, 3)));
    case "lstrip": return f(([c]) => (c == null ? s.trimStart() : trimSet(s, S(c)!, 1)));
    case "rstrip": return f(([c]) => (c == null ? s.trimEnd() : trimSet(s, S(c)!, 2)));
    case "replace": return f(([a, b]) => s.split(S(a) ?? "").join(S(b) ?? ""));
    case "zfill": return f(([w]) => {
      const n = nv(w ?? 0);
      const sg = /^[+-]/.test(s) ? s[0] : "";
      return sg + s.slice(sg.length).padStart(n - sg.length, "0");
    });
    case "rjust": return f(([w, c]) => s.padStart(nv(w ?? 0), S(c) ?? " "));
    case "ljust": return f(([w, c]) => s.padEnd(nv(w ?? 0), S(c) ?? " "));
    case "center": return f(([w, c]) => pyFormat(s, `${S(c) ?? " "}^${nv(w ?? 0)}`));
    case "split": return f(([sep, mx]) => {
      const parts = sep == null ? s.trim().split(/\s+/).filter(Boolean) : s.split(S(sep)!);
      if (mx == null || nv(mx) < 0 || parts.length <= nv(mx) + 1) return parts;
      const k = nv(mx);
      return [...parts.slice(0, k), parts.slice(k).join(S(sep) ?? " ")];
    });
    case "join": return f(([l]) => {
      if (!Array.isArray(l)) throw new PyError("can only join an iterable");
      return l.map((x) => {
        if (typeof x !== "string") throw new PyError(`sequence item: expected str instance, ${typeName(x)} found`);
        return x;
      }).join(s);
    });
    case "startswith": return f(([p]) => s.startsWith(S(p) ?? ""));
    case "endswith": return f(([p]) => s.endsWith(S(p) ?? ""));
    case "title": return f(() => s.toLowerCase().replace(/(^|[^a-zA-Z])([a-z])/g, (_, a, b) => a + b.toUpperCase()));
    case "capitalize": return f(() => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase());
    case "find": return f(([p]) => s.indexOf(S(p) ?? ""));
    case "count": return f(([p]) => (S(p) ? s.split(S(p)!).length - 1 : s.length + 1));
    case "isdigit": return f(() => /^\d+$/.test(s));
    case "format": return f((args) => s.replace(/\{(\d*)(?::([^}]*))?\}/g, (_, i, sp, k = 0) => pyFormat(args[i === "" ? k : Number(i)] ?? "", sp ?? "")));
  }
  throw new PyError(`'str' object has no attribute '${name}'`);
}
function listMethod(l: PyValue[], name: string): PyFunc {
  const f = (impl: (a: PyValue[], kw?: Record<string, PyValue>) => PyValue) => new PyFunc(name, impl);
  switch (name) {
    case "append": return f(([x]) => (l.push(x ?? null), null));
    case "extend": return f(([x]) => (l.push(...iter(x ?? [])), null));
    case "insert": return f(([i, x]) => (l.splice(nv(i ?? 0), 0, x ?? null), null));
    case "pop": return f(([i]) => {
      if (!l.length) throw new PyError("pop from empty list");
      const k = i == null ? l.length - 1 : nv(i) < 0 ? l.length + nv(i) : nv(i);
      return l.splice(k, 1)[0];
    });
    case "remove": return f(([x]) => {
      const k = l.findIndex((y) => eq(y, x ?? null));
      if (k < 0) throw new PyError("list.remove(x): x not in list");
      l.splice(k, 1);
      return null;
    });
    case "index": return f(([x]) => {
      const k = l.findIndex((y) => eq(y, x ?? null));
      if (k < 0) throw new PyError(`${pyRepr(x ?? null)} is not in list`);
      return k;
    });
    case "count": return f(([x]) => l.filter((y) => eq(y, x ?? null)).length);
    case "sort": return f((_, kw) => {
      l.sort(compare);
      if (kw?.reverse && truthy(kw.reverse)) l.reverse();
      return null;
    });
    case "copy": return f(() => [...l]);
  }
  throw new PyError(`'list' object has no attribute '${name}'`);
}
const DICT_METHODS = ["get", "keys", "values", "items", "update", "pop", "setdefault", "copy"];
function dictMethod(d: PyMap | PyDict, name: string): PyFunc | undefined {
  const get = (k: PyValue) => (d instanceof PyMap ? d.m.get(mapKey(k)) : d.get(pyStr(k)));
  const keys = (): PyValue[] => (d instanceof PyMap ? [...d.m.keys()] : d.keys());
  const f = (impl: (a: PyValue[]) => PyValue) => new PyFunc(name, impl);
  switch (name) {
    case "get": return f(([k, dflt]) => get(k ?? null) ?? dflt ?? null);
    case "keys": return f(() => keys());
    case "values": return f(() => keys().map((k) => get(k) ?? null));
    case "items": return f(() => keys().map((k) => [k, get(k) ?? null]));
    case "copy": return f(() => new PyMap(keys().map((k) => [mapKey(k), get(k) ?? null])));
  }
  if (!(d instanceof PyMap)) return undefined;
  switch (name) {
    case "update": return f(([o]) => {
      if (o instanceof PyMap) o.m.forEach((x, k) => d.m.set(k, x));
      else if (o instanceof PyDict) o.keys().forEach((k) => d.m.set(k, o.get(k) ?? null));
      return null;
    });
    case "pop": return f(([k, dflt]) => {
      const key = mapKey(k ?? null);
      if (d.m.has(key)) {
        const v = d.m.get(key)!;
        d.m.delete(key);
        return v;
      }
      if (dflt !== undefined) return dflt;
      throw new PyError(`KeyError: ${pyRepr(k ?? null)}`);
    });
    case "setdefault": return f(([k, dflt]) => {
      const key = mapKey(k ?? null);
      if (!d.m.has(key)) d.m.set(key, dflt ?? null);
      return d.m.get(key)!;
    });
  }
  return undefined;
}
function trimSet(s: string, chars: string, side: 1 | 2 | 3): string {
  let a = 0;
  let b = s.length;
  if (side & 1) while (a < b && chars.includes(s[a])) a++;
  if (side & 2) while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

// ---------------------------------------------------------------- evaluation

export type PyScope = Record<string, PyValue>;

export function evalNode(n: Node, scope: PyScope): PyValue {
  switch (n.k) {
    case "lit": return n.v;
    case "name": {
      if (n.n in scope && !(n.n in Object.prototype)) return scope[n.n];
      if (EXC_TYPES.includes(n.n)) return new PyFunc(n.n, (a) => new PyExc(n.n, a.map(pyStr).join(", ")));
      if (n.n === "print") return scope.__log instanceof PyFunc ? scope.__log : new PyFunc("print", () => null);
      if (n.n in PY_FUNCS) return new PyFunc(n.n, PY_FUNCS[n.n]);
      throw new PyError(`name '${n.n}' is not defined`);
    }
    case "list": return n.items.map((x) => evalNode(x, scope));
    case "dict": return new PyMap(n.items.map(([k, v]) => [mapKey(evalNode(k, scope)), evalNode(v, scope)]));
    case "comp": {
      const out: PyValue[] = [];
      const loops = [{ vars: n.vars, it: n.it, conds: n.conds }, ...(n.more ?? [])];
      const run = (depth: number, sc: PyScope) => {
        if (depth === loops.length) return void out.push(evalNode(n.e, sc));
        const L = loops[depth];
        for (const item of iter(evalNode(L.it, sc))) {
          const inner: PyScope = Object.assign(Object.create(sc), bindVars(L.vars, item));
          if (L.conds.every((c) => truthy(evalNode(c, inner)))) run(depth + 1, inner);
          if (out.length > 1e6) throw new PyError("comprehension too large");
        }
      };
      run(0, scope);
      return out;
    }
    case "fstr":
      return n.parts.map((p) => {
        if (typeof p === "string") return p;
        let v = evalNode(p.e, scope);
        if (p.conv === "r") v = pyRepr(v);
        const spec = p.spec == null ? "" : typeof p.spec === "string" ? p.spec : pyStr(evalNode(p.spec, scope));
        return spec ? pyFormat(v, spec) : pyStr(v);
      }).join("");
    case "un": {
      const a = evalNode(n.a, scope);
      if (n.op === "not") return !truthy(a);
      if (!isNum(a)) throw new PyError(`bad operand type for unary ${n.op}: '${typeName(a)}'`);
      return mk(n.op === "-" ? -nv(a) : nv(a), isFloat(a));
    }
    case "bool": {
      const a = evalNode(n.a, scope);
      if (n.op === "and") return truthy(a) ? evalNode(n.b, scope) : a;
      return truthy(a) ? a : evalNode(n.b, scope);
    }
    case "if": return truthy(evalNode(n.c, scope)) ? evalNode(n.a, scope) : evalNode(n.b, scope);
    case "cmp": {
      let a = evalNode(n.items[0], scope);
      for (let k = 0; k < n.ops.length; k++) {
        const b = evalNode(n.items[k + 1], scope);
        const op = n.ops[k];
        let ok: boolean;
        if (op === "is" || op === "is not") ok = (a === b || (a instanceof PyFloat && b instanceof PyFloat && a.v === b.v)) === (op === "is");
        else if (op === "==") ok = eq(a, b);
        else if (op === "!=") ok = !eq(a, b);
        else if (op === "in" || op === "not in") {
          const has = typeof b === "string" ? (typeof a === "string" ? b.includes(a) : bin("in", a, b) as boolean) : Array.isArray(b) ? b.some((x) => eq(x, a)) : b instanceof PyDict ? b.get(pyStr(a)) !== undefined : b instanceof PyMap ? b.m.has(mapKey(a)) : bad("in", b);
          ok = op === "in" ? has : !has;
        } else {
          const c = compare(a, b);
          ok = op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0;
        }
        if (!ok) return false;
        a = b;
      }
      return true;
    }
    case "bin": return bin(n.op, evalNode(n.a, scope), evalNode(n.b, scope));
    case "attr": {
      const o = evalNode(n.o, scope);
      if ((o instanceof PyDict || o instanceof PyMap) && DICT_METHODS.includes(n.n)) {
        const m = dictMethod(o, n.n);
        if (m) return m;
      }
      if (o instanceof PyDict) {
        const v = o.get(n.n);
        if (v === undefined) throw new PyError(`'${n.n}' not found (available: ${o.keys().join(", ") || "none"})`);
        return v;
      }
      if (o instanceof PyMap) {
        // convenience: el.name reads key "name" (Python itself needs el["name"])
        if (o.m.has(n.n)) return o.m.get(n.n)!;
        throw new PyError(`KeyError: '${n.n}' (available: ${[...o.m.keys()].slice(0, 12).join(", ") || "none"})`);
      }
      if (Array.isArray(o)) return listMethod(o, n.n);
      if (isNum(o)) {
        if (n.n === "is_integer") return new PyFunc(n.n, () => Number.isInteger(nv(o)));
        if (n.n === "bit_length" && !isFloat(o)) return new PyFunc(n.n, () => (nv(o) === 0 ? 0 : Math.floor(Math.log2(Math.abs(nv(o)))) + 1));
        if (n.n === "real") return o;
        throw new PyError(`'${typeName(o)}' object has no attribute '${n.n}'`);
      }
      if (o instanceof PyExc && n.n === "args") return [o.msg];
      if (typeof o === "string") return strMethod(o, n.n);
      throw new PyError(`'${typeName(o)}' object has no attribute '${n.n}'`);
    }
    case "idx": {
      const o = evalNode(n.o, scope);
      const i = evalNode(n.i, scope);
      if (o instanceof PyDict) {
        const v = o.get(pyStr(i));
        if (v === undefined) throw new PyError(`KeyError: ${pyRepr(i)} (available: ${o.keys().slice(0, 12).join(", ") || "none"})`);
        return v;
      }
      if (o instanceof PyMap) {
        const k = mapKey(i);
        if (!o.m.has(k)) throw new PyError(`KeyError: ${pyRepr(i)} (available: ${[...o.m.keys()].slice(0, 12).map((x) => pyRepr(x)).join(", ") || "none"})`);
        return o.m.get(k)!;
      }
      if (typeof o === "string" || Array.isArray(o)) {
        if (typeof i !== "number") throw new PyError(`indices must be integers, not ${typeName(i)}`);
        const k = i < 0 ? o.length + i : i;
        if (k < 0 || k >= o.length) throw new PyError(`${typeName(o)} index out of range`);
        return o[k];
      }
      throw new PyError(`'${typeName(o)}' object is not subscriptable`);
    }
    case "slice": {
      const o = evalNode(n.o, scope);
      if (typeof o !== "string" && !Array.isArray(o)) throw new PyError(`'${typeName(o)}' object is not subscriptable`);
      const len = o.length;
      const norm = (x: PyValue | undefined, d: number) => {
        if (x === undefined || x === null) return d;
        const v = nv(x as number);
        return v < 0 ? Math.max(0, len + v) : Math.min(len, v);
      };
      const a = norm(n.a ? evalNode(n.a, scope) : undefined, 0);
      const b = norm(n.b ? evalNode(n.b, scope) : undefined, len);
      return o.slice(a, Math.max(a, b));
    }
    case "call": {
      const f = evalNode(n.f, scope);
      if (!(f instanceof PyFunc)) throw new PyError(`'${typeName(f)}' object is not callable`);
      const kw = n.kw ? Object.fromEntries(n.kw.map(([k, x]) => [k, evalNode(x, scope)])) : undefined;
      return f.call(n.args.map((x) => evalNode(x, scope)), kw);
    }
  }
}

function bin(op: string, a: PyValue, b: PyValue): PyValue {
  if (op === "+") {
    if (typeof a === "string" && typeof b === "string") return a + b;
    if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
    if (isNum(a) && isNum(b)) return mk(nv(a) + nv(b), isFloat(a) || isFloat(b));
    if (typeof a === "string") throw new PyError(`can only concatenate str (not "${typeName(b)}") to str — wrap it in str(…)`);
  }
  if (op === "*") {
    if (typeof a === "string" && typeof b === "number") return a.repeat(Math.max(0, b));
    if (typeof b === "string" && typeof a === "number") return b.repeat(Math.max(0, a));
  }
  if (op === "in") throw new PyError(`'in <string>' requires string as left operand, not ${typeName(a)}`);
  if (!isNum(a) || !isNum(b)) throw new PyError(`unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'${typeof a === "string" || typeof b === "string" ? " — convert text with int(…) or float(…)" : ""}`);
  const x = nv(a);
  const y = nv(b);
  const fl = isFloat(a) || isFloat(b);
  switch (op) {
    case "-": return mk(x - y, fl);
    case "*": return mk(x * y, fl);
    case "/": if (y === 0) throw new PyError("division by zero"); return new PyFloat(x / y);
    case "//": if (y === 0) throw new PyError("integer division or modulo by zero"); return mk(Math.floor(x / y), fl);
    case "%": if (y === 0) throw new PyError("integer division or modulo by zero"); return mk(((x % y) + y) % y, fl);
    case "**": return mk(x ** y, fl || y < 0);
  }
  throw new PyError(`unsupported operator ${op}`);
}

/** Evaluate an expression; the result is converted to text the way str() does (None → ""). */
export function evalExpr(src: string, scope: PyScope): string {
  const v = evalNode(parseExpr(src), scope);
  return v === null ? "" : pyStr(v);
}

// ---------------------------------------------------------------- statements (Python code)

type Target = { k: "name"; n: string } | { k: "idx"; o: Node; i: Node } | { k: "attr"; o: Node; n: string } | { k: "tuple"; names: string[] };
type Stmt =
  | { k: "expr"; e: Node; line: number }
  | { k: "assign"; t: Target; op: string; e: Node; line: number }
  | { k: "if"; br: { c: Node | null; body: Stmt[] }[]; line: number }
  | { k: "for"; vars: string[]; it: Node; body: Stmt[]; orelse?: Stmt[]; line: number }
  | { k: "while"; c: Node; body: Stmt[]; orelse?: Stmt[]; line: number }
  | { k: "try"; body: Stmt[]; handlers: { types: string[]; name?: string; body: Stmt[]; line: number }[]; orelse?: Stmt[]; fin?: Stmt[]; line: number }
  | { k: "raise"; e?: Node; line: number }
  | { k: "def"; name: string; params: Param[]; body: Stmt[]; doc: string; sig: string; line: number }
  | { k: "return"; e?: Node; line: number }
  | { k: "break" | "continue" | "pass"; line: number };

interface Param {
  name: string;
  def?: Node;
  star?: "*" | "**";
}
interface Logical {
  text: string;
  indent: number;
  line: number;
}

/** Physical lines → logical lines (brackets and triple-quoted strings may span lines; # comments removed). */
function logicalLines(src: string): Logical[] {
  const out: Logical[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let buf = "";
  let start = 0;
  let depth = 0;
  let indent = 0;
  let q: string | null = null; // open quote; a triple quote may continue on the next line
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln];
    const inTriple = !!q && q.length === 3;
    let text = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (q) {
        if (c === "\\") {
          text += c + (raw[i + 1] ?? "");
          i++;
          continue;
        }
        if (q.length === 3 ? raw.startsWith(q, i) : c === q) {
          text += q;
          i += q.length - 1;
          q = null;
          continue;
        }
        text += c;
        continue;
      }
      if (c === "#") break;
      if (c === "'" || c === '"') {
        q = raw.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
        text += q;
        i += q.length - 1;
        continue;
      }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
      text += c;
    }
    if (q && q.length === 1) q = null; // unterminated: the tokenizer reports it
    if (!buf && !inTriple) {
      if (!text.trim()) continue;
      start = ln;
      indent = (/^[ \t]*/.exec(text)![0]).replace(/\t/g, "    ").length;
    }
    const cont = !q && text.trimEnd().endsWith("\\");
    const piece = inTriple ? text.trimEnd() : (cont ? text.trimEnd().slice(0, -1) : text).trim();
    buf += buf ? (inTriple ? "\n" : " ") + piece : piece;
    if (depth === 0 && !cont && !q) {
      out.push({ text: buf, indent, line: start + 1 });
      buf = "";
    }
  }
  if (buf) out.push({ text: buf, indent, line: start + 1 });
  return out;
}

const withEnd = (t: Tok[]): Tok[] => [...t, { t: "end", v: "", pos: t.length ? t[t.length - 1].pos + 1 : 0 }];
function topLevel(toks: Tok[], pred: (t: Tok) => boolean): number {
  let d = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "op" && "([{".includes(t.v)) d++;
    else if (t.t === "op" && ")]}".includes(t.v)) d--;
    else if (d === 0 && pred(t)) return i;
  }
  return -1;
}
const parseTokens = (toks: Tok[]): Node => new Parser(withEnd(toks)).parse();
/** a, b, c (bare tuple) → list node; a single expression otherwise. */
function parseTuple(toks: Tok[]): Node {
  const parts: Tok[][] = [];
  let cur: Tok[] = [];
  let d = 0;
  for (const t of toks) {
    if (t.t === "op" && "([{".includes(t.v)) d++;
    if (t.t === "op" && ")]}".includes(t.v)) d--;
    if (d === 0 && t.t === "op" && t.v === ",") {
      parts.push(cur);
      cur = [];
    } else cur.push(t);
  }
  if (cur.length) parts.push(cur);
  return parts.length > 1 || (toks.length && toks[toks.length - 1].v === ",") ? { k: "list", items: parts.map(parseTokens) } : parseTokens(toks);
}

class CodeParser {
  i = 0;
  constructor(private L: Logical[]) {}
  err(l: Logical, m: string): never {
    throw new PyError(`line ${l.line}: ${m}`);
  }
  block(indent: number): Stmt[] {
    const out: Stmt[] = [];
    while (this.i < this.L.length) {
      const l = this.L[this.i];
      if (l.indent < indent) break;
      if (l.indent > indent) this.err(l, "unexpected indent");
      out.push(this.stmt(l));
    }
    return out;
  }
  /** Body after a header ending with ":" — inline statement or an indented block. */
  body(l: Logical, rest: Tok[]): Stmt[] {
    if (rest.length) return [this.simple({ ...l }, rest)];
    const next = this.L[this.i];
    if (!next || next.indent <= l.indent) this.err(l, "expected an indented block");
    return this.block(next.indent);
  }
  header(l: Logical, toks: Tok[], skip: number): { head: Tok[]; rest: Tok[] } {
    const c = topLevel(toks.slice(skip), (t) => t.t === "op" && t.v === ":");
    if (c < 0) this.err(l, `expected ":"`);
    return { head: toks.slice(skip, skip + c), rest: toks.slice(skip + c + 1) };
  }
  stmt(l: Logical): Stmt {
    this.i++;
    let toks: Tok[];
    try {
      toks = tokenize(l.text);
      toks.pop();
    } catch (e) {
      this.err(l, (e as Error).message);
    }
    const kw = toks[0]?.t === "name" ? toks[0].v : "";
    try {
      if (kw === "if") {
        const br: { c: Node | null; body: Stmt[] }[] = [];
        const { head, rest } = this.header(l, toks, 1);
        br.push({ c: parseTokens(head), body: this.body(l, rest) });
        for (;;) {
          const nx = this.L[this.i];
          if (!nx || nx.indent !== l.indent) break;
          const t2 = tokenize(nx.text);
          t2.pop();
          if (t2[0]?.v === "elif") {
            this.i++;
            const h = this.header(nx, t2, 1);
            br.push({ c: parseTokens(h.head), body: this.body(nx, h.rest) });
          } else if (t2[0]?.v === "else") {
            this.i++;
            const h = this.header(nx, t2, 1);
            br.push({ c: null, body: this.body(nx, h.rest) });
            break;
          } else break;
        }
        return { k: "if", br, line: l.line };
      }
      if (kw === "for") {
        const inAt = topLevel(toks, (t) => t.t === "name" && t.v === "in");
        if (inAt < 0) this.err(l, `expected "in"`);
        const vars = toks.slice(1, inAt).filter((t) => !(t.t === "op" && [",", "(", ")"].includes(t.v))).map((t) => {
          if (t.t !== "name") this.err(l, `invalid loop variable "${t.v}"`);
          return t.v;
        });
        const { head, rest } = this.header(l, toks, inAt + 1);
        const body = this.body(l, rest);
        return { k: "for", vars, it: parseTokens(head), body, orelse: this.clause(l, "else"), line: l.line };
      }
      if (kw === "while") {
        const { head, rest } = this.header(l, toks, 1);
        const body = this.body(l, rest);
        return { k: "while", c: parseTokens(head), body, orelse: this.clause(l, "else"), line: l.line };
      }
      if (kw === "def") {
        const nm = toks[1];
        if (!nm || nm.t !== "name" || toks[2]?.v !== "(") this.err(l, "expected def name(…):");
        // parameters up to the matching ")"
        let d = 0;
        let close = -1;
        for (let k = 2; k < toks.length; k++) {
          if (toks[k].t === "op" && "([{".includes(toks[k].v)) d++;
          if (toks[k].t === "op" && ")]}".includes(toks[k].v) && --d === 0) {
            close = k;
            break;
          }
        }
        if (close < 0) this.err(l, `expected ")"`);
        const params: Param[] = [];
        const ptoks = toks.slice(3, close);
        const parts: Tok[][] = [];
        let cur: Tok[] = [];
        d = 0;
        for (const t of ptoks) {
          if (t.t === "op" && "([{".includes(t.v)) d++;
          if (t.t === "op" && ")]}".includes(t.v)) d--;
          if (d === 0 && t.t === "op" && t.v === ",") (parts.push(cur), (cur = []));
          else cur.push(t);
        }
        if (cur.length) parts.push(cur);
        for (const pt of parts) {
          let star: Param["star"];
          let k = 0;
          if (pt[0]?.v === "**") (star = "**"), (k = 1);
          else if (pt[0]?.v === "*") (star = "*"), (k = 1);
          if (pt[k]?.t !== "name") this.err(l, "invalid parameter");
          const eqAt = topLevel(pt, (t) => t.t === "op" && t.v === "=");
          // type hints (x: int = 1) are accepted and ignored
          params.push({ name: pt[k].v, star, def: eqAt > 0 ? parseTokens(pt.slice(eqAt + 1)) : undefined });
        }
        // optional "-> annotation" before ":"
        let after = close + 1;
        if (toks[after]?.v === "-" && toks[after + 1]?.v === ">") {
          after = topLevel(toks.slice(after), (t) => t.t === "op" && t.v === ":") + after;
          if (after < close) this.err(l, `expected ":"`);
        }
        if (toks[after]?.v !== ":") this.err(l, `expected ":" after the parameters`);
        const body = this.body(l, toks.slice(after + 1));
        const first = body[0];
        const doc = first?.k === "expr" && first.e.k === "lit" && typeof first.e.v === "string" ? first.e.v.trim() : "";
        const sig = `${nm.v}(${params.map((p) => (p.star ?? "") + p.name + (p.def ? `=${l.text.slice(0, 0)}…` : "")).join(", ")})`;
        return { k: "def", name: nm.v, params, body, doc, sig: sigText(l.text) ?? sig, line: l.line };
      }
      if (kw === "try") {
        const { head, rest } = this.header(l, toks, 1);
        if (head.length) this.err(l, `expected ":" after "try"`);
        const body = this.body(l, rest);
        const handlers: { types: string[]; name?: string; body: Stmt[]; line: number }[] = [];
        for (;;) {
          const nx = this.L[this.i];
          if (!nx || nx.indent !== l.indent) break;
          const t2 = tokenize(nx.text);
          t2.pop();
          if (t2[0]?.v !== "except") break;
          this.i++;
          const h = this.header(nx, t2, 1);
          const asAt = h.head.findIndex((t) => t.t === "name" && t.v === "as");
          const typeToks = asAt < 0 ? h.head : h.head.slice(0, asAt);
          const types = typeToks.filter((t) => !(t.t === "op" && [",", "(", ")"].includes(t.v))).map((t) => {
            if (t.t !== "name") this.err(nx, `invalid exception type "${t.v}"`);
            return t.v;
          });
          let name: string | undefined;
          if (asAt >= 0) {
            if (h.head.length !== asAt + 2 || h.head[asAt + 1].t !== "name") this.err(nx, `expected a name after "as"`);
            name = h.head[asAt + 1].v;
          }
          handlers.push({ types, name, body: this.body(nx, h.rest), line: nx.line });
        }
        const orelse = handlers.length ? this.clause(l, "else") : undefined;
        const fin = this.clause(l, "finally");
        if (!handlers.length && !fin) this.err(l, `"try" needs an "except" or "finally" block`);
        return { k: "try", body, handlers, orelse, fin, line: l.line };
      }
      if (kw === "except" || kw === "finally") this.err(l, `"${kw}" without a matching "try"`);
      if (kw === "elif" || kw === "else") this.err(l, `"${kw}" without a matching "if"`);
      return this.simple(l, toks);
    } catch (e) {
      if (e instanceof PyError && /^line \d+:/.test(e.message)) throw e;
      this.err(l, (e as Error).message);
    }
  }
  /** Optional "else:" / "finally:" clause at the same indent as the statement. */
  clause(l: Logical, word: string): Stmt[] | undefined {
    const nx = this.L[this.i];
    if (!nx || nx.indent !== l.indent) return undefined;
    const t2 = tokenize(nx.text);
    t2.pop();
    if (t2[0]?.v !== word) return undefined;
    this.i++;
    const h = this.header(nx, t2, 1);
    return this.body(nx, h.rest);
  }
  simple(l: Logical, toks: Tok[]): Stmt {
    const kw = toks[0]?.t === "name" ? toks[0].v : "";
    if (kw === "raise") return { k: "raise", e: toks.length > 1 ? parseTokens(toks.slice(1)) : undefined, line: l.line };
    if (kw === "return") return { k: "return", e: toks.length > 1 ? parseTuple(toks.slice(1)) : undefined, line: l.line };
    if ((kw === "break" || kw === "continue" || kw === "pass") && toks.length === 1) return { k: kw, line: l.line };
    const a = topLevel(toks, (t) => t.t === "op" && ["=", "+=", "-=", "*=", "/="].includes(t.v));
    if (a < 0) return { k: "expr", e: parseTuple(toks), line: l.line };
    const lhs = toks.slice(0, a);
    const op = toks[a].v;
    const e = parseTuple(toks.slice(a + 1));
    if (topLevel(lhs, (t) => t.t === "op" && t.v === ",") >= 0) {
      const names = lhs.filter((t) => !(t.t === "op" && [",", "(", ")"].includes(t.v))).map((t) => {
        if (t.t !== "name") this.err(l, "can only unpack into names");
        return t.v;
      });
      return { k: "assign", t: { k: "tuple", names }, op, e, line: l.line };
    }
    const tn = parseTokens(lhs);
    const t: Target = tn.k === "name" ? { k: "name", n: tn.n } : tn.k === "idx" ? { k: "idx", o: tn.o, i: tn.i } : tn.k === "attr" ? { k: "attr", o: tn.o, n: tn.n } : this.err(l, "cannot assign to this expression");
    return { k: "assign", t, op, e, line: l.line };
  }
}

/** "def f(a, b=1) -> str:" → "f(a, b=1)" */
function sigText(text: string): string | undefined {
  const m = /^def\s+([A-Za-z_]\w*)\s*\((.*)\)\s*(->[^:]*)?:/.exec(text.replace(/\n[\s\S]*$/, ""));
  return m ? `${m[1]}(${m[2].replace(/\s+/g, " ").trim()})` : undefined;
}

/** Parse Python code (statements). */
export function parseCode(src: string): Stmt[] {
  const L = logicalLines(src);
  if (!L.length) return [];
  const p = new CodeParser(L);
  const body = p.block(L[0].indent);
  if (p.i < L.length) throw new PyError(`line ${L[p.i].line}: unindent does not match any outer indentation level`);
  return body;
}

class Flow {
  constructor(public kind: "return" | "break" | "continue", public v: PyValue = null) {}
}

interface Run {
  steps: number;
  max: number;
  depth: number;
}

/** Execute statements in a scope. Function scopes inherit (prototype) from the scope that defined them. */
function execBlock(body: Stmt[], sc: PyScope, R: Run, current: { e: unknown }): void {
  const tick = (line: number) => {
    if (++R.steps > R.max) throw new PyError(`line ${line}: stopped after ${R.max} steps (endless loop?)`);
  };
  const assign = (t: Target, v: PyValue, line: number) => {
    if (t.k === "name") sc[t.n] = v;
    else if (t.k === "tuple") Object.assign(sc, bindVars(t.names, v));
    else if (t.k === "idx") {
      const o = evalNode(t.o, sc);
      const i = evalNode(t.i, sc);
      if (o instanceof PyMap) o.m.set(mapKey(i), v);
      else if (Array.isArray(o)) {
        const k = nv(i as number);
        const j = k < 0 ? o.length + k : k;
        if (j < 0 || j >= o.length) throw new PyError(`line ${line}: list assignment index out of range`);
        o[j] = v;
      } else throw new PyError(`line ${line}: '${typeName(o)}' object does not support item assignment`);
    } else {
      const o = evalNode(t.o, sc);
      if (o instanceof PyMap) o.m.set(t.n, v);
      else throw new PyError(`line ${line}: cannot set attribute on '${typeName(o)}'`);
    }
  };
  const read = (t: Target): PyValue => evalNode(t.k === "name" ? { k: "name", n: t.n } : t.k === "idx" ? { k: "idx", o: t.o, i: t.i } : t.k === "attr" ? { k: "attr", o: t.o, n: t.n } : { k: "lit", v: null }, sc);
  const loop = (b: Stmt[]): "break" | undefined => {
    try {
      execBlock(b, sc, R, current);
    } catch (f) {
      if (f instanceof Flow && f.kind === "break") return "break";
      if (f instanceof Flow && f.kind === "continue") return undefined;
      throw f;
    }
    return undefined;
  };
  for (const s of body) {
    tick(s.line);
    try {
      switch (s.k) {
        case "expr": evalNode(s.e, sc); break;
        case "assign": {
          let v = evalNode(s.e, sc);
          if (s.op !== "=") v = bin(s.op[0], read(s.t), v);
          assign(s.t, v, s.line);
          break;
        }
        case "if":
          for (const b of s.br) if (b.c === null || truthy(evalNode(b.c, sc))) {
            execBlock(b.body, sc, R, current);
            break;
          }
          break;
        case "for": {
          let broke = false;
          for (const item of iter(evalNode(s.it, sc))) {
            tick(s.line);
            Object.assign(sc, bindVars(s.vars, item));
            if (loop(s.body) === "break") {
              broke = true;
              break;
            }
          }
          if (!broke && s.orelse) execBlock(s.orelse, sc, R, current);
          break;
        }
        case "while": {
          let broke = false;
          while (truthy(evalNode(s.c, sc))) {
            tick(s.line);
            if (loop(s.body) === "break") {
              broke = true;
              break;
            }
          }
          if (!broke && s.orelse) execBlock(s.orelse, sc, R, current);
          break;
        }
        case "try": {
          let handled = false;
          try {
            try {
              execBlock(s.body, sc, R, current);
            } catch (e) {
              if (e instanceof Flow) throw e;
              const t = excType(e);
              const h = s.handlers.find((x) => (x.types.length ? x.types.some((y) => excMatches(y, t)) : t !== "__limit"));
              if (!h) throw e;
              handled = true;
              const prev = current.e;
              current.e = e;
              if (h.name) sc[h.name] = new PyExc(t, (e as { pyMsg?: string }).pyMsg ?? stripLine((e as Error).message).replace(/^[A-Za-z]+Error: /, ""));
              try {
                execBlock(h.body, sc, R, current);
              } finally {
                current.e = prev;
              }
            }
            if (!handled && s.orelse) execBlock(s.orelse, sc, R, current);
          } finally {
            if (s.fin) execBlock(s.fin, sc, R, current);
          }
          break;
        }
        case "raise": {
          if (!s.e) {
            if (current.e) throw current.e;
            throw Object.assign(new PyError("RuntimeError: No active exception to re-raise"), { pyType: "RuntimeError" });
          }
          const v = evalNode(s.e, sc);
          const ex = v instanceof PyExc ? v : v instanceof PyFunc && EXC_TYPES.includes(v.name) ? new PyExc(v.name, "") : null;
          if (!ex) throw Object.assign(new PyError(`TypeError: exceptions must derive from Exception, e.g. raise ValueError("…")`), { pyType: "TypeError" });
          throw Object.assign(new PyError(`${ex.type}${ex.msg ? `: ${ex.msg}` : ""}`), { pyType: ex.type, pyMsg: ex.msg });
        }
        case "def": {
          const defScope = sc;
          const d = s;
          const fn = new PyFunc(d.name, (args, kw) => {
            if (++R.depth > 100) {
              R.depth--;
              throw new PyError("maximum recursion depth exceeded");
            }
            const local: PyScope = Object.create(defScope);
            const rest: PyValue[] = [];
            const extra = new PyMap();
            const given = { ...(kw ?? {}) };
            let ai = 0;
            for (const p of d.params) {
              if (p.star === "*") {
                while (ai < args.length) rest.push(args[ai++]);
                local[p.name] = rest;
              } else if (p.star === "**") local[p.name] = extra;
              else if (ai < args.length) local[p.name] = args[ai++];
              else if (p.name in given) {
                local[p.name] = given[p.name];
                delete given[p.name];
              } else if (p.def) local[p.name] = evalNode(p.def, defScope);
              else {
                R.depth--;
                throw new PyError(`${d.name}() missing required argument: '${p.name}'`);
              }
            }
            if (ai < args.length) {
              R.depth--;
              throw new PyError(`${d.name}() takes ${d.params.filter((p) => !p.star).length} positional arguments but ${args.length} were given`);
            }
            for (const [k, v] of Object.entries(given)) {
              if (!d.params.some((p) => p.star === "**")) {
                R.depth--;
                throw new PyError(`${d.name}() got an unexpected keyword argument '${k}'`);
              }
              extra.m.set(k, v);
            }
            try {
              execBlock(d.body, local, R, { e: null });
            } catch (f) {
              if (f instanceof Flow && f.kind === "return") return f.v;
              if (f instanceof Flow) throw new PyError(`"${f.kind}" outside a loop`);
              throw f;
            } finally {
              R.depth--;
            }
            return null;
          });
          fn.sig = d.sig;
          fn.doc = d.doc;
          sc[d.name] = fn;
          break;
        }
        case "return": throw new Flow("return", s.e ? evalNode(s.e, sc) : null);
        case "break": throw new Flow("break");
        case "continue": throw new Flow("continue");
        case "pass": break;
      }
    } catch (e) {
      if (e instanceof Flow) throw e;
      if (e instanceof PyError && /^line \d+:/.test(e.message)) throw e;
      const ne = new PyError(`line ${s.line}: ${(e as Error).message}`);
      ne.pyType = excType(e);
      if ((e as { pyMsg?: string }).pyMsg !== undefined) (ne as { pyMsg?: string }).pyMsg = (e as { pyMsg?: string }).pyMsg;
      throw ne;
    }
  }
}

/** Run Python code; returns the value of `return` (None if none). print(…) goes to opts.log. */
export function execCode(src: string, scope: PyScope, opts: { maxSteps?: number; log?: (s: string) => void } = {}): PyValue {
  const prog = parseCode(src);
  const sc: PyScope = Object.create(scope);
  if (opts.log) sc.__log = new PyFunc("print", (a) => (opts.log!(a.map(pyStr).join(" ")), null));
  const R: Run = { steps: 0, max: opts.maxSteps ?? 200_000, depth: 0 };
  try {
    execBlock(prog, sc, R, { e: null });
  } catch (f) {
    if (f instanceof Flow && f.kind === "return") return f.v;
    if (f instanceof Flow) throw new PyError(`"${f.kind}" outside a loop`);
    throw f;
  }
  return null;
}

/** A function library: Python code with def's (and constants). Returns the names it defines. */
export interface PyLibrary {
  names: PyScope;
  funcs: { name: string; sig: string; doc: string }[];
  error: string | null;
}
export function loadLibrary(code: string, base: PyScope = {}): PyLibrary {
  const sc: PyScope = Object.create(base);
  try {
    execBlock(parseCode(code), sc, { steps: 0, max: 200_000, depth: 0 }, { e: null });
  } catch (e) {
    const names = Object.fromEntries(Object.entries(sc));
    return { names, funcs: funcsOf(names), error: e instanceof Flow ? `"${e.kind}" outside a function` : (e as Error).message };
  }
  const names = Object.fromEntries(Object.entries(sc));
  return { names, funcs: funcsOf(names), error: null };
}
const funcsOf = (names: PyScope) =>
  Object.values(names).filter((v): v is PyFunc => v instanceof PyFunc).map((f) => ({ name: f.name, sig: f.sig ?? `${f.name}(…)`, doc: f.doc ?? "" }));

/** Names a piece of code reads from outside (identifiers, minus variables the code assigns itself). */
export function codeNames(src: string): Set<string> {
  const out = new Set<string>();
  const own = new Set<string>();
  for (const l of logicalLines(src)) {
    try {
      const toks = tokenize(l.text);
      // assignment targets (a = …, a, b = …, a += …) and loop variables are the code's own
      const eqAt = toks.findIndex((t) => t.t === "op" && ["=", "+=", "-=", "*=", "/="].includes(t.v));
      if (eqAt > 0 && toks.slice(0, eqAt).every((t) => t.t === "name" || (t.t === "op" && t.v === ","))) toks.slice(0, eqAt).forEach((t) => t.t === "name" && own.add(t.v));
      if (toks[0]?.v === "for") for (const t of toks.slice(1)) {
        if (t.t === "name" && t.v === "in") break;
        if (t.t === "name") own.add(t.v);
      }
      for (const t of toks) if (t.t === "name") out.add(t.v);
      for (const m of l.text.matchAll(/\{([A-Za-z_]\w*)/g)) out.add(m[1]);
    } catch {
      /* ignore */
    }
  }
  for (const n of own) out.delete(n);
  return out;
}

/** Run code and convert the returned value to cell text (None → ""). */
export function runCode(src: string, scope: PyScope, log?: (s: string) => void): string {
  const v = execCode(src, scope, { log });
  return v === null ? "" : pyStr(v);
}
