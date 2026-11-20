/**
 * Fill the master parts list from an OEM product page or datasheet: turn HTML into text (keeping table rows as
 * "label: value" lines and schema.org Product data), then read general, mechanical, power and specification values.
 * Every value is a proposal the user reviews; nothing is applied blindly.
 */
import type { CustomFieldDef, Part } from "./bom.js";
import { suggestSpecs, type SpecValue } from "./specs.js";

export interface PageText {
  title: string;
  text: string;
  /** schema.org Product fields when the page has JSON-LD. */
  product: Record<string, string>;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", deg: "°", plusmn: "±", times: "×", micro: "µ", ohm: "Ω", reg: "®", trade: "™" };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });

export function htmlToText(html: string): PageText {
  const product: Record<string, string> = {};
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      const list: unknown[] = Array.isArray(j) ? j : j["@graph"] ?? [j];
      for (const o of list as Record<string, unknown>[]) {
        const t = o?.["@type"];
        if (!(t === "Product" || (Array.isArray(t) && t.includes("Product")))) continue;
        const brand = o.brand as { name?: string } | string | undefined;
        const w = o.weight as { value?: unknown; unitCode?: string; unitText?: string } | undefined;
        Object.assign(product, Object.fromEntries(Object.entries({
          name: o.name, description: o.description, sku: o.sku, mpn: o.mpn, brand: typeof brand === "string" ? brand : brand?.name,
          weight: w ? `${w.value} ${w.unitText ?? w.unitCode ?? ""}` : undefined,
        }).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, decode(String(v)).trim()])));
      }
    } catch {
      /* not JSON */
    }
  }
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const meta = decode(html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? "");
  let b = html
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  // Table rows → "cell: cell | cell"; definition lists → "dt: dd".
  b = b.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) => {
    const cells = [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => c[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
    return `\n${cells.length >= 2 ? `${cells[0]}: ${cells.slice(1).join(" | ")}` : cells.join(" ")}\n`;
  });
  b = b.replace(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi, (_, a: string, c: string) => `\n${a.replace(/<[^>]+>/g, " ").trim()}: ${c.replace(/<[^>]+>/g, " ").trim()}\n`);
  b = b.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/dd|\/dt)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ");
  const text = decode(b).split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text: [meta, text].filter(Boolean).join("\n"), product };
}

export type ScrapeTarget =
  | { kind: "part"; key: "description" | "series" | "sku" | "manufacturer" | "oemDesc" | "notes" | "configCode1" | "configCode2" | "configCode3" }
  | { kind: "mech"; key: "widthMm" | "heightMm" | "depthMm" | "weightKg" | "rackUnits" | "mount" | "dinWidthMm" }
  | { kind: "powerIn"; key: "kind" | "voltage" | "range" | "watts" | "amps" }
  | { kind: "custom"; key: string };
/** Longer descriptions go to the OEM desc field. */
export const DESC_MAX = 120;
export interface ScrapeHit {
  target: ScrapeTarget;
  label: string;
  value: SpecValue;
  /** Text the value was read from. */
  from: string;
  /** Guessed from free text (not a labelled value): never pre-selected, never used by bulk fill. */
  weak?: boolean;
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const toNum = (s: string) => Number(s.replace(",", "."));
const LEN: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4, '"': 25.4, "″": 25.4 };
const r1 = (n: number) => Math.round(n * 10) / 10;

function findLine(lines: string[], re: RegExp): { m: RegExpMatchArray; line: string } | null {
  for (const line of lines) {
    const m = line.match(re);
    if (m) return { m, line };
  }
  return null;
}

/** Read values from page / datasheet text. Spec fields come from the subcategory definition. */
export function extractPartData(page: PageText, part: Pick<Part, "partNumber" | "manufacturer" | "description" | "series">, fields: CustomFieldDef[] = []): ScrapeHit[] {
  const hits: ScrapeHit[] = [];
  const add = (target: ScrapeTarget, label: string, value: SpecValue | null | undefined, from: string) => {
    if (value == null || value === "" || (typeof value === "number" && !Number.isFinite(value))) return;
    if (hits.some((h) => h.target.kind === target.kind && h.target.key === target.key)) return;
    hits.push({ target, label, value, from: from.slice(0, 160) });
  };
  const text = page.text;
  const lines = text.split("\n");
  const P = page.product;

  // General
  const desc = (P.description || P.name || "").replace(/\s+/g, " ").trim();
  // A short description is the BOM description of the part number; long text goes to "OEM desc".
  if (desc.length > 8 && desc.length <= DESC_MAX) add({ kind: "part", key: "description" }, "Description", desc, P.description ? "description" : "product name");
  if (P.oemDesc) add({ kind: "part", key: "oemDesc" }, "OEM desc", P.oemDesc.replace(/\s+/g, " ").trim().slice(0, 4000), "long text cell of the table row");
  if (desc.length > DESC_MAX) add({ kind: "part", key: "oemDesc" }, "OEM desc", desc.slice(0, 4000), "long description text");
  if (P.name && P.description && P.name.length > 8 && P.name.length <= DESC_MAX && desc.length > DESC_MAX) add({ kind: "part", key: "description" }, "Description", P.name, "product name");
  if (P.brand) add({ kind: "part", key: "manufacturer" }, "Manufacturer", P.brand, "schema.org Product");
  if (P.sku && P.sku !== part.partNumber) add({ kind: "part", key: "sku" }, "SKU", P.sku, "schema.org Product");
  const ser = findLine(lines, /^(?:product\s+)?(?:series|product family|family|product line)\s*[:|]\s*(.+)$/i);
  if (ser) add({ kind: "part", key: "series" }, "Product series", ser.m[1].split("|")[0].trim().slice(0, 60), ser.line);
  const ord = findLine(lines, /^(?:sku|order(?:ing)? (?:no|number|code)\.?|catalog(?:ue)? (?:no|number)\.?|item (?:no|number)\.?)\s*[:|]\s*([\w./-]+)/i);
  if (ord && ord.m[1] !== part.partNumber) add({ kind: "part", key: "sku" }, "SKU", ord.m[1], ord.line);

  // Dimensions: "W x H x D: 40 x 130 x 125 mm" (also 1.57 x 5.12 x 4.92 in).
  const tri = findLine(lines, new RegExp(String.raw`(?:dimensions?|size)[^:\n]*?(?:\(([WHDLwhdl])\s*[x×]\s*([WHDLwhdl])\s*[x×]\s*([WHDLwhdl])\))?[^:\n]*[:|]?\s*${NUM}\s*(?:mm|cm|in|")?\s*[x×]\s*${NUM}\s*(?:mm|cm|in|")?\s*[x×]\s*${NUM}\s*(mm|cm|inches|inch|in|"|″)`, "i"));
  if (tri) {
    const f = LEN[tri.m[7].toLowerCase()] ?? 1;
    const v = [tri.m[4], tri.m[5], tri.m[6]].map((x) => r1(toNum(x) * f));
    const order = tri.m[1] ? [tri.m[1], tri.m[2], tri.m[3]].map((x) => x.toUpperCase()) : ["W", "H", "D"];
    const key = { W: "widthMm", H: "heightMm", D: "depthMm", L: "depthMm" } as const;
    order.forEach((o, i) => add({ kind: "mech", key: key[o as keyof typeof key] }, `${o === "W" ? "Width" : o === "H" ? "Height" : "Depth"} (mm)`, v[i], tri.line));
  }
  for (const [k, lab, re] of [
    ["widthMm", "Width (mm)", /^width\b[^:\n]*[:|]?\s*/i],
    ["heightMm", "Height (mm)", /^height\b[^:\n]*[:|]?\s*/i],
    ["depthMm", "Depth (mm)", /^(?:depth|length)\b[^:\n]*[:|]?\s*/i],
  ] as const) {
    const h = findLine(lines, new RegExp(re.source + String.raw`${NUM}\s*(mm|cm|inches|inch|in|"|″)`, "i"));
    if (h) add({ kind: "mech", key: k }, lab, r1(toNum(h.m[1]) * (LEN[h.m[2].toLowerCase()] ?? 1)), h.line);
  }
  const wt = (P.weight ? [{ line: P.weight, m: P.weight.match(new RegExp(String.raw`${NUM}\s*(kg|kgm|g|grm|lb|lbs|lbr|oz)`, "i")) }] : [])
    .concat([findLine(lines, new RegExp(String.raw`(?:net\s+)?weight\b[^:\n]*[:|]?\s*${NUM}\s*(kg|g|lbs?|oz)\b`, "i"))].filter(Boolean) as { line: string; m: RegExpMatchArray }[])
    .find((x) => x.m);
  if (wt?.m) {
    const u = wt.m[2].toLowerCase();
    const f = u.startsWith("kg") ? 1 : u === "g" || u === "grm" ? 0.001 : u.startsWith("lb") ? 0.4536 : 0.02835;
    add({ kind: "mech", key: "weightKg" }, "Weight (kg)", Math.round(toNum(wt.m[1]) * f * 1000) / 1000, wt.line);
  }
  const ru = findLine(lines, /\b(\d{1,2})\s*(?:U|RU)\b(?:\s*(?:rack|height|form factor|high))?/);
  if (ru && /rack|height|form factor|\bRU\b|\d\s*U\s+high/i.test(ru.line)) add({ kind: "mech", key: "rackUnits" }, "Rack units", Number(ru.m[1]), ru.line);
  if (/\bDIN[- ]?rail\b|\bTS ?35\b|EN 60715/i.test(text)) add({ kind: "mech", key: "mount" }, "Mounting", "din", (text.match(/.{0,40}(DIN[- ]?rail|TS ?35|EN 60715).{0,40}/i) ?? [""])[0]);
  else if (/19["″]?\s*(?:inch\s*)?rack|rack[- ]mount/i.test(text)) add({ kind: "mech", key: "mount" }, "Mounting", "rack", (text.match(/.{0,40}(19["″]?\s*(?:inch\s*)?rack|rack[- ]mount).{0,40}/i) ?? [""])[0]);

  // Power input
  const vin = findLine(lines, new RegExp(String.raw`(?:input|supply|nominal|operating|rated)\s*(?:voltage|volt)[^:\n]*[:|]?\s*(${NUM}\s*(?:V\s*(?:AC|DC)?)?\s*(?:\.\.\.|…|-|–|to)\s*${NUM}\s*V\s*(AC|DC|~|=)?|${NUM}\s*V\s*(AC|DC|~|=)?)`, "i"));
  if (vin) {
    const raw = vin.m[1].replace(/\s+/g, " ").trim();
    add({ kind: "powerIn", key: "range" }, "Input range", raw, vin.line);
    const nums = [...raw.matchAll(/\d+(?:[.,]\d+)?/g)].map((x) => toNum(x[0]));
    const nominal = nums.length === 1 ? nums[0] : [24, 48, 120, 230, 208, 240, 277, 125, 12].find((n) => n >= nums[0] && n <= nums[nums.length - 1]) ?? nums[0];
    add({ kind: "powerIn", key: "voltage" }, "Nominal V", nominal, vin.line);
    const kind = /AC|~/i.test(raw) ? "AC1" : /DC|=/i.test(raw) ? "DC" : "";
    if (kind) add({ kind: "powerIn", key: "kind" }, "Input type", kind, vin.line);
  }
  const pw = findLine(lines, new RegExp(String.raw`(?:max(?:imum)?\.?\s*)?(?:power consumption|power dissipation|consumption|input power|power draw)[^:\n]*[:|]?\s*(?:max\.?\s*)?(?:typ\.?\s*)?${NUM}\s*W\b`, "i"));
  if (pw) add({ kind: "powerIn", key: "watts" }, "Max power (W)", toNum(pw.m[1]), pw.line);
  const ia = findLine(lines, new RegExp(String.raw`(?:input|current consumption|supply)\s*current[^:\n]*[:|]?\s*(?:max\.?\s*)?${NUM}\s*(m?A)\b`, "i"));
  if (ia) add({ kind: "powerIn", key: "amps" }, "Input current (A)", toNum(ia.m[1]) / (ia.m[2] === "mA" ? 1000 : 1), ia.line);

  // Specification fields: "Label: value" lines first, then the description-style reader.
  const norm = (s: string) => s.toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  for (const f of fields) {
    if (f.type === "certs") continue;
    const lab = norm(f.label);
    if (lab.length < 3) continue;
    const hit = lines.find((l) => {
      const i = l.indexOf(":");
      return i > 0 && norm(l.slice(0, i)) === lab;
    });
    if (!hit) continue;
    const raw = hit.slice(hit.indexOf(":") + 1).split("|")[0].trim();
    let v: SpecValue | null = raw;
    if (f.type === "number") v = raw.match(/-?\d+(?:[.,]\d+)?/) ? toNum(raw.match(/-?\d+(?:[.,]\d+)?/)![0]) : null;
    else if (f.type === "bool") v = /^(yes|true|✓|x|available|supported)/i.test(raw) ? true : /^(no|false|–|-|none|n\/a)/i.test(raw) ? false : null;
    else if (f.type === "range") {
      const n = [...raw.matchAll(/-?\d+(?:[.,]\d+)?/g)].map((x) => toNum(x[0]));
      v = n.length >= 2 ? [n[0], n[1]] : null;
    } else if (f.type === "select") v = f.options?.find((o) => raw.toLowerCase().includes(o.toLowerCase())) ?? null;
    else if (f.type === "multi") {
      const l = f.options?.filter((o) => raw.toLowerCase().includes(o.toLowerCase())) ?? [];
      v = l.length ? l : null;
    }
    if (v != null) add({ kind: "custom", key: f.key }, f.label, v, hit);
  }
  // Operating / storage temperature ranges (range fields named so), also when written as a heading line followed by
  // "minimum … °C" / "maximum … °C" lines (Siemens: "ambient temperature during operation" · "● minimum -25 °C").
  const temps = extractTemps(lines);
  for (const f of fields) {
    if (f.type !== "range") continue;
    const lab = `${f.key} ${f.label}`.toLowerCase();
    if (!/temp/.test(lab)) continue;
    const t = /stor|transport/.test(lab) ? temps.storage : /oper|ambient|working|service/.test(lab) ? temps.oper : null;
    if (t) add({ kind: "custom", key: f.key }, f.label, t.v, t.line);
  }
  const s = suggestSpecs(fields, `${desc}\n${text}`.slice(0, 60000), part.partNumber);
  for (const [k, v] of Object.entries(s)) {
    add({ kind: "custom", key: k }, fields.find((f) => f.key === k)?.label ?? k, v, "guessed from the text — check");
    const h = hits[hits.length - 1];
    if (h?.target.kind === "custom" && h.target.key === k && h.from.startsWith("guessed")) h.weak = true;
  }
  return hits;
}

/** Apply chosen hits to a part draft. */
export function applyHits<T extends Pick<Part, "description" | "series" | "manufacturer" | "mech" | "powerIn" | "custom"> & { sku?: string; oemDesc?: string; notes?: string }>(p: T, hits: ScrapeHit[], emptyPowerIn: () => NonNullable<Part["powerIn"]>): T {
  const out: T = { ...p, mech: { ...p.mech }, custom: { ...p.custom } };
  for (const h of hits) {
    const t = h.target;
    if (t.kind === "part") (out as Record<string, unknown>)[t.key] = String(h.value);
    else if (t.kind === "mech") (out.mech as unknown as Record<string, unknown>)[t.key] = h.value;
    else if (t.kind === "powerIn") out.powerIn = { ...(out.powerIn ?? emptyPowerIn()), [t.key]: h.value };
    else (out.custom as Record<string, unknown>)[t.key] = h.value;
  }
  return out;
}

/** Current value of a hit's target on a part (for the review table). */
export function currentOf(p: Pick<Part, "description" | "series" | "manufacturer" | "mech" | "powerIn" | "custom"> & { sku?: string; oemDesc?: string; notes?: string }, t: ScrapeTarget): unknown {
  if (t.kind === "part") return (p as Record<string, unknown>)[t.key];
  if (t.kind === "mech") return (p.mech as unknown as Record<string, unknown>)[t.key];
  if (t.kind === "powerIn") return p.powerIn ? (p.powerIn as unknown as Record<string, unknown>)[t.key] : null;
  return (p.custom as Record<string, unknown>)[t.key];
}

// ───────── catalogs / flyers: one table row per part number ─────────

/** Split a text line back into table cells ("a: b | c" from tables, or runs of 2+ spaces / tabs). */
export function lineCells(line: string): string[] {
  const i = line.indexOf(": ");
  const cells = i > 0 && line.includes(" | ") ? [line.slice(0, i), ...line.slice(i + 2).split(" | ")] : line.split(/\s*\|\s*|\t+|\s{2,}/);
  return cells.map((c) => c.trim()).filter((c) => c !== "");
}
const normPn = (s: string) => s.toUpperCase().replace(/[\s\-_./]+/g, "");
const isHeaderish = (cells: string[]) => cells.length >= 2 && cells.filter((c) => /[A-Za-z]/.test(c) && !/\d/.test(c)).length >= Math.ceil(cells.length * 0.7);

export interface CatalogRow {
  /** Line number in the text. */
  at: number;
  cells: string[];
  headers: string[] | null;
  /** Cells longer than a short value (descriptions, notes with the information in prose). */
  long: string[];
}
/** Table rows that mention a part number (or SKU / order code), with the header row found above each. */
export function findCatalogRows(text: string, pn: string): CatalogRow[] {
  const key = normPn(pn);
  if (key.length < 3) return [];
  const lines = text.split("\n");
  const out: CatalogRow[] = [];
  lines.forEach((l, at) => {
    if (!normPn(l).includes(key)) return;
    const cells = lineCells(l);
    if (cells.length < 2 && l.length < 60) return;
    let headers: string[] | null = null;
    for (let k = at - 1; k >= Math.max(0, at - 60); k--) {
      const h = lineCells(lines[k]);
      if (h.length >= Math.max(2, cells.length - 1) && h.length <= cells.length + 1 && isHeaderish(h) && !normPn(lines[k]).includes(key)) {
        headers = h;
        break;
      }
    }
    out.push({ at, cells, headers, long: cells.filter((c) => c.length > 40) });
  });
  return out;
}
/** Text for extractPartData from one catalog row: "header: value" lines plus the long cells (and the rest of the row). */
export function catalogRowText(r: CatalogRow): PageText {
  const lines: string[] = [];
  if (r.headers) {
    // Align from the right when the row has one more / fewer cell than the header (merged first column).
    const off = r.cells.length - r.headers.length;
    r.headers.forEach((h, i) => {
      const v = r.cells[i + Math.max(0, off)];
      if (v && h) lines.push(`${h}: ${v}`);
    });
  }
  lines.push(...r.long);
  lines.push(r.cells.join(" "));
  const desc = [...r.long].sort((a, b) => b.length - a.length)[0];
  // Short description of the part number: a "Description / Type / Designation" column when the table has one.
  const di = r.headers?.findIndex((h) => /^(description|designation|product description|type|name)$/i.test(h.trim())) ?? -1;
  const off = r.headers ? Math.max(0, r.cells.length - r.headers.length) : 0;
  const short = di >= 0 ? r.cells[di + off] : undefined;
  // Long cells are OEM text (OEM desc); the short description column (or type) is the description of the part number.
  const product: Record<string, string> = {};
  if (desc) product.oemDesc = desc;
  if (short && short !== desc) product.description = short;
  return { title: "", text: lines.join("\n"), product };
}

/** Every field a scraped value can be stored in (to correct a wrong automatic allocation). */
export function scrapeTargets(fields: CustomFieldDef[] = []): { target: ScrapeTarget; label: string; group: string }[] {
  const T = (target: ScrapeTarget, label: string, group: string) => ({ target, label, group });
  return [
    T({ kind: "part", key: "description" }, "Description", "General"), T({ kind: "part", key: "oemDesc" }, "OEM desc", "General"),
    T({ kind: "part", key: "notes" }, "Notes", "General"), T({ kind: "part", key: "series" }, "Product series", "General"),
    T({ kind: "part", key: "manufacturer" }, "Manufacturer", "General"), T({ kind: "part", key: "sku" }, "SKU", "Configuration"),
    T({ kind: "part", key: "configCode1" }, "Configuration code #1", "Configuration"), T({ kind: "part", key: "configCode2" }, "Configuration code #2", "Configuration"),
    T({ kind: "part", key: "configCode3" }, "Configuration code #3", "Configuration"),
    T({ kind: "mech", key: "widthMm" }, "Width (mm)", "Mechanical"), T({ kind: "mech", key: "heightMm" }, "Height (mm)", "Mechanical"), T({ kind: "mech", key: "depthMm" }, "Depth (mm)", "Mechanical"),
    T({ kind: "mech", key: "weightKg" }, "Weight (kg)", "Mechanical"), T({ kind: "mech", key: "rackUnits" }, "Rack units", "Mechanical"), T({ kind: "mech", key: "dinWidthMm" }, "DIN width (mm)", "Mechanical"),
    T({ kind: "mech", key: "mount" }, "Mounting", "Mechanical"),
    T({ kind: "powerIn", key: "kind" }, "Input type", "Power feed"), T({ kind: "powerIn", key: "voltage" }, "Nominal V", "Power feed"), T({ kind: "powerIn", key: "range" }, "Input range", "Power feed"),
    T({ kind: "powerIn", key: "watts" }, "Max power (W)", "Power feed"), T({ kind: "powerIn", key: "amps" }, "Input current (A)", "Power feed"),
    ...fields.filter((f) => f.type !== "certs").map((f) => T({ kind: "custom", key: f.key }, `${f.label}${f.unit ? ` (${f.unit})` : ""}`, `Spec · ${f.group || "Specifications"}`)),
  ];
}
export const targetKey = (t: ScrapeTarget) => `${t.kind}.${t.key}`;
/** Convert a value for a different target (numbers for numeric fields, text otherwise). */
export function retarget(h: ScrapeHit, to: ScrapeTarget, fields: CustomFieldDef[] = []): ScrapeHit {
  const numeric = to.kind === "mech" ? to.key !== "mount" : to.kind === "powerIn" ? to.key !== "kind" && to.key !== "range" : to.kind === "custom" ? fields.find((f) => f.key === to.key)?.type === "number" : false;
  let value: SpecValue = h.value;
  if (numeric && typeof value !== "number") {
    const m = String(value).match(/-?\d+(?:[.,]\d+)?/);
    value = m ? Number(m[0].replace(",", ".")) : value;
  } else if (!numeric && typeof value !== "string" && to.kind !== "custom") value = Array.isArray(value) ? value.join(", ") : String(value);
  const label = scrapeTargets(fields).find((x) => targetKey(x.target) === targetKey(to))?.label ?? to.key;
  return { ...h, target: to, value, label };
}

const TEMP_N = String.raw`([-−–+]?\s?\d+(?:[.,]\d+)?)`;
const tnum = (s: string) => Number(s.replace(/[−–]/g, "-").replace(/\s/g, "").replace(",", "."));
const toC = (n: number, u: string) => (/f/i.test(u) ? Math.round(((n - 32) * 5) / 9 * 10) / 10 : n);
/**
 * Operating and storage temperature ranges (°C; °F converted) from datasheet text: "Operating temperature: -25 … +55 °C",
 * "Storage temperature -40 to 75 °C", or a heading ("ambient temperature during operation") followed within a few lines by
 * "minimum -25 °C" and "maximum 55 °C".
 */
export function extractTemps(lines: string[]): { oper: { v: [number, number]; line: string } | null; storage: { v: [number, number]; line: string } | null } {
  const out: ReturnType<typeof extractTemps> = { oper: null, storage: null };
  const kindOf = (l: string) => (/temp/i.test(l) ? (/stor|transport/i.test(l) ? "storage" : /operat|ambient|working|service|use/i.test(l) ? "oper" : null) : null);
  const one = new RegExp(String.raw`${TEMP_N}\s*°?\s*([CF])?\s*(?:\.\.\.|…|to|bis|-|–|—|/|~)\s*${TEMP_N}\s*°\s*([CF])`, "i");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const k = kindOf(l);
    if (!k || out[k]) continue;
    const m = l.match(one);
    if (m) {
      const u = m[4] || m[2] || "C";
      const a = toC(tnum(m[1]), m[2] || u), b = toC(tnum(m[3]), u);
      out[k] = { v: [Math.min(a, b), Math.max(a, b)], line: l };
      continue;
    }
    // Heading, then "minimum" / "maximum" lines.
    let lo: number | null = null, hi: number | null = null;
    const used = [l];
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      const x = lines[j];
      if (j > i + 1 && kindOf(x)) break;
      const mm = x.match(new RegExp(String.raw`\b(min(?:imum)?|max(?:imum)?)\b[^\d−–+-]*${TEMP_N}\s*°\s*([CF])`, "i"));
      if (!mm) continue;
      const v = toC(tnum(mm[2]), mm[3]);
      if (/^min/i.test(mm[1])) lo = v;
      else hi = v;
      used.push(x);
    }
    if (lo != null && hi != null) out[k] = { v: [lo, hi], line: used.join(" · ") };
  }
  return out;
}
