/**
 * Search in a PDF viewer (Edit part → document preview → full-window viewer).
 *  - "text": literal text; `*` any characters, `?` one character (glob); `|` separates alternatives; `"…"` literal.
 *  - "regex": Python `re` syntax — `(?P<name>…)`, `(?P=name)`, `\A`, `\Z`, leading inline flags `(?i)`, `(?s)`, `(?m)`.
 * Options: match case, whole word.
 */
export type PdfSearchMode = "text" | "regex";
export interface PdfSearchOpts { mode: PdfSearchMode; matchCase: boolean; wholeWord: boolean }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function globTerm(t: string): string {
  t = t.trim();
  if (/^".*"$/.test(t) && t.length >= 2) return esc(t.slice(1, -1));
  let re = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && i + 1 < t.length) re += esc(t[++i]);
    else if (c === "*") re += "[^\\n]*?";
    else if (c === "?") re += ".";
    else re += esc(c);
  }
  return re;
}

/** Python `re` pattern → JavaScript RegExp source and flags (throws a readable error for unsupported syntax). */
export function pyRegexToJs(src: string): { source: string; flags: string } {
  let s = src;
  let flags = "";
  const lead = /^\(\?([aiLmsux]+)\)/.exec(s);
  if (lead) {
    if (/[Lx]/.test(lead[1])) throw new Error("Inline flags (?x) / (?L) are not supported");
    if (lead[1].includes("i")) flags += "i";
    if (lead[1].includes("s")) flags += "s";
    if (lead[1].includes("m")) flags += "m";
    s = s.slice(lead[0].length);
  }
  s = s.replace(/\(\?P<([A-Za-z_]\w*)>/g, "(?<$1>").replace(/\(\?P=([A-Za-z_]\w*)\)/g, "\\k<$1>").replace(/\\A/g, "^").replace(/\\Z/g, "$");
  return { source: s, flags };
}

/** Compiled search (global RegExp), null for an empty query, or { error }. */
export function compilePdfSearch(q: string, o: PdfSearchOpts): RegExp | null | { error: string } {
  if (!q.trim()) return null;
  try {
    let source: string;
    let flags = "g";
    if (o.mode === "regex") {
      const r = pyRegexToJs(q);
      source = r.source;
      flags += r.flags;
    } else {
      // Alternatives outside quotes.
      const parts: string[] = [];
      let cur = "", inQ = false;
      for (let i = 0; i < q.length; i++) {
        const c = q[i];
        if (c === '"') inQ = !inQ;
        if (c === "|" && !inQ) (parts.push(cur), (cur = ""));
        else cur += c;
      }
      parts.push(cur);
      source = parts.map(globTerm).filter(Boolean).join("|");
      if (!source) return null;
    }
    if (o.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
    if (!o.matchCase && !flags.includes("i")) flags += "i";
    const re = new RegExp(source, `${flags}u`);
    if (re.test("")) return { error: "The pattern matches empty text — make it more specific" };
    re.lastIndex = 0;
    return re;
  } catch (e) {
    return { error: (e as Error).message.replace(/^Invalid regular expression: /, "") };
  }
}

/** Matches of a compiled search in a text: [start, end) spans. */
export function searchSpans(re: RegExp, text: string, max = 500): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < max) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}
