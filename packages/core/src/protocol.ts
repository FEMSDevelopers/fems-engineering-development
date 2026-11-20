import { isNum } from "./condition.js";
import { isBlankRow } from "./grid.js";
import { normName } from "./ruleset.js";
import type { Grid } from "./types.js";

export type SourceKind = "modbus" | "dnp3" | "iec104" | "generic";
export const SOURCE_KINDS: Record<SourceKind, string> = {
  modbus: "Modbus TCP point list",
  dnp3: "DNP3 point list",
  iec104: "IEC 60870-5-104 point list",
  generic: "Other table",
};
export const isPointList = (k: string): k is "modbus" | "dnp3" | "iec104" => k === "modbus" || k === "dnp3" || k === "iec104";

export type PointField =
  | "tag" | "description" | "dataType" | "scale" | "units" | "access"
  | "regType" | "address" | "pointType" | "index" | "eventClass" | "typeId" | "ioa";

export interface FieldDef {
  key: PointField;
  label: string;
  required?: boolean;
}

const COMMON: FieldDef[] = [
  { key: "tag", label: "Tag / name", required: true },
  { key: "description", label: "Description" },
  { key: "dataType", label: "Data type" },
  { key: "scale", label: "Scale" },
  { key: "units", label: "Units" },
  { key: "access", label: "Access (R/W)" },
];
const BY_KIND: Record<"modbus" | "dnp3" | "iec104", FieldDef[]> = {
  modbus: [
    { key: "regType", label: "Register type" },
    { key: "address", label: "Register / address", required: true },
  ],
  dnp3: [
    { key: "pointType", label: "Point type", required: true },
    { key: "index", label: "Index", required: true },
    { key: "eventClass", label: "Event class" },
  ],
  iec104: [
    { key: "typeId", label: "Type ID", required: true },
    { key: "ioa", label: "IOA", required: true },
  ],
};
export const fieldsFor = (kind: string): FieldDef[] => (isPointList(kind) ? [...COMMON, ...BY_KIND[kind]] : []);

const SYN: Record<PointField, string[]> = {
  tag: ["tag", "name", "point", "pointname", "signal", "tagname", "label"],
  description: ["description", "desc", "comment"],
  dataType: ["datatype", "type", "format", "dtype"],
  scale: ["scale", "multiplier", "factor", "gain", "scaling"],
  units: ["unit", "units", "eu", "engunits"],
  access: ["access", "rw", "readwrite", "writable", "mode"],
  regType: ["regtype", "registertype", "function", "fc", "table", "objecttype"],
  address: ["register", "address", "addr", "reg", "offset", "registeraddress", "modbusaddress"],
  pointType: ["pointtype", "dnp3type", "objtype", "group"],
  index: ["index", "idx", "pointindex", "dnp3index"],
  eventClass: ["class", "eventclass"],
  typeId: ["typeid", "asdutype", "ti", "asdu", "iectype"],
  ioa: ["ioa", "objectaddress", "informationobjectaddress", "infoaddr"],
};

/** field → header text */
export type ProtocolMap = Partial<Record<PointField, string>>;

/** Guess field → column mappings from header names. */
export function autoMap(headers: string[], kind: string): ProtocolMap {
  const m: ProtocolMap = {};
  const used = new Set<number>();
  for (const f of fieldsFor(kind)) {
    const j = headers.findIndex((h, k) => !used.has(k) && SYN[f.key].includes(normName(h)));
    if (j >= 0) {
      m[f.key] = headers[j];
      used.add(j);
    }
  }
  return m;
}

// --- normalization -----------------------------------------------------------

export type ModbusTable = "HR" | "IR" | "CO" | "DI";
export function normRegType(s: string): ModbusTable | null {
  const t = normName(s);
  if (!t) return null;
  if (["holding", "holdingregister", "hr", "4x", "fc3", "fc03", "fc6", "fc06", "fc16"].includes(t)) return "HR";
  if (["input", "inputregister", "ir", "3x", "fc4", "fc04"].includes(t)) return "IR";
  if (["coil", "coils", "co", "0x", "fc1", "fc01", "fc5", "fc05", "fc15"].includes(t)) return "CO";
  if (["discrete", "discreteinput", "di", "1x", "fc2", "fc02"].includes(t)) return "DI";
  return null;
}
const MODICON: Record<string, ModbusTable> = { "0": "CO", "1": "DI", "3": "IR", "4": "HR" };
/** Resolve a Modbus address to table + zero-based offset. Accepts plain offsets or Modicon 5/6-digit notation. */
export function resolveModbus(addr: string, regType: string): { table: ModbusTable | null; offset: number | null; inferred: boolean } {
  const a = addr.trim();
  if (!/^\d+$/.test(a)) return { table: normRegType(regType), offset: null, inferred: false };
  const explicit = normRegType(regType);
  if (explicit) return { table: explicit, offset: Number(a), inferred: false };
  if ((a.length === 5 || a.length === 6) && MODICON[a[0]]) {
    const n = Number(a);
    const base = a.length === 5 ? 10000 : 100000;
    return { table: MODICON[a[0]], offset: n - Number(a[0]) * base - 1, inferred: true };
  }
  return { table: null, offset: Number(a), inferred: false };
}

export type Dnp3Type = "AI" | "BI" | "AO" | "BO" | "CTR";
export function normDnp3Type(s: string): Dnp3Type | null {
  const t = normName(s);
  if (["ai", "analoginput", "analog", "g30", "g32", "30"].includes(t)) return "AI";
  if (["bi", "binaryinput", "binary", "g1", "g2"].includes(t)) return "BI";
  if (["ao", "analogoutput", "g40", "g41"].includes(t)) return "AO";
  if (["bo", "binaryoutput", "crob", "g10", "g12"].includes(t)) return "BO";
  if (["counter", "ctr", "g20", "g22"].includes(t)) return "CTR";
  return null;
}

export interface NormPoint {
  tag: string;
  description: string;
  /** HR/IR/CO/DI, AI/BI/AO/BO/CTR, or the IEC 104 type ID */
  object: string;
  /** Offset, index or IOA */
  address: string;
  dataType: string;
  scale: string;
  units: string;
  access: string;
}

export function normalizePoint(kind: string, headers: string[], row: string[], map: ProtocolMap): NormPoint {
  const get = (f: PointField) => {
    const h = map[f];
    const j = h ? headers.indexOf(h) : -1;
    return j < 0 ? "" : String(row[j] ?? "").trim();
  };
  let object = "";
  let address = "";
  if (kind === "modbus") {
    const r = resolveModbus(get("address"), get("regType"));
    object = r.table ?? get("regType");
    address = r.offset == null ? get("address") : String(r.offset);
  } else if (kind === "dnp3") {
    object = normDnp3Type(get("pointType")) ?? get("pointType");
    address = get("index");
  } else if (kind === "iec104") {
    object = get("typeId");
    address = get("ioa");
  }
  return {
    tag: get("tag"),
    description: get("description"),
    object,
    address,
    dataType: get("dataType"),
    scale: get("scale"),
    units: get("units"),
    access: get("access"),
  };
}

// --- validation ---------------------------------------------------------------

export interface Issue {
  level: "error" | "warn";
  /** 1-based data row (Excel row = row + 1 with a header row), or null for table-level issues. */
  row: number | null;
  field: string;
  msg: string;
}

const intIn = (s: string, lo: number, hi: number) => /^\d+$/.test(s) && Number(s) >= lo && Number(s) <= hi;

/** Validate a point-list source against its protocol declaration. */
export function validateSource(kind: string, grid: Grid, map: ProtocolMap): Issue[] {
  const issues: Issue[] = [];
  const fields = fieldsFor(kind);
  if (!fields.length) return issues;
  const H = grid[0] ?? [];
  const col = (f: PointField) => (map[f] ? H.indexOf(map[f]!) : -1);
  for (const f of fields) {
    if (map[f.key] && col(f.key) < 0) issues.push({ level: "error", row: null, field: f.key, msg: `Mapped column "${map[f.key]}" no longer exists` });
    else if (f.required && col(f.key) < 0) issues.push({ level: "error", row: null, field: f.key, msg: `No column mapped for ${f.label}` });
  }
  const get = (r: string[], f: PointField) => {
    const j = col(f);
    return j < 0 ? "" : String(r[j] ?? "").trim();
  };
  const tags = new Map<string, number>();
  const addrs = new Map<string, number>();
  grid.slice(1).forEach((r, i) => {
    if (isBlankRow(r)) return;
    const n = i + 1;
    const add = (level: Issue["level"], field: string, msg: string) => issues.push({ level, row: n, field, msg });
    const tag = get(r, "tag");
    if (col("tag") >= 0) {
      if (!tag) add("error", "tag", "Tag is empty");
      else if (tags.has(tag)) add("warn", "tag", `Duplicate tag (first on row ${tags.get(tag)})`);
      else tags.set(tag, n);
    }
    const sc = get(r, "scale");
    if (sc && !isNum(sc)) add("warn", "scale", `Scale "${sc}" is not a number`);
    const dupAddr = (key: string, label: string) => {
      if (addrs.has(key)) add("error", "address", `${label} already used on row ${addrs.get(key)}`);
      else addrs.set(key, n);
    };
    if (kind === "modbus" && col("address") >= 0) {
      const a = get(r, "address");
      const res = resolveModbus(a, get(r, "regType"));
      if (!/^\d+$/.test(a)) add("error", "address", `Register "${a}" is not a whole number`);
      else {
        if (get(r, "regType") && !normRegType(get(r, "regType"))) add("warn", "regType", `Unknown register type "${get(r, "regType")}"`);
        if (!res.table) add("warn", "regType", "No register type; treated as holding register");
        if (res.offset == null || res.offset < 0 || res.offset > 65535) add("error", "address", `Offset ${res.offset} outside 0–65535`);
        else dupAddr(`${res.table ?? "HR"}:${res.offset}`, `${res.table ?? "HR"} ${res.offset}`);
      }
    }
    if (kind === "dnp3") {
      const pt = get(r, "pointType");
      const t = normDnp3Type(pt);
      if (col("pointType") >= 0 && !t) add("error", "pointType", `Unknown DNP3 point type "${pt}"`);
      const ix = get(r, "index");
      if (col("index") >= 0) {
        if (!intIn(ix, 0, 65535)) add("error", "index", `Index "${ix}" outside 0–65535`);
        else if (t) dupAddr(`${t}:${ix}`, `${t} ${ix}`);
      }
      const ec = get(r, "eventClass");
      if (ec && !/^(class\s*)?[0-3]$/i.test(ec)) add("warn", "eventClass", `Event class "${ec}" should be 0–3`);
    }
    if (kind === "iec104") {
      const ioa = get(r, "ioa");
      if (col("ioa") >= 0) {
        if (!intIn(ioa, 1, 16777215)) add("error", "ioa", `IOA "${ioa}" outside 1–16777215`);
        else dupAddr(`IOA:${ioa}`, `IOA ${ioa}`);
      }
      const ti = get(r, "typeId");
      if (col("typeId") >= 0) {
        if (!ti) add("error", "typeId", "Type ID is empty");
        else if (!/^[MCPFS]_[A-Z]{2}_[A-Z]{2}_1$/.test(ti) && !intIn(ti, 1, 127)) add("warn", "typeId", `Type ID "${ti}" is not a standard name (e.g. M_ME_NC_1) or 1–127`);
      }
    }
  });
  return issues;
}
