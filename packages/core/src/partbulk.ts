/**
 * Bulk update of master parts: a set of field = value assignments applied to many parts, either overwriting existing
 * values or filling empty fields only.
 */
import { MOUNT_TYPES, type CustomFieldDef, type Part, type PartMech, type Subcategory } from "./bom.js";
import { isEmptySpec, type SpecValue } from "./specs.js";

export type BulkKind = "text" | "number" | "status" | "mount" | "sub" | "bool";
export interface BulkField {
  key: string;
  label: string;
  group: string;
  kind: BulkKind;
}
type Mechk = "rackUnits" | "widthMm" | "heightMm" | "depthMm" | "dinWidthMm" | "weightKg" | "addXMm" | "addYMm" | "addZMm";
const TEXT: [keyof Part, string, string][] = [
  ["category", "Category", "General"], ["manufacturer", "Manufacturer", "General"], ["series", "Product series", "General"], ["description", "Description", "General"],
  ["oemDesc", "OEM description", "General"], ["notes", "Notes", "General"], ["tagPrefix", "Tag prefix", "General"],
  ["sku", "SKU", "Configuration"], ["configCode1", "Configuration code #1", "Configuration"], ["configCode2", "Configuration code #2", "Configuration"], ["configCode3", "Configuration code #3", "Configuration"],
  ["vendor", "Vendor", "Purchasing"], ["vendorContact", "Vendor contact", "Purchasing"],
];
const NUM: [keyof Part, string][] = [["price", "Unit price"], ["stock", "In stock"], ["onOrder", "On order"]];
const MECH: [Mechk, string][] = [
  ["rackUnits", "Rack U"], ["dinWidthMm", "DIN width (mm)"], ["widthMm", "Width x (mm)"], ["heightMm", "Height y (mm)"], ["depthMm", "Depth z (mm)"], ["weightKg", "Weight (kg)"],
  ["addXMm", "Adder x (mm)"], ["addYMm", "Adder y (mm)"], ["addZMm", "Adder z (mm)"],
];
/** Fields of a part that can be bulk-updated (specification fields are added per key: `spec:<key>`). */
export const BULK_FIELDS: BulkField[] = [
  { key: "subcategoryId", label: "Subcategory (sets its category)", group: "General", kind: "sub" },
  ...TEXT.map(([k, l, g]) => ({ key: String(k), label: l, group: g, kind: "text" as const })),
  { key: "status", label: "Status", group: "General", kind: "status" },
  ...NUM.map(([k, l]) => ({ key: String(k), label: l, group: "Purchasing", kind: "number" as const })),
  { key: "mech.mount", label: "Mounting", group: "Mechanical", kind: "mount" },
  ...MECH.map(([k, l]) => ({ key: `mech.${k}`, label: l, group: "Mechanical", kind: "number" as const })),
  { key: "mech.fullDepth", label: "Full depth (front and rear)", group: "Mechanical", kind: "bool" },
  { key: "mech.useViews", label: "Draw 2D views in layouts", group: "Mechanical", kind: "bool" },
];
export const MOUNT_KEYS = MOUNT_TYPES.map(([k]) => k);

/** Specification field definitions by key (union over subcategories; the part's own subcategory wins). */
export function specDefs(subcats: Iterable<Subcategory>): Map<string, CustomFieldDef> {
  const m = new Map<string, CustomFieldDef>();
  for (const s of subcats) for (const f of s.fields) if (!m.has(f.key)) m.set(f.key, f);
  return m;
}

export interface BulkSet {
  key: string;
  /** Typed in the dialog; "" with overwrite clears the field. */
  value: string;
}
const empty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && (v.length === 0 || v.every((x) => x == null || x === "")));
function parseNum(v: string): number | null | "bad" {
  const t = v.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : "bad";
}
const parseBool = (v: string): boolean | null => (/^\s*$/.test(v) ? null : /^(y|yes|true|1|on|x)$/i.test(v.trim()));
/** Value of a specification field from text (number, yes/no, list "a, b", range "a-b" / "a..b"). */
export function parseSpec(f: CustomFieldDef | undefined, v: string): SpecValue | null | "bad" {
  const t = v.trim();
  if (!t) return null;
  switch (f?.type) {
    case "number": {
      const n = parseNum(t);
      return n;
    }
    case "bool": return parseBool(t);
    case "multi":
    case "certs": return t.split(/\s*[,;]\s*/).filter(Boolean);
    case "range": {
      const m = t.match(/^(-?[\d.]+)?\s*(?:-|–|\.\.|to)\s*(-?[\d.]+)?$/i);
      if (!m) {
        const n = parseNum(t);
        return n === "bad" || n == null ? "bad" : [n, n];
      }
      return [m[1] ? Number(m[1]) : null, m[2] ? Number(m[2]) : null];
    }
    default: return t;
  }
}

export interface BulkResult {
  /** Partial update to send (top-level keys; mech / custom as whole objects). Null when nothing changes. */
  patch: Partial<Part> | null;
  /** Field keys that change. */
  changed: string[];
  /** Field keys skipped (existing value kept in "empty only" mode, or a value that could not be read). */
  skipped: string[];
  errors: string[];
}
/** Apply the assignments to one part. `mode` "empty" only fills fields without a value. */
export function bulkApply(p: Part, sets: BulkSet[], mode: "overwrite" | "empty", subcats: Map<string, Subcategory>): BulkResult {
  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  let mech: PartMech | null = null;
  let custom: Part["custom"] | null = null;
  const defs = specDefs(subcats.values());
  const own = new Map((subcats.get(p.subcategoryId ?? "")?.fields ?? []).map((f) => [f.key, f]));
  const put = (key: string, cur: unknown, next: unknown, write: () => void) => {
    if (mode === "empty" && !empty(cur)) return void skipped.push(key);
    if (JSON.stringify(cur ?? null) === JSON.stringify(next ?? null) || (empty(cur) && empty(next))) return;
    write();
    changed.push(key);
  };
  for (const s of sets) {
    const k = s.key;
    if (k.startsWith("spec:")) {
      const sk = k.slice(5);
      const f = own.get(sk) ?? defs.get(sk);
      const v = parseSpec(f, s.value);
      if (v === "bad") { errors.push(`${f?.label ?? sk}: “${s.value}” is not a valid ${f?.type ?? "value"}`); continue; }
      const cur = (custom ?? p.custom ?? {})[sk] as SpecValue | undefined;
      if (mode === "empty" && !isEmptySpec(cur)) { skipped.push(k); continue; }
      put(k, cur, v, () => {
        custom = { ...(custom ?? p.custom ?? {}) };
        if (v == null) delete custom[sk];
        else custom[sk] = v;
      });
      continue;
    }
    if (k.startsWith("mech.")) {
      const mk = k.slice(5) as keyof PartMech;
      const base = mech ?? p.mech;
      const cur = base[mk];
      let v: unknown;
      if (mk === "mount") v = s.value.trim();
      else if (mk === "fullDepth" || mk === "useViews") v = parseBool(s.value);
      else {
        const n = parseNum(s.value);
        if (n === "bad") { errors.push(`${k}: “${s.value}” is not a number`); continue; }
        v = n;
      }
      if (mk === "mount" && v && !MOUNT_KEYS.includes(v as PartMech["mount"])) { errors.push(`Mounting: “${s.value}” is not a mounting type`); continue; }
      put(k, cur, v, () => (mech = { ...base, [mk]: v ?? (mk === "mount" ? "" : null) } as PartMech));
      continue;
    }
    const f = BULK_FIELDS.find((x) => x.key === k);
    if (!f) { errors.push(`Unknown field ${k}`); continue; }
    const cur = (patch[k] !== undefined ? patch[k] : (p as unknown as Record<string, unknown>)[k]);
    if (f.kind === "number") {
      const n = parseNum(s.value);
      if (n === "bad") { errors.push(`${f.label}: “${s.value}” is not a number`); continue; }
      put(k, cur, n, () => (patch[k] = n));
    } else if (f.kind === "status") {
      const v = s.value.trim() || "active";
      if (!["active", "spares", "obsolete"].includes(v)) { errors.push(`Status: “${s.value}”`); continue; }
      put(k, cur, v, () => (patch[k] = v));
    } else if (f.kind === "sub") {
      const v = s.value.trim() || null;
      const sc = v ? subcats.get(v) : undefined;
      if (v && !sc) { errors.push(`Subcategory not found`); continue; }
      put(k, cur, v, () => {
        patch[k] = v;
        if (sc) patch.category = sc.category;
      });
    } else put(k, cur, s.value, () => (patch[k] = s.value));
  }
  if (mech) patch.mech = mech;
  if (custom) patch.custom = custom;
  return { patch: changed.length ? (patch as Partial<Part>) : null, changed, skipped, errors };
}
