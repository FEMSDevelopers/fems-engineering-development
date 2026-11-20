import type { Grid } from "./types.js";

/** Excel-style column letters: 0 → A, 25 → Z, 26 → AA. */
export function colName(j: number): string {
  let s = "";
  let n = j + 1;
  while (n) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Trim trailing empty rows/columns and pad every row to the same width. */
export function normalizeGrid(rows: unknown[][]): Grid {
  let g = rows.map((r) => r.map((v) => (v == null ? "" : String(v))));
  while (g.length && g[g.length - 1].every((v) => v.trim() === "")) g.pop();
  let w = Math.max(0, ...g.map((r) => r.length));
  while (w > 0 && g.every((r) => (r[w - 1] ?? "").trim() === "")) w--;
  g = g.map((r) => {
    const o = r.slice(0, w);
    while (o.length < w) o.push("");
    return o;
  });
  return g;
}

/**
 * Parse text copied from Excel (tab-separated) or CSV/semicolon text.
 * Handles quoted cells with embedded delimiters, quotes and newlines.
 */
export function parseDelimited(input: string): Grid {
  const text = input.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const first = text.split("\n", 1)[0] ?? "";
  const d = first.includes("\t") ? "\t" : first.includes(",") ? "," : first.includes(";") ? ";" : "\t";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  let fresh = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQ = false;
      } else cell += c;
    } else if (c === '"' && fresh) {
      inQ = true;
      fresh = false;
    } else if (c === d) {
      row.push(cell);
      cell = "";
      fresh = true;
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      fresh = true;
    } else {
      cell += c;
      fresh = false;
    }
  }
  row.push(cell);
  rows.push(row);
  return normalizeGrid(rows);
}

/** Serialize a grid as tab-separated text that pastes cleanly into Excel. */
export function toTSV(grid: Grid): string {
  return grid
    .map((r) => r.map((v) => (/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join("\t"))
    .join("\n");
}

/** Serialize a grid as RFC 4180 CSV. */
export function toCSV(grid: Grid): string {
  return grid
    .map((r) => r.map((v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(","))
    .join("\r\n");
}

/** Pick named columns (by header text) out of a grid, keeping row order. Missing columns come out empty. */
export function selectColumns(grid: Grid, names: string[]): { grid: Grid; missing: string[] } {
  const head = grid[0] ?? [];
  const idx = names.map((n) => head.indexOf(n));
  const missing = names.filter((_, i) => idx[i] < 0);
  const out = [names.slice(), ...grid.slice(1).map((r) => idx.map((j) => (j < 0 ? "" : r[j] ?? "")))];
  return { grid: out, missing };
}

export const isBlankRow = (r: string[]) => r.every((v) => String(v).trim() === "");
