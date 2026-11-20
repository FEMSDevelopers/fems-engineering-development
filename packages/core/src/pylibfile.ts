/** Export / import file of Python function libraries (JSON editor → 5 Functions). */

export const PYLIB_FORMAT = "fpl-function-libraries";

export interface PyLibFileEntry {
  name: string;
  /** Version the library was exported from, e.g. "1.003" (informative). */
  version?: string | null;
  notes?: string;
  code: string;
  /** Signatures of the functions it defines (informative). */
  functions?: string[];
  /** "Try it" expressions saved with the library. */
  tries?: string[];
}
export interface PyLibFile {
  format: typeof PYLIB_FORMAT;
  formatVersion: 1;
  app: "fractal-pointlist";
  exportedAt: string;
  libraries: PyLibFileEntry[];
}

const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");

/**
 * Local-time stamp `YYYYDDMM_HHMMSSssss` (year, day, month; hours, minutes, seconds and
 * ten-thousandths of a second). `ms` is a millisecond epoch time and may carry a fraction.
 */
export function exportStamp(ms: number): string {
  const d = new Date(Math.floor(ms));
  const frac = Math.min(9999, Math.floor((((ms % 1000) + 1000) % 1000) * 10));
  return `${d.getFullYear()}${p(d.getDate())}${p(d.getMonth() + 1)}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(frac, 4)}`;
}
/** File name of an export: Jsoneditor_export_YYYYDDMM_HHMMSSssss.json */
export const exportFileName = (ms: number) => `Jsoneditor_export_${exportStamp(ms)}.json`;

export function makeLibFile(libraries: PyLibFileEntry[], now = new Date()): PyLibFile {
  return { format: PYLIB_FORMAT, formatVersion: 1, app: "fractal-pointlist", exportedAt: now.toISOString(), libraries };
}

/**
 * Read an export file. Accepts this format, a single `{name, code}` object, an array of them,
 * or plain Python source (.py), which becomes one library named after the file.
 */
export function parseLibFile(text: string, fileName = "library.py"): { libraries: PyLibFileEntry[]; error?: string } {
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "Imported library";
  const t = text.replace(/^﻿/, "");
  if (!/^\s*[[{]/.test(t)) {
    if (!t.trim()) return { libraries: [], error: "The file is empty." };
    return { libraries: [{ name: stem, code: t.replace(/\r\n?/g, "\n") }] };
  }
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch (e) {
    return { libraries: [], error: `Not valid JSON: ${(e as Error).message}` };
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { libraries?: unknown }).libraries)
      ? (data as { libraries: unknown[] }).libraries
      : [data];
  const libraries: PyLibFileEntry[] = [];
  const bad: number[] = [];
  list.forEach((x, i) => {
    const o = x as Partial<PyLibFileEntry> | null;
    if (!o || typeof o !== "object" || typeof o.code !== "string") return bad.push(i + 1);
    libraries.push({
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : `${stem} ${i + 1}`,
      version: typeof o.version === "string" ? o.version : null,
      notes: typeof o.notes === "string" ? o.notes : "",
      code: o.code.replace(/\r\n?/g, "\n"),
      functions: Array.isArray(o.functions) ? o.functions.filter((f): f is string => typeof f === "string") : undefined,
      ...(Array.isArray(o.tries) ? { tries: o.tries.filter((f): f is string => typeof f === "string") } : {}),
    });
  });
  if (!libraries.length) return { libraries, error: `No function library found (expected "libraries": [{ "name", "code" }]).` };
  return { libraries, error: bad.length ? `Skipped entr${bad.length === 1 ? "y" : "ies"} ${bad.join(", ")} (no "code").` : undefined };
}
