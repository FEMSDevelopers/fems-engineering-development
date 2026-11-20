/**
 * Parts & BOM engine: master-part catalog types, nested assemblies (racks, FNEs, rack units, DIN and terminal-block
 * assemblies), hierarchical device tags, item numbering, BOM explosion and roll-up, version comparison, load schedules
 * and the equipment-list importer. Pure functions only (no I/O).
 */
import type { AsmLayout, FneLayout, RackLayout } from "./mech.js";
import type { Grid } from "./types.js";

// ───────────────────────── catalog ─────────────────────────

/** Default device categories (free text in the database; these seed the subcategory catalog). */
export const PART_CATEGORIES = ["Electrical", "Mechanical", "Network", "Control"] as const;

export type MountType = "" | "rack" | "din" | "panel" | "wall" | "floor" | "shelf" | "none";
export const MOUNT_TYPES: [MountType, string][] = [
  ["", "—"], ["rack", "19\" rack"], ["din", "DIN rail"], ["panel", "Back panel"], ["wall", "Wall"], ["floor", "Floor"], ["shelf", "Rack shelf"], ["none", "Not mounted"],
];

/** Mechanical data used by the (phase 2) rack / DIN layout and dimension checks. Lengths in mm, weight in kg. */
export interface PartMech {
  mount: MountType;
  rackUnits: number | null;
  widthMm: number | null;
  heightMm: number | null;
  depthMm: number | null;
  /** Width taken on a DIN rail (mm). */
  dinWidthMm: number | null;
  weightKg: number | null;
  /** Extra clearance added to x (width), y (height), z (depth) when the part is arranged (cables, connectors, bend radius…). */
  addXMm?: number | null;
  addYMm?: number | null;
  addZMm?: number | null;
  /** Draw the uploaded 2D views in layouts (default true); off = a generic box. */
  useViews?: boolean;
  /** Rack equipment that takes both faces: placed full depth and drawn on the rear elevation too. */
  fullDepth?: boolean;
}

/** AC1 = single-phase AC, AC3 = three-phase AC, DC. */
export type PowerKind = "" | "AC1" | "AC3" | "DC";
export const POWER_KINDS: [PowerKind, string][] = [["", "—"], ["AC1", "AC 1-phase"], ["AC3", "AC 3-phase"], ["DC", "DC"]];

/** Power feed (input) of a device. */
export interface PowerIn {
  kind: PowerKind;
  /** Nominal voltage used for load calculations (V). */
  voltage: number | null;
  /** Rated range as printed on the datasheet, e.g. "100-240VAC". */
  range: string;
  /** Maximum consumption (W). */
  watts: number | null;
  /** Maximum current at the nominal voltage (A). */
  amps: number | null;
  /** Power factor for AC loads (default 1). */
  pf: number | null;
  /** Number of power feeds / supplies (e.g. 2 for dual redundant PSUs). */
  feeds: number;
  /** Feeder terminal labels, e.g. L1, L2/N, G or +, −, PE. */
  terminals: string[];
}

/** Power output of a source device (power supply, UPS, inverter, PDU outlet strip). */
export interface PowerOut {
  kind: PowerKind;
  voltage: number | null;
  watts: number | null;
  amps: number | null;
  /** 0–1. */
  efficiency: number | null;
  terminals: string[];
}

/** Built-in port types; subcategories can add their own. */
export const PORT_TYPES = ["RJ45", "SFP", "SFP+", "SFP28", "QSFP+", "Fiber LC", "Fiber SC", "Fiber ST", "RS-232 (DB9)", "RS-485", "USB", "Console", "IRIG-B", "Digital I/O", "Analog I/O", "Antenna"];

export interface PortGroup {
  id: string;
  type: string;
  count: number;
  /** e.g. "1G", "10G", "100BASE-LX10". */
  speed: string;
  /** Label pattern: "Port {n}" → Port 1…; or a plain label. */
  label: string;
  notes: string;
}

/** multi: several of the options; range: min–max numbers; certs: certifications held, each with its certificate PDF. */
export type CustomFieldType = "text" | "number" | "bool" | "select" | "multi" | "range" | "certs";
export interface CustomFieldDef {
  key: string;
  label: string;
  type: CustomFieldType;
  unit?: string;
  /** select / multi / certs */
  options?: string[];
  /** Section in the part editor (Ratings, Input, Output, Certification…). */
  group?: string;
  /** Hint shown on hover. */
  help?: string;
}

export interface Subcategory {
  id: string;
  category: string;
  name: string;
  /** Default device-tag prefix for parts in this subcategory, e.g. "MCB." */
  tagPrefix: string;
  fields: CustomFieldDef[];
  portTypes: string[];
  sort: number;
}

export type PartStatus = "active" | "spares" | "obsolete";
export const DOC_KINDS = ["Datasheet", "Manual", "User guide", "Installation guide", "Flyer", "Certificate", "Drawing / CAD", "Software", "Specification sheet", "Image", "Other"] as const;

export interface Part {
  id: string;
  category: string;
  subcategoryId: string | null;
  manufacturer: string;
  series: string;
  partNumber: string;
  description: string;
  vendor: string;
  vendorContact: string;
  /** Ordering SKU and configuration codes (e.g. sensor options), used by project part-number formats. */
  sku?: string;
  /**
   * Effective part number: a Python expression over the part's fields (pn, sku, config1-3, Spec[…]…), e.g.
   * `f"{pn}-{config1}"` for configured items or `sku or pn`; empty = the part number. `effPn` is its result, computed
   * by the server whenever the part is saved.
   */
  effPnExpr?: string;
  effPn?: string;
  /** Effective description: Python over the part's fields (empty = the description); `effDesc` is its result. */
  effDescExpr?: string;
  effDesc?: string;
  /** Price of the custom configuration (null = the unit price). */
  effPrice?: number | null;
  /** Apply the custom PN / DESC (off: effective PN / description / price = part number / description / unit price). */
  effApply?: boolean;
  /** Saved custom PN / DESC versions of the part, and the one loaded. */
  effVersions?: EffVersion[];
  effVersionId?: string | null;
  configCode1?: string;
  configCode2?: string;
  configCode3?: string;
  notes: string;
  /** Long OEM description (catalog / flyer text, datasheet summary), kept apart from the BOM description. */
  oemDesc?: string;
  /** Overrides the subcategory's tag prefix when set. */
  tagPrefix: string;
  status: PartStatus;
  stock: number | null;
  onOrder: number | null;
  /** Unit price (purchasing reference). */
  price: number | null;
  mech: PartMech;
  powerIn: PowerIn | null;
  powerOut: PowerOut | null;
  ports: PortGroup[];
  /** Subcategory specification values (see specs.ts: SpecValue). */
  custom: Record<string, string | number | boolean | string[] | [number | null, number | null]>;
  /** Number of attached documents / links (read-only, from the server). */
  docCount?: number;
  /** 2D views available for the part (front, back, top, bottom, left, right; read-only, from the server). */
  views?: string[];
  updatedAt?: string;
}

export interface PartDoc {
  id: string;
  partId: string;
  kind: string;
  /** What the document backs, e.g. "cert:UL 489" for a certification certificate. */
  ref?: string;
  /** Custom prefix used by the naming standard ({prefix}), e.g. a drawing or submittal number. */
  prefix?: string;
  /** Custom suffix used by the naming standard ({suffix}), e.g. a revision. */
  suffix?: string;
  title: string;
  url: string;
  fileName: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Active documents are used in outputs (documentation package, index); inactive ones are kept but left out. Default true. */
  active?: boolean;
  /** Year the document was published (e.g. a datasheet revision year); {year} in naming standards. */
  year?: number | null;
  /** Approval ID of a certificate (UL file number, CSA master contract, certificate number…). */
  approvalId?: string;
  /** Certificate name (e.g. "Environmental Confirmation", "UL Listing"). */
  certName?: string;
  /** Set on a product-series document (owned by manufacturer + product series, listed under every part of the series; partId is ""). */
  seriesMfr?: string;
  seriesName?: string;
}

/** Key of a product series: unique per manufacturer (letters and digits only, case-insensitive), as the server's fpl_series_key. */
export const seriesKey = (mfr: string, series: string) =>
  series.trim() ? `${mfr.replace(/[^A-Za-z0-9]+/g, "").toLowerCase()}|${series.replace(/[^A-Za-z0-9]+/g, "").toLowerCase()}` : "";

export const EMPTY_MECH: PartMech = { mount: "", rackUnits: null, widthMm: null, heightMm: null, depthMm: null, dinWidthMm: null, weightKg: null, addXMm: null, addYMm: null, addZMm: null };
export const emptyPowerIn = (): PowerIn => ({ kind: "", voltage: null, range: "", watts: null, amps: null, pf: null, feeds: 1, terminals: [] });
export const emptyPowerOut = (): PowerOut => ({ kind: "", voltage: null, watts: null, amps: null, efficiency: null, terminals: [] });

export function emptyPart(over: Partial<Part> = {}): Omit<Part, "id"> & { id?: string } {
  return {
    category: "", subcategoryId: null, manufacturer: "", series: "", partNumber: "", description: "", vendor: "", vendorContact: "", sku: "", configCode1: "", configCode2: "", configCode3: "", notes: "", oemDesc: "", tagPrefix: "",
    status: "active", stock: null, onOrder: null, price: null, mech: { ...EMPTY_MECH }, powerIn: null, powerOut: null, ports: [], custom: {}, ...over,
  };
}

/** Normalized key for matching parts across lists: manufacturer + part number, case/spacing/punctuation-insensitive. */
/**
 * A saved version of a configuration of a part (Edit part → Configuration). A part has distinct named configurations
 * (all sharing the part's documentation), each with its own versions.
 */
export interface EffVersion {
  id: string;
  /** Configuration the version belongs to (versions saved before configurations existed: "base"). */
  cfgId?: string;
  cfgName?: string;
  major: number;
  minor: number;
  pnExpr: string;
  descExpr: string;
  price: number | null;
  /** SKU and configuration codes #1–#3 of this configuration (restored when the version is loaded). */
  sku?: string;
  configCode1?: string;
  configCode2?: string;
  configCode3?: string;
  notes: string;
  savedAt: string;
}
export const effVerLabel = (v: Pick<EffVersion, "major" | "minor">) => `v${v.major}.${String(v.minor).padStart(3, "0")}`;
/** Next version number: "minor" → +.001 in the same major, "major" → next major .001. */
export const effCfgOf = (v: Pick<EffVersion, "cfgId" | "cfgName">) => ({ id: v.cfgId || "base", name: v.cfgName || "Base" });
export function nextEffVersion(l: Pick<EffVersion, "major" | "minor">[], kind: "minor" | "major", from?: Pick<EffVersion, "major">): { major: number; minor: number } {
  if (!l.length) return { major: 1, minor: 1 };
  const maxMajor = Math.max(...l.map((v) => v.major));
  if (kind === "major") return { major: maxMajor + 1, minor: 1 };
  const m = from?.major ?? maxMajor;
  return { major: m, minor: Math.max(0, ...l.filter((v) => v.major === m).map((v) => v.minor)) + 1 };
}
export const normPn = (s: string) => (s ?? "").toUpperCase().replace(/[\s\-_./#]+/g, "").replace(/^0+(?=\d)/, "");
export const normMfr = (s: string) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
export const partKey = (mfr: string, pn: string) => `${normMfr(mfr)}|${normPn(pn)}`;

/** Find a part by manufacturer + part number; falls back to the part number alone when it is unique. */
export function partMatcher(parts: Part[]) {
  const byKey = new Map<string, Part>();
  const byPn = new Map<string, Part[]>();
  for (const p of parts) {
    byKey.set(partKey(p.manufacturer, p.partNumber), p);
    const k = normPn(p.partNumber);
    if (!k) continue;
    byPn.set(k, [...(byPn.get(k) ?? []), p]);
  }
  return (mfr: string, pn: string): Part | undefined => {
    if (!normPn(pn)) return undefined;
    const exact = byKey.get(partKey(mfr, pn));
    if (exact) return exact;
    const l = byPn.get(normPn(pn));
    return l && l.length === 1 ? l[0] : undefined;
  };
}

/** Part validation for the catalog grid (keyed by part id). */
export function validateParts(parts: Part[]): Record<string, { level: "error" | "warn"; field: string; msg: string; row: null }[]> {
  const out: Record<string, { level: "error" | "warn"; field: string; msg: string; row: null }[]> = {};
  const seen = new Map<string, string>();
  const add = (id: string, level: "error" | "warn", field: string, msg: string) => (out[id] ??= []).push({ level, field, msg, row: null });
  for (const p of parts) {
    if (!p.partNumber.trim()) add(p.id, "error", "partNumber", "Part number is empty");
    if (!p.manufacturer.trim()) add(p.id, "warn", "manufacturer", "Manufacturer is empty");
    if (!p.description.trim()) add(p.id, "warn", "description", "Description is empty");
    const k = partKey(p.manufacturer, p.partNumber);
    if (p.partNumber.trim()) {
      const other = seen.get(k);
      if (other) (add(p.id, "error", "partNumber", "Duplicate manufacturer + part number"), add(other, "error", "partNumber", "Duplicate manufacturer + part number"));
      else seen.set(k, p.id);
    }
    if (p.powerIn && p.powerIn.watts == null && p.powerIn.amps == null && p.powerIn.kind) add(p.id, "warn", "powerIn", "Power feed has no W or A rating");
  }
  return out;
}

/** Input power in W (from W, or V × A × pf when only amps are known). */
export function partWatts(p: Pick<Part, "powerIn"> | null | undefined): number | null {
  const pi = p?.powerIn;
  if (!pi) return null;
  if (pi.watts != null) return pi.watts;
  if (pi.amps != null && pi.voltage != null) return pi.amps * pi.voltage * (pi.kind === "AC3" ? Math.sqrt(3) : 1) * (pi.kind === "DC" ? 1 : pi.pf ?? 1);
  return null;
}

/** Total port count by type ("RJ45" → 12). */
export function portTotals(p: Pick<Part, "ports">): Record<string, number> {
  const t: Record<string, number> = {};
  for (const g of p.ports ?? []) t[g.type] = (t[g.type] ?? 0) + (g.count || 0);
  return t;
}
export const portSummary = (p: Pick<Part, "ports">) =>
  Object.entries(portTotals(p))
    .map(([k, n]) => `${n}× ${k}`)
    .join(", ");

/** Expand a port group's label pattern: "Port {n}" × 3 → Port 1, Port 2, Port 3. */
export function portLabels(g: PortGroup, start = 1): string[] {
  const pat = g.label?.trim() || `${g.type} {n}`;
  return Array.from({ length: Math.max(0, g.count) }, (_, i) => (pat.includes("{n}") ? pat.replace(/\{n\}/g, String(start + i)) : `${pat}${g.count > 1 ? ` ${start + i}` : ""}`));
}

/**
 * Guess a subcategory from free text (e.g. the MPL "Assembly"/"Type" columns and the description).
 * Several texts are tried in order (type columns first, then the description); the first hit wins.
 */
export function guessSubcategory(text: string | string[], subcats: Subcategory[]): Subcategory | undefined {
  for (const one of Array.isArray(text) ? text : [text]) {
    const hit = one.trim() ? guessOne(one, subcats) : undefined;
    if (hit) return hit;
  }
  return undefined;
}
function guessOne(text: string, subcats: Subcategory[]): Subcategory | undefined {
  const t = ` ${text.toUpperCase().replace(/[^A-Z0-9+]+/g, " ")} `;
  const rules: [RegExp, string[]][] = [
    [/ (ANTENNA) /, ["Antenna"]],
    [/ (CELLULAR|MODEM|ROUTER|STARLINK) /, ["Cellular Router"]],
    [/ (HMI|HISTORIAN|SERVER|R650|R640|POWEREDGE) /, ["Server"]],
    [/ PDU /, ["PDU"]],
    [/ REDUNDANCY MODULE /, ["24VDC Redundancy Module", "Redundancy Module"]],
    [/ (TRIO BAT|BATTERY|BATTERIES) /, ["Battery"]],
    [/ (QUINT|TRIO|POWER SUPPLY|PSU) /, ["24VDC Power Supply", "Power Supply"]],
    [/ RCBO | RESIDUAL CURRENT /, ["RCBO"]],
    [/ (MCB|MINIATURE|CIRCUIT BREAKER) /, ["MCB"]],
    [/ (SURGE|SPD) /, ["Surge Protection Device", "SPD"]],
    [/ FUSE HOLDER /, ["Fuse Holder"]],
    [/ FUSE /, ["Fuse"]],
    [/ (PLUG IN BRIDGE|JUMPER|FBS) /, ["Plug-in Bridge"]],
    [/ (PARTITION PLATE|END COVER|END CLAMP|END STOP) /, ["Terminal Accessory"]],
    [/ TERMINAL BLOCK /, ["Terminal Block"]],
    [/ DIN RAIL /, ["DIN Rail"]],
    [/ (WIRING DUCT|WIRE DUCT|DUCT) /, ["Wire Duct"]],
    [/ (UPS|SMART UPS) /, ["UPS"]],
    [/ INVERTER /, ["Inverter"]],
    [/ (POWER CABLE|POWER CORD) /, ["Power Cable"]],
    [/ (FIREWALL|FORTIGATE \d+[A-Z]?|FG \d+[A-Z]?) /, ["Firewall"]],
    [/(FORTISWITCH| SWITCH | SWITCHES | FS \d+| FSR \d+)/, ["Network Switch"]],
    [/ (TRANSCEIVER|SFP) /, ["SFP Transceiver"]],
    [/ (PATCH PANEL|FPP) /, ["Fiber Patch Panel"]],
    [/ (ADAPTER PLATE|FIBER ADAPTER) /, ["Fiber Adapter"]],
    [/ (PATCH CABLE|PATCH CORD|CAT6|CAT 6) /, ["Patch Cable"]],
    [/ RTAC /, ["RTAC"]],
    [/ (CLOCK|NTP|GPS) /, ["Satellite Clock"]],
    [/ (SITE CONTROLLER) /, ["Site Controller"]],
    [/ (UNIT CONTROLLER|POWER PLANT CONTROLLER|VOLTAGE CONTROLLER|SBRIO) /, ["Controller"]],
    [/ (IPC|INDUSTRIAL PC|KARBON) /, ["Industrial PC"]],
    [/ (SENSOR|HUMIDITY) /, ["Sensor"]],
    [/ (I O MODULE|GPIC) /, ["I/O Module"]],
    [/ (FAN) /, ["Fan"]],
    [/ (AIR CONDITIONER|HVAC|HEATER) /, ["HVAC"]],
    [/ (CABINET|SERVER RACK|42U) /, ["Server Rack Enclosure"]],
    [/ (ENCLOSURES?|FNE|FIELD NETWORK) /, ["Field Enclosure"]],
    [/ (PANEL FITS|BACK PANEL|CONCEPT PANEL) /, ["Back Panel"]],
    [/ (SHELF) /, ["Rack Shelf"]],
    [/ (BRACKET|FOOT KIT|CLIP) /, ["Mounting Hardware"]],
    [/ (CAMERA) /, ["Camera"]],
  ];
  const byName = new Map(subcats.map((s) => [s.name.toUpperCase(), s]));
  for (const [re, names] of rules) {
    if (!re.test(t)) continue;
    for (const n of names) {
      const s = byName.get(n.toUpperCase());
      if (s) return s;
    }
  }
  // Fall back to a subcategory whose name appears in the text.
  return subcats.find((s) => s.name.length > 2 && t.includes(` ${s.name.toUpperCase().replace(/[^A-Z0-9+]+/g, " ").trim()} `));
}

/** Default subcategories seeded on first run (category, name, tag prefix). */
export const DEFAULT_SUBCATEGORIES: [string, string, string][] = [
  ["Electrical", "24VDC Power Supply", "PS."], ["Electrical", "24VDC Redundancy Module", "RM."], ["Electrical", "UPS", "UPS."], ["Electrical", "Inverter", "INV."],
  ["Electrical", "PDU", "PSTR."], ["Electrical", "MCB", "MCB."], ["Electrical", "RCBO", "RCBO."], ["Electrical", "Surge Protection Device", "SPD."],
  ["Electrical", "Fuse Holder", "FU."], ["Electrical", "Fuse", ""], ["Electrical", "Terminal Block", ""], ["Electrical", "Terminal Accessory", ""],
  ["Electrical", "Plug-in Bridge", ""], ["Electrical", "Power Cable", ""], ["Electrical", "Outlet", ""], ["Electrical", "Transformer", "XFMR."],
  ["Mechanical", "Server Rack Enclosure", "RACK."], ["Mechanical", "Wall Mounted RTAC Enclosure", "ENC."], ["Mechanical", "Field Enclosure", "FNE."],
  ["Mechanical", "Back Panel", ""], ["Mechanical", "Rack Shelf", ""], ["Mechanical", "DIN Rail", ""], ["Mechanical", "Wire Duct", ""],
  ["Mechanical", "Mounting Hardware", ""], ["Mechanical", "Fan", "FAN."], ["Mechanical", "HVAC", "HVAC."],
  ["Network", "Firewall", "FW."], ["Network", "Network Switch", "NS."], ["Network", "SFP Transceiver", "SFP."], ["Network", "Fiber Patch Panel", "FPP."],
  ["Network", "Fiber Adapter", ""], ["Network", "Patch Cable", ""], ["Network", "Cellular Router", "CELL."], ["Network", "Satellite Clock", "NTP."],
  ["Control", "RTAC", "RTAC."], ["Control", "Site Controller", "SC."], ["Control", "Controller", "UC."], ["Control", "Industrial PC", "IPC."],
  ["Control", "Server", "HMI."], ["Control", "I/O Module", "IO."], ["Control", "Sensor", "TS."], ["Control", "Camera", "CAM."],
];

// ───────────────────────── assemblies / BOM tree ─────────────────────────

/** Snapshot of a part's identity stored in a BOM so saved versions stay comparable when the catalog changes. */
export interface PartSnap {
  manufacturer: string;
  partNumber: string;
  description: string;
}

/** "+" location (rack, enclosure), "-" product (device), "=" function. */
export type TagRole = "loc" | "prod" | "func";
export const ROLE_SIGN: Record<TagRole, string> = { loc: "+", prod: "-", func: "=" };

export type AsmKind = "RACK" | "FNE" | "RU" | "DIN" | "TB" | "PANEL" | "OTHER";
export const ASM_KINDS: [AsmKind, string][] = [
  ["RACK", "Server rack"], ["FNE", "Field network enclosure"], ["RU", "Rack unit (RU)"], ["DIN", "DIN-rail assembly"], ["TB", "Terminal-block assembly"], ["PANEL", "Panel / wall-mount (e.g. RTAC)"], ["OTHER", "Other"],
];

export interface BomNode {
  id: string;
  kind: "group" | "part";
  /** Group title, e.g. "SERVER RACK", "AC ELECTRICAL PROTECTION DEVICES". For parts: optional description override. */
  name: string;
  partId?: string | null;
  snap?: PartSnap | null;
  /** Free-text manufacturer shown on a group line (e.g. "FRACTAL" for in-house assemblies). */
  maker?: string;
  /** Quantity per parent instance. For groups: number of instances (e.g. 17 FNEs). */
  qty: number;
  /** Local device tags, one per unit (without + / -). Empty = untagged. */
  tags: string[];
  /** Role of the tags (default: top level "loc", everything else "prod"). */
  role?: TagRole;
  /** Tag prefix of the line (PREFIX column, device tags = prefix + number from Mechanical Design), e.g. "FAN.". */
  prefix?: string;
  /** No prefix for this line, not even the part / subcategory default. */
  noPrefix?: boolean;
  /** The tags of this line come from device IDs defined in Mechanical Design (kept in sync, read only). */
  mechTags?: boolean;
  /** Manual item number (replaces the automatic one; children number from it). */
  itemNo?: string;
  /** Top-level units only: first section letter (default: continues after the previous unit). */
  sectionStart?: string;
  /** Sub-assembly: its items are lettered (A1.1a, A1.1b); sub-assemblies can nest. */
  line?: boolean;
  /** Sub-category alias of a sub-assembly (e.g. "TB-A TERMINALS", "24VDC DISTRIBUTION"); printed as its line in equipment lists. */
  alias?: string;
  /** Mechanical layouts: id of the project-BOM node this equipment line was imported from. */
  bomNodeId?: string;
  /** Mechanical layouts: BOM nodes (parts, groups, sub-assemblies) whose device tags this line shows. */
  links?: string[];
  notes?: string;
  /** Provenance when copied from an assembly template. */
  from?: { assemblyId: string; name: string; major: number; minor: number } | null;
  /** Mechanical layout of a group used as an assembly (DIN-rail, terminal-block or rack-mounted assembly). */
  layout?: AsmLayout | null;
  /** Unit generated from Mechanical Design: parts placed in layouts of BOM unit <id> that are not on the BOM. */
  mechUndef?: string;
  /** Rack elevation of a top-level unit. */
  rack?: RackLayout | null;
  /** Field-enclosure layout of a top-level unit. */
  fne?: FneLayout | null;
  children: BomNode[];
}

/** One project BOM (saved as versions: 60 % / 90 % / IFC …). */
export interface BomDoc {
  project: { name: string; number: string; client: string; site: string; notes: string };
  /** Mechanical Design assembly groups (linked to a saved version of a project BOM for quantity checks). */
  assemblies?: import("./asmgroups.js").AsmSet | null;
  /** Outputs: columns of the equipment lists. */
  eqList?: import("./outspec.js").EqListSpec | null;
  /** Outputs: columns and sort of the purchasing roll-up. */
  rollupSpec?: import("./outspec.js").RollupSpec | null;
  /** Document naming convention of this project (imported from a naming standard version, then editable here). */
  naming?: { from: { id: string; name: string; major: number; minor: number } | null; std: import("./naming.js").NamingStandard } | null;
  /** Project part-number format (imported from a library version, then editable here). */
  pnFormat?: { from: { id: string; name: string; major: number; minor: number } | null; fmt: import("./pnformat.js").PnFormat } | null;
  /** Documentation package of this project: Python text added before / after each part's file names (e.g. its part line), which BOM gives the part lines, extra unit sheets. */
  docExport?: {
    before: string; after: string; source: "open" | "latest"; unitSheets: boolean;
    /** One folder per BOM part line (item no.) with its files, and an index row per part line with columns per document type. */
    byLine?: boolean;
    /** Python key ordering the documents of a part (kind, title, file, std, prefix, suffix, pn, mfr). */
    docOrder?: string;
  } | null;

  /** Drawing-set stage of this version, e.g. "60%", "90%", "IFC". */
  stage: string;
  units: BomNode[];
  loads: LoadBus[];
  /** Short-listed part ids for this project (quick insert). */
  shortlist: string[];
}
export const STAGES = ["30%", "60%", "90%", "IFC", "As-built"];

/** Saved assembly template (rack, FNE, RU, DIN / terminal-block assembly…). */
export interface AsmTemplate {
  kind: AsmKind;
  root: BomNode;
  notes: string;
}

export const emptyBomDoc = (): BomDoc => ({ project: { name: "", number: "", client: "", site: "", notes: "" }, stage: "60%", units: [], loads: [], shortlist: [] });

let seq = 0;
/** Random-enough id for tree nodes (crypto.randomUUID when available). */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  seq = (seq + 1) % 1e6;
  return `n${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function groupNode(name: string, over: Partial<BomNode> = {}): BomNode {
  return { id: newId(), kind: "group", name, qty: 1, tags: [], children: [], ...over };
}
export function partNode(p: Pick<Part, "id" | "manufacturer" | "partNumber" | "description">, qty = 1, over: Partial<BomNode> = {}): BomNode {
  return { id: newId(), kind: "part", name: "", partId: p.id, snap: { manufacturer: p.manufacturer, partNumber: p.partNumber, description: p.description }, qty, tags: [], children: [], ...over };
}

/** Deep copy with fresh ids (used when a template is inserted). */
export function cloneNode(n: BomNode, fresh = true): BomNode {
  const map = new Map<string, string>();
  const rec = (x: BomNode): BomNode => {
    const id = fresh ? newId() : x.id;
    map.set(x.id, id);
    return { ...x, id, tags: [...x.tags], snap: x.snap ? { ...x.snap } : x.snap, from: x.from ? { ...x.from } : x.from, children: x.children.map(rec) };
  };
  const out = rec(n);
  // Layouts refer to nodes by id: re-point them at the copies (and deep-copy them).
  const re = (id: string | null | undefined) => (id ? map.get(id) ?? id : id);
  const fix = (x: BomNode): BomNode => {
    const y: BomNode = { ...x, children: x.children.map(fix) };
    if (x.layout) y.layout = remapLayout(x.layout, re);
    if (x.rack) y.rack = { ...x.rack, slots: x.rack.slots.map((s) => ({ ...s, nodeId: re(s.nodeId)! })) };
    if (x.fne) y.fne = remapFne(x.fne, re);
    return y;
  };
  return fix(out);
}
function remapLayout(l: AsmLayout, re: (id: string | null | undefined) => string | null | undefined): AsmLayout {
  const palette = l.palette ? Object.fromEntries(Object.entries(l.palette).map(([k, v]) => [re(k)!, { ...v }])) : undefined;
  return { ...l, rails: l.rails.map((r) => ({ ...r })), items: l.items.map((i) => ({ ...i, nodeId: re(i.nodeId)! })), ...(l.arrays ? { arrays: l.arrays.map((a) => ({ ...a })) } : {}), ...(palette ? { palette } : {}) };
}
function remapFne(f: FneLayout, re: (id: string | null | undefined) => string | null | undefined): FneLayout {
  return {
    ...f, enclosureNodeId: re(f.enclosureNodeId) ?? null, panelNodeId: re(f.panelNodeId) ?? null,
    ducts: f.ducts.map((d) => ({ ...d })), conduits: f.conduits.map((c) => ({ ...c })),
    zones: f.zones.map((z) => ({ ...z, nodeId: re(z.nodeId)! })), items: f.items.map((i) => ({ ...i, nodeId: re(i.nodeId)! })),
  };
}

export function walk(nodes: BomNode[], f: (n: BomNode, parents: BomNode[]) => void, parents: BomNode[] = []) {
  for (const n of nodes) {
    f(n, parents);
    walk(n.children, f, [...parents, n]);
  }
}
export function findNode(nodes: BomNode[], id: string): { node: BomNode; parents: BomNode[] } | null {
  let hit: { node: BomNode; parents: BomNode[] } | null = null;
  walk(nodes, (n, parents) => {
    if (!hit && n.id === id) hit = { node: n, parents };
  });
  return hit;
}

/** Immutable update of one node. */
export function updateNode(nodes: BomNode[], id: string, f: (n: BomNode) => BomNode): BomNode[] {
  return nodes.map((n) => (n.id === id ? f(n) : n.children.length ? { ...n, children: updateNode(n.children, id, f) } : n));
}
export function removeNode(nodes: BomNode[], id: string): BomNode[] {
  return nodes.filter((n) => n.id !== id).map((n) => (n.children.length ? { ...n, children: removeNode(n.children, id) } : n));
}
/** Insert `node` into `parentId` (null = top level) at `index` (default: end). */
export function insertNode(nodes: BomNode[], parentId: string | null, node: BomNode, index?: number): BomNode[] {
  const put = (list: BomNode[]) => {
    const l = list.slice();
    l.splice(index == null || index < 0 || index > l.length ? l.length : index, 0, node);
    return l;
  };
  if (parentId == null) return put(nodes);
  return nodes.map((n) => (n.id === parentId ? { ...n, children: put(n.children) } : n.children.length ? { ...n, children: insertNode(n.children, parentId, node, index) } : n));
}
/** Move a node under a new parent (refuses moving a node into its own subtree). */
export function moveNode(nodes: BomNode[], id: string, parentId: string | null, index?: number): BomNode[] {
  const hit = findNode(nodes, id);
  if (!hit) return nodes;
  if (parentId && (parentId === id || findNode(hit.node.children, parentId))) return nodes;
  // Index is relative to the destination list after removal.
  return insertNode(removeNode(nodes, id), parentId, hit.node, index);
}
/** Move a node one place up/down among its siblings. */
export function shiftNode(nodes: BomNode[], id: string, d: -1 | 1): BomNode[] {
  const i = nodes.findIndex((n) => n.id === id);
  if (i >= 0) {
    const j = i + d;
    if (j < 0 || j >= nodes.length) return nodes;
    const l = nodes.slice();
    [l[i], l[j]] = [l[j], l[i]];
    return l;
  }
  return nodes.map((n) => (n.children.length ? { ...n, children: shiftNode(n.children, id, d) } : n));
}

// ───────────────────────── tags ─────────────────────────

/** "-MCB.01A" → { tag: "MCB.01A", role: "prod" }. */
export function parseTag(raw: string): { tag: string; role?: TagRole } {
  const s = (raw ?? "").trim();
  const sign = s[0];
  const role: TagRole | undefined = sign === "+" ? "loc" : sign === "-" ? "prod" : sign === "=" ? "func" : undefined;
  return { tag: (role ? s.slice(1) : s).trim(), role };
}
export const nodeRole = (n: BomNode, depth: number): TagRole => n.role ?? (depth === 0 ? "loc" : "prod");
export const signed = (tag: string, role: TagRole) => `${ROLE_SIGN[role]}${tag}`;

/** Prefix used for automatic tags: node prefix → part override → subcategory default. */
export function tagPrefixOf(n: BomNode, part?: Part, sub?: Subcategory): string {
  if (n.noPrefix) return "";
  return (n.prefix || part?.tagPrefix || sub?.tagPrefix || "").trim();
}
/** The Project BOM "Prefix" column: parts show the role sign + prefix (none with "No prefix"); groups / units show their own tags. */
export function prefixCellOf(n: BomNode, depth: number, part?: Part, sub?: Subcategory): string {
  const role = nodeRole(n, depth);
  if (n.kind === "group" && n.tags.length) return n.tags.map((t) => signed(t, role)).join(", ");
  const p = n.kind === "part" ? tagPrefixOf(n, part, sub) : n.noPrefix ? "" : (n.prefix ?? "").trim();
  return p ? signed(p, role) : "";
}
/** Device tag from a prefix and a number defined in Mechanical Design: ("SRV.", "01") → "SRV.01", ("SRV", ".01A") → "SRV.01A". */
export function deviceTag(prefix: string, num: string): string {
  const n = num.trim().replace(/^[.\-]/, "");
  const p = prefix.trim();
  if (!p) return n;
  return /[.\-]$/.test(p) ? `${p}${n}` : `${p}.${n}`;
}
/** Next free numbers for a prefix given the numbers already used: 01, 02 … and lettered 01A, 01B … */
export function nextNumbers(used: Iterable<string>, count = 3): string[] {
  const u = new Set([...used].map((x) => x.trim().replace(/^[.\-]/, "").toUpperCase()));
  const out: string[] = [];
  for (let i = 1; out.length < count && i < 1000; i++) {
    const n = String(i).padStart(2, "0");
    if (![...u].some((x) => x === n || x.startsWith(n) && /^[A-Z]$/.test(x.slice(n.length)))) out.push(n);
  }
  const first = out[0] ?? "01";
  // Lettered units of the lowest number already lettered, else of the next free number.
  const lettered = [...u].filter((x) => /^\d+[A-Z]$/.test(x)).sort();
  const base = lettered.length ? lettered[lettered.length - 1].slice(0, -1) : first;
  for (let k = 0; k < 26 && out.length < count + 2; k++) {
    const t = `${base}${String.fromCharCode(65 + k)}`;
    if (!u.has(t)) out.push(t);
  }
  return out;
}

export type TagScheme = "seq" | "letters" | "seqLetters";
/**
 * Automatic tags for `qty` units with `prefix` (dot added when missing):
 *   seq        MCB.01, MCB.02, …
 *   letters    MCB.01A, MCB.01B, … (one number, redundant A/B units)
 *   seqLetters MCB.01A, MCB.01B, MCB.02A, MCB.02B, … (pairs)
 * Numbers already in `used` are skipped. `digits` pads the number (default 2).
 */
export function autoTags(prefix: string, qty: number, scheme: TagScheme, used: Iterable<string> = [], digits = 2, start = 1): string[] {
  const p = prefix ? (/[.\-]$/.test(prefix) ? prefix : `${prefix}.`) : "";
  const taken = new Set([...used].map((t) => t.toUpperCase()));
  const out: string[] = [];
  const num = (n: number) => String(n).padStart(digits, "0");
  const L = (i: number) => String.fromCharCode(65 + i);
  let n = start;
  const free = (cands: string[]) => cands.every((c) => !taken.has(c.toUpperCase()));
  if (scheme === "seq") {
    while (out.length < qty) {
      const t = `${p}${num(n++)}`;
      if (!taken.has(t.toUpperCase())) out.push(t);
    }
  } else if (scheme === "letters") {
    // Same number for every unit: find the first number with qty free letters.
    for (; ; n++) {
      const c = Array.from({ length: qty }, (_, i) => `${p}${num(n)}${L(i)}`);
      if (free(c)) return c;
      if (n > start + 999) return c;
    }
  } else {
    while (out.length < qty) {
      const c = [`${p}${num(n)}A`, `${p}${num(n)}B`];
      n++;
      if (free(c)) out.push(...c.slice(0, qty - out.length));
    }
  }
  return out;
}

/** Full (hierarchical) tag of each unit of a node: ancestors' first tags + the node's own tags. */
export function fullTagsOf(n: BomNode, parents: BomNode[], instance = 0): string[] {
  let pre = "";
  let last = "";
  parents.forEach((p, d) => {
    if (!p.tags.length) return;
    const t = p.tags[d === 0 ? Math.min(instance, p.tags.length - 1) : 0];
    // A tag equal to its tagged ancestor's (e.g. the cabinet part "RACK.01" inside unit +RACK.01) is not repeated.
    if (t.toUpperCase() !== last) pre += signed(t, nodeRole(p, d));
    last = t.toUpperCase();
  });
  const depth = parents.length;
  return n.tags.map((t) => (t.toUpperCase() === last ? pre : `${pre}${signed(t, nodeRole(n, depth))}`));
}

/** All tags used inside a subtree (local tags, upper-case), for automatic numbering. */
export function tagsIn(nodes: BomNode[]): Set<string> {
  const s = new Set<string>();
  walk(nodes, (n) => n.tags.forEach((t) => s.add(t.toUpperCase())));
  return s;
}

/** Duplicate full tags within the project (keyed by node id). */
export function tagIssues(units: BomNode[]): Record<string, string[]> {
  const where = new Map<string, string[]>();
  const out: Record<string, string[]> = {};
  units.forEach((u) => {
    const inst = Math.max(1, u.tags.length || 1);
    for (let k = 0; k < inst; k++) {
      walk([u], (n, parents) => {
        if (!n.tags.length) return;
        const anc = [...parents].reverse().find((p) => p.tags.length);
        const ancTag = anc ? (anc === parents[0] ? anc.tags[Math.min(k, anc.tags.length - 1)] : anc.tags[0]).toUpperCase() : "";
        for (const [i, t] of fullTagsOf(n, parents, k).entries()) {
          // The cabinet part tagged like its unit is the same item, not a duplicate.
          if (n.tags[i]?.toUpperCase() === ancTag) continue;
          const key = t.toUpperCase();
          const l = where.get(key) ?? [];
          if (!l.includes(n.id)) l.push(n.id);
          where.set(key, l);
          if (l.length > 1) for (const id of l) (out[id] ??= []).includes(`Duplicate tag ${t}`) || out[id].push(`Duplicate tag ${t}`);
        }
      });
    }
  });
  walk(units, (n) => {
    if (n.tags.length && n.tags.length !== n.qty) (out[n.id] ??= []).push(`${n.tags.length} tag(s) for quantity ${n.qty}`);
    const dup = n.tags.find((t, i) => n.tags.findIndex((x) => x.toUpperCase() === t.toUpperCase()) !== i);
    if (dup) (out[n.id] ??= []).push(`Tag ${dup} repeated on this line`);
  });
  return out;
}

// ───────────────────────── item numbering ─────────────────────────

/** 0 → A, 25 → Z, 26 → AA */
export function letters(i: number): string {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
const letterIndex = (s: string) => s.toUpperCase().split("").reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/**
 * Item numbers in equipment-list style. Under each top-level unit:
 *   depth 1 → A, B, C (continuing across units unless the unit sets `sectionStart`)
 *   depth 2 → A1, A2   depth 3 → A1.1   depth 4 → A1.1a (children of a lettered line)   deeper → .1
 * A node's manual `itemNo` replaces its number and its children number from it.
 */
export function itemNumbers(units: BomNode[]): Map<string, string> {
  const out = new Map<string, string>();
  let next = 0;
  for (const u of units) {
    if (u.sectionStart && /^[A-Za-z]+$/.test(u.sectionStart)) next = letterIndex(u.sectionStart);
    out.set(u.id, u.itemNo ?? "");
    // Children of a sub-assembly are lettered (A1.1a, A1.1b); inside a lettered item they number again (A1.1a.1).
    const rec = (list: BomNode[], parentNo: string, depth: number, sub: boolean) => {
      list.forEach((n, i) => {
        let no: string;
        if (sub && depth > 1) no = /[a-z]$/.test(parentNo) ? `${parentNo}.${i + 1}` : `${parentNo}${letters(i).toLowerCase()}`;
        else if (depth === 1) no = letters(next++);
        else if (depth === 2) no = `${parentNo}${i + 1}`;
        else no = `${parentNo}.${i + 1}`;
        if (n.itemNo) {
          no = n.itemNo;
          if (depth === 1 && /^[A-Za-z]+$/.test(no)) next = letterIndex(no) + 1;
        }
        out.set(n.id, no);
        rec(n.children, no, depth + 1, n.kind === "group" && !!n.line);
      });
    };
    rec(u.children, "", 1, false);
  }
  return out;
}

// ───────────────────────── explode / roll-up ─────────────────────────

export interface BomCtx {
  parts: Map<string, Part>;
  subcats?: Map<string, Subcategory>;
  /** Project part-number format: how a part number is written in equipment lists / tag lists. */
  pn?: (p: Part) => string;
}
export const bomCtx = (parts: Part[], subcats: Subcategory[] = []): BomCtx => ({ parts: new Map(parts.map((p) => [p.id, p])), subcats: new Map(subcats.map((s) => [s.id, s])) });

/** Identity of a node: live catalog part, else the saved snapshot, else the group's own text. */
export function nodeIdentity(n: BomNode, ctx?: BomCtx): PartSnap & { part?: Part } {
  const part = n.partId ? ctx?.parts.get(n.partId) : undefined;
  if (n.kind === "group") return { manufacturer: n.maker ?? part?.manufacturer ?? "", partNumber: part?.partNumber ?? "", description: n.name || part?.description || "", part };
  return {
    manufacturer: part?.manufacturer ?? n.snap?.manufacturer ?? "",
    partNumber: part?.partNumber ?? n.snap?.partNumber ?? "",
    description: n.name || part?.description || n.snap?.description || "",
    part,
  };
}

export interface BomLine {
  nodeId: string;
  unitId: string;
  /** Unit's first tag (e.g. RACK.01) or its name. */
  unit: string;
  itemNo: string;
  depth: number;
  kind: "group" | "part";
  manufacturer: string;
  partNumber: string;
  description: string;
  partId: string | null;
  /** Quantity per parent instance. */
  qty: number;
  /** Quantity per unit instance (product of quantities below the unit). */
  perUnit: number;
  /** Project total (× unit instances). */
  total: number;
  prefix: string;
  /** Exactly what the Project BOM "Prefix" column shows: role sign + prefix (parts), or the tags of a group. */
  prefixCell: string;
  tags: string[];
  /** Full tags for the first instance of the unit. */
  fullTags: string[];
  /** Sub-assembly (lettered items; no quantity of its own). */
  line?: boolean;
  alias?: string;
  /** Part number as written in the BOM (project part-number format); multi-line allowed. */
  projectPn?: string;
}

/** Unit label: its tag, or for multi-instance units (17 × FNE) its name / tag stem. */
export const unitLabelOf = (u: BomNode) => ((u.qty || 1) > 1 ? u.name || u.tags[0]?.replace(/[.\d]+$/, "") || "UNIT" : u.tags[0] || u.name || "(unit)");

/** Flatten the project tree into equipment-list lines (groups included, in tree order). */
export function explode(units: BomNode[], ctx?: BomCtx): BomLine[] {
  const nos = itemNumbers(units);
  const lines: BomLine[] = [];
  for (const u of units) {
    const unitLabel = unitLabelOf(u);
    const inst = Math.max(1, u.qty || 1);
    walk(u.children, (n, ps) => {
      const parents = [u, ...ps];
      const perUnit = ps.reduce((m, p) => m * (p.qty || 0), 1) * (n.qty || 0);
      const id = nodeIdentity(n, ctx);
      const sub = id.part?.subcategoryId ? ctx?.subcats?.get(id.part.subcategoryId) : undefined;
      lines.push({
        nodeId: n.id, unitId: u.id, unit: unitLabel, itemNo: nos.get(n.id) ?? "", depth: parents.length, kind: n.kind,
        manufacturer: id.manufacturer, partNumber: id.partNumber, description: n.kind === "group" && n.line && n.alias && !n.name ? n.alias : id.description, partId: n.partId ?? null,
        qty: n.qty, perUnit, total: perUnit * inst,
        prefix: n.tags.length ? "" : n.kind === "part" ? tagPrefixOf(n, id.part, sub) : n.prefix ?? "",
        prefixCell: prefixCellOf(n, ps.length + 1, id.part, sub),
        tags: n.tags, fullTags: fullTagsOf(n, parents), line: n.kind === "group" && !!n.line, alias: n.alias,
        projectPn: id.part && ctx?.pn ? ctx.pn(id.part) : undefined,
      });
    });
  }
  return lines;
}

export interface RollupRow {
  key: string;
  partId: string | null;
  manufacturer: string;
  partNumber: string;
  description: string;
  total: number;
  /** Total per unit label. */
  byUnit: Record<string, number>;
  stock: number | null;
  onOrder: number | null;
  /** total − stock − on order (when known and positive). */
  toBuy: number | null;
  price: number | null;
}

/** Purchasing roll-up: one row per manufacturer + part number with project totals. Groups are left out unless they carry a part number and `withAssemblies`. */
export function rollup(units: BomNode[], ctx?: BomCtx, o: { withAssemblies?: boolean } = {}): RollupRow[] {
  const m = new Map<string, RollupRow>();
  for (const l of explode(units, ctx)) {
    if (l.kind === "group" && !(o.withAssemblies && l.partNumber)) continue;
    if (!l.partNumber && !l.description) continue;
    const key = l.partNumber ? partKey(l.manufacturer, l.partNumber) : `?|${l.description.toUpperCase()}`;
    const part = l.partId ? ctx?.parts.get(l.partId) : undefined;
    const r = m.get(key) ?? {
      key, partId: l.partId, manufacturer: l.manufacturer, partNumber: l.partNumber, description: part?.description || l.description,
      total: 0, byUnit: {}, stock: part?.stock ?? null, onOrder: part?.onOrder ?? null, toBuy: null, price: part?.price ?? null,
    };
    r.total += l.total;
    r.byUnit[l.unit] = (r.byUnit[l.unit] ?? 0) + l.total;
    m.set(key, r);
  }
  return [...m.values()].map((r) => ({ ...r, toBuy: r.stock == null && r.onOrder == null ? null : Math.max(0, r.total - (r.stock ?? 0) - (r.onOrder ?? 0)) }));
}

// ───────────────────────── grids for export ─────────────────────────

const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

/** One equipment list per top-level unit, in the drawing-set layout. Returns grids plus the row indices of group lines. */
export function equipmentListGrids(units: BomNode[], ctx?: BomCtx): { name: string; title: string; grid: Grid; groupRows: number[] }[] {
  const all = explode(units, ctx);
  return units.map((u) => {
    const multi = (u.qty || 1) > 1;
    const head = ["No.", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", multi ? `QTY/${u.tags[0]?.replace(/[.\d]+$/, "") || "UNIT"}` : "QTY", "PREFIX", ...(multi ? ["TOTAL"] : []), "DEVICE TAGS"];
    const title = `EQUIPMENT LIST - ${u.tags.length > 1 ? (u.tags[0].replace(/[.\d]+$/, "") || u.name) : u.tags[0] || u.name}`;
    const grid: Grid = [head];
    const groupRows: number[] = [];
    for (const l of all.filter((x) => x.unitId === u.id && (!x.line || x.alias))) {
      const isSection = l.kind === "group" && !l.manufacturer && !l.partNumber && !l.tags.length;
      if (l.kind === "group") groupRows.push(grid.length);
      // PREFIX: exactly the Project BOM's Prefix column; DEVICE TAGS: every full device tag defined.
      const tagCol = l.prefixCell;
      grid.push([
        l.itemNo, l.manufacturer, l.projectPn ?? l.partNumber, l.description,
        isSection || l.line ? "" : fmtQty(l.perUnit),
        tagCol, ...(multi ? [isSection ? "" : fmtQty(l.total)] : []), (l.kind === "part" ? l.fullTags : []).join(", "),
      ]);
    }
    return { name: unitLabelOf(u).slice(0, 31), title, grid, groupRows };
  });
}

export function rollupGrid(rows: RollupRow[], unitLabels: string[]): Grid {
  return [
    ["MANUFACTURER", "PART NUMBER", "DESCRIPTION", ...unitLabels, "TOTAL", "IN STOCK", "ON ORDER", "TO BUY", "UNIT PRICE", "EXT. PRICE"],
    ...rows.map((r) => [
      r.manufacturer, r.partNumber, r.description, ...unitLabels.map((u) => (r.byUnit[u] ? fmtQty(r.byUnit[u]) : "")), fmtQty(r.total),
      r.stock == null ? "" : String(r.stock), r.onOrder == null ? "" : String(r.onOrder), r.toBuy == null ? "" : fmtQty(r.toBuy),
      r.price == null ? "" : r.price.toFixed(2), r.price == null ? "" : (r.price * r.total).toFixed(2),
    ]),
  ];
}

/** Device-tag list (every tagged line, every unit instance). */
export function tagListGrid(units: BomNode[], ctx?: BomCtx): Grid {
  const g: Grid = [["FULL TAG", "LOCAL TAG", "UNIT", "ITEM", "MANUFACTURER", "PART NUMBER", "DESCRIPTION"]];
  const nos = itemNumbers(units);
  for (const u of units) {
    const inst = Math.max(1, u.tags.length || 1);
    for (let k = 0; k < inst; k++) {
      walk([u], (n, parents) => {
        if (!n.tags.length) return;
        const id = nodeIdentity(n, ctx);
        fullTagsOf(n, parents, k).forEach((ft, i) => {
          // The unit itself: one row per instance.
          if (n === u && i !== k) return;
          g.push([ft, n.tags[i], u.tags[k] ?? u.tags[0] ?? u.name, nos.get(n.id) ?? "", id.manufacturer, id.part && ctx?.pn ? ctx.pn(id.part) : id.partNumber, id.description]);
        });
      });
    }
  }
  return g;
}

// ───────────────────────── compare versions ─────────────────────────

export type DiffStatus = "added" | "removed" | "increased" | "decreased" | "changed" | "same";
export interface RollupDiff {
  key: string;
  manufacturer: string;
  partNumber: string;
  description: string;
  a: number;
  b: number;
  delta: number;
  status: DiffStatus;
  notes: string[];
}
export interface LineDiff {
  status: DiffStatus;
  unit: string;
  itemNo: string;
  a?: BomLine;
  b?: BomLine;
  changes: string[];
}
export interface BomDiff {
  rollup: RollupDiff[];
  lines: LineDiff[];
  summary: Record<DiffStatus, number>;
}

/** Compare two BOM versions (A = older, B = newer): purchasing totals by part, and line-by-line changes. */
export function diffBom(a: BomNode[], b: BomNode[], ctxA?: BomCtx, ctxB?: BomCtx): BomDiff {
  const ra = new Map(rollup(a, ctxA).map((r) => [r.key, r]));
  const rb = new Map(rollup(b, ctxB ?? ctxA).map((r) => [r.key, r]));
  const keys = [...new Set([...ra.keys(), ...rb.keys()])];
  const rollupD: RollupDiff[] = keys.map((k) => {
    const x = ra.get(k);
    const y = rb.get(k);
    const ta = x?.total ?? 0;
    const tb = y?.total ?? 0;
    const notes: string[] = [];
    if (x && y && x.description !== y.description) notes.push(`Description: "${x.description}" → "${y.description}"`);
    const units = [...new Set([...Object.keys(x?.byUnit ?? {}), ...Object.keys(y?.byUnit ?? {})])];
    for (const u of units) {
      const ua = x?.byUnit[u] ?? 0;
      const ub = y?.byUnit[u] ?? 0;
      if (ua !== ub) notes.push(`${u}: ${fmtQty(ua)} → ${fmtQty(ub)}`);
    }
    const status: DiffStatus = !x ? "added" : !y ? "removed" : tb > ta ? "increased" : tb < ta ? "decreased" : notes.length ? "changed" : "same";
    const r = y ?? x!;
    return { key: k, manufacturer: r.manufacturer, partNumber: r.partNumber, description: r.description, a: ta, b: tb, delta: tb - ta, status, notes };
  });
  const order: Record<DiffStatus, number> = { added: 0, removed: 1, increased: 2, decreased: 3, changed: 4, same: 5 };
  rollupD.sort((p, q) => order[p.status] - order[q.status] || p.manufacturer.localeCompare(q.manufacturer) || p.partNumber.localeCompare(q.partNumber));

  // Lines: match by node id (ids are kept between versions of a project), then by unit + part number + item number.
  const la = explode(a, ctxA);
  const lb = explode(b, ctxB ?? ctxA);
  const usedB = new Set<number>();
  const lines: LineDiff[] = [];
  const idxB = new Map(lb.map((l, i) => [l.nodeId, i]));
  const sig = (l: BomLine) => `${l.unit}|${partKey(l.manufacturer, l.partNumber)}|${l.description.toUpperCase()}`;
  const pairs: [BomLine | undefined, BomLine | undefined][] = [];
  const pendingA: BomLine[] = [];
  for (const x of la) {
    const j = idxB.get(x.nodeId);
    if (j != null && !usedB.has(j)) (usedB.add(j), pairs.push([x, lb[j]]));
    else pendingA.push(x);
  }
  for (const x of pendingA) {
    const j = lb.findIndex((y, i) => !usedB.has(i) && sig(y) === sig(x));
    if (j >= 0) (usedB.add(j), pairs.push([x, lb[j]]));
    else pairs.push([x, undefined]);
  }
  lb.forEach((y, i) => usedB.has(i) || pairs.push([undefined, y]));
  for (const [x, y] of pairs) {
    const changes: string[] = [];
    if (x && y) {
      if (partKey(x.manufacturer, x.partNumber) !== partKey(y.manufacturer, y.partNumber)) changes.push(`Part: ${x.manufacturer} ${x.partNumber} → ${y.manufacturer} ${y.partNumber}`);
      if (x.description !== y.description) changes.push("Description changed");
      if (x.perUnit !== y.perUnit) changes.push(`Qty: ${fmtQty(x.perUnit)} → ${fmtQty(y.perUnit)}`);
      if (x.total !== y.total && x.perUnit === y.perUnit) changes.push(`Total: ${fmtQty(x.total)} → ${fmtQty(y.total)}`);
      if (x.tags.join(",") !== y.tags.join(",")) changes.push(`Tags: ${x.tags.join(", ") || "—"} → ${y.tags.join(", ") || "—"}`);
      if (x.itemNo !== y.itemNo) changes.push(`Item: ${x.itemNo} → ${y.itemNo}`);
      if (x.unit !== y.unit) changes.push(`Unit: ${x.unit} → ${y.unit}`);
    }
    const status: DiffStatus = !x ? "added" : !y ? "removed" : y.total > x.total ? "increased" : y.total < x.total ? "decreased" : changes.length ? "changed" : "same";
    const r = (y ?? x)!;
    lines.push({ status, unit: r.unit, itemNo: r.itemNo, a: x, b: y, changes });
  }
  const summary: Record<DiffStatus, number> = { added: 0, removed: 0, increased: 0, decreased: 0, changed: 0, same: 0 };
  rollupD.forEach((r) => summary[r.status]++);
  return { rollup: rollupD, lines, summary };
}

export function diffGrids(d: BomDiff, labelA: string, labelB: string): { name: string; grid: Grid }[] {
  return [
    {
      name: "Purchasing changes",
      grid: [
        ["STATUS", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", `QTY ${labelA}`, `QTY ${labelB}`, "Δ", "NOTES"],
        ...d.rollup.filter((r) => r.status !== "same").map((r) => [r.status.toUpperCase(), r.manufacturer, r.partNumber, r.description, fmtQty(r.a), fmtQty(r.b), (r.delta > 0 ? "+" : "") + fmtQty(r.delta), r.notes.join("; ")]),
      ],
    },
    {
      name: "Line changes",
      grid: [
        ["STATUS", "UNIT", "ITEM", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", "TAGS", "CHANGES"],
        ...d.lines.filter((l) => l.status !== "same").map((l) => {
          const r = (l.b ?? l.a)!;
          return [l.status.toUpperCase(), l.unit, l.itemNo, r.manufacturer, r.partNumber, r.description, r.tags.join(", "), l.changes.join("; ")];
        }),
      ],
    },
    {
      name: "All parts",
      grid: [["STATUS", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", `QTY ${labelA}`, `QTY ${labelB}`, "Δ"], ...d.rollup.map((r) => [r.status.toUpperCase(), r.manufacturer, r.partNumber, r.description, fmtQty(r.a), fmtQty(r.b), (r.delta > 0 ? "+" : "") + fmtQty(r.delta)])],
    },
  ];
}

// ───────────────────────── load schedule ─────────────────────────

export interface LoadEntry {
  id: string;
  /**
   * node: a BOM line (its part's input power × units, or one tagged unit);
   * bus:  a downstream bus supplied from this one (adds its total and its source's losses);
   * loss: conversion losses of an in-line device (e.g. redundancy module) on the subtotal so far;
   * manual: free entry.
   */
  kind: "node" | "bus" | "loss" | "manual";
  nodeId?: string;
  /** node: only this tag (one unit); empty = every unit on the line. */
  tag?: string;
  busId?: string;
  label: string;
  /** manual: W; node: override (blank = from the part). */
  watts: number | null;
  /** loss: efficiency 0–1. */
  efficiency?: number | null;
  /** Multiplier (e.g. 0.5 when two feeders share the load). Default 1. */
  factor?: number | null;
}
export interface LoadBus {
  id: string;
  /** e.g. "LOAD SCHEDULE - EMS ENCLOSURE (RACK.01-PSTR.01A)" */
  title: string;
  /** e.g. "L-N 230VAC, 50HZ, FEEDER #1" or "24VDC (FROM PS.01/.02) -PDU.02" */
  subtitle: string;
  kind: PowerKind;
  voltage: number | null;
  pf: number | null;
  /** Source feeding this bus (power supply, UPS, inverter). */
  source: { label: string; nodeId?: string | null; ratingW: number | null; ratingA: number | null; efficiency: number | null };
  /** OCPD sizing factor (default 1.25). */
  ocpdFactor: number | null;
  entries: LoadEntry[];
}
export interface LoadRow {
  entryId: string;
  description: string;
  watts: number;
  auto: boolean;
  warn?: string;
}
export interface LoadResult {
  busId: string;
  rows: LoadRow[];
  totalW: number;
  amps: number | null;
  ocpdA: number | null;
  /** Source rating used for loading (W or A). */
  rating: string;
  loadingPct: number | null;
  issues: string[];
}

export const emptyBus = (over: Partial<LoadBus> = {}): LoadBus => ({
  id: newId(), title: "LOAD SCHEDULE", subtitle: "", kind: "AC1", voltage: 230, pf: 1, source: { label: "", nodeId: null, ratingW: null, ratingA: null, efficiency: null }, ocpdFactor: 1.25, entries: [], ...over,
});

/** Amps for W on a bus (AC1: W / (V·pf); AC3: W / (√3·V·pf); DC: W / V). */
export function busAmps(w: number, kind: PowerKind, v: number | null, pf: number | null): number | null {
  if (!v) return null;
  if (kind === "AC3") return w / (Math.sqrt(3) * v * (pf || 1));
  if (kind === "AC1") return w / (v * (pf || 1));
  return w / v;
}

/** Compute every bus of the schedule (downstream buses first, cycles reported). */
export function computeLoads(buses: LoadBus[], units: BomNode[], ctx?: BomCtx): Map<string, LoadResult> {
  const out = new Map<string, LoadResult>();
  const nodes = new Map<string, { n: BomNode; parents: BomNode[] }>();
  walk(units, (n, parents) => nodes.set(n.id, { n, parents }));
  const byId = new Map(buses.map((b) => [b.id, b]));
  const visiting = new Set<string>();
  const calc = (bus: LoadBus): LoadResult => {
    const done = out.get(bus.id);
    if (done) return done;
    const issues: string[] = [];
    if (visiting.has(bus.id)) return { busId: bus.id, rows: [], totalW: 0, amps: null, ocpdA: null, rating: "", loadingPct: null, issues: ["Circular supply between buses"] };
    visiting.add(bus.id);
    const rows: LoadRow[] = [];
    let sub = 0;
    for (const e of bus.entries) {
      const f = e.factor ?? 1;
      if (e.kind === "manual") {
        const w = (e.watts ?? 0) * f;
        rows.push({ entryId: e.id, description: e.label || "(load)", watts: w, auto: false });
        sub += w;
      } else if (e.kind === "node") {
        const hit = e.nodeId ? nodes.get(e.nodeId) : undefined;
        if (!hit) {
          rows.push({ entryId: e.id, description: e.label || "(missing BOM line)", watts: (e.watts ?? 0) * f, auto: false, warn: "BOM line not found" });
          sub += (e.watts ?? 0) * f;
          continue;
        }
        const id = nodeIdentity(hit.n, ctx);
        const unitW = e.watts ?? partWatts(id.part) ?? null;
        const units = e.tag ? 1 : Math.max(1, hit.n.qty || 1);
        const w = (unitW ?? 0) * units * f;
        const tags = e.tag ? [e.tag] : hit.n.tags;
        const tagTxt = tags.length ? ` (${tags.map((t) => signed(t, "prod")).join(", ")})` : units > 1 ? ` (QTY ${units})` : "";
        rows.push({
          entryId: e.id, description: `${e.label || id.part?.series || id.partNumber || id.description}${tagTxt}`.toUpperCase(), watts: w, auto: e.watts == null,
          warn: unitW == null ? "No power rating on the part (set W in the catalog or override here)" : undefined,
        });
        sub += w;
      } else if (e.kind === "loss") {
        const eff = e.efficiency ?? null;
        const w = eff && eff > 0 && eff <= 1 ? sub * (1 / eff - 1) * f : 0;
        rows.push({ entryId: e.id, description: (e.label || "LOSSES").toUpperCase(), watts: w, auto: true, warn: eff ? undefined : "Set the efficiency" });
        sub += w;
      } else if (e.kind === "bus") {
        const down = e.busId ? byId.get(e.busId) : undefined;
        if (!down) {
          rows.push({ entryId: e.id, description: e.label || "(missing bus)", watts: 0, auto: false, warn: "Bus not found" });
          continue;
        }
        const r = calc(down);
        if (r.issues.includes("Circular supply between buses")) issues.push("Circular supply between buses");
        const src = down.source.label || down.title;
        const w = r.totalW * f;
        rows.push({ entryId: e.id, description: (e.label || `POWER SUPPLY (${src})`).toUpperCase(), watts: w, auto: true });
        sub += w;
        const eff = down.source.efficiency;
        if (eff && eff > 0 && eff < 1) {
          const loss = r.totalW * (1 / eff - 1) * f;
          rows.push({ entryId: `${e.id}:loss`, description: `MAX POWER SUPPLY LOSSES (${src})`.toUpperCase(), watts: loss, auto: true });
          sub += loss;
        }
      }
    }
    visiting.delete(bus.id);
    const amps = busAmps(sub, bus.kind, bus.voltage, bus.pf);
    const ocpdA = amps == null ? null : amps * (bus.ocpdFactor ?? 1.25);
    let loadingPct: number | null = null;
    let rating = "";
    if (bus.source.ratingW) ((loadingPct = (sub / bus.source.ratingW) * 100), (rating = `${bus.source.ratingW} W`));
    else if (bus.source.ratingA && amps != null) ((loadingPct = (amps / bus.source.ratingA) * 100), (rating = `${bus.source.ratingA} A`));
    if (loadingPct != null && loadingPct > 80) issues.push(`Source loading ${loadingPct.toFixed(1)} % exceeds 80 %`);
    if (!bus.voltage) issues.push("Set the bus voltage to compute amps");
    const res: LoadResult = { busId: bus.id, rows, totalW: sub, amps, ocpdA, rating, loadingPct, issues };
    out.set(bus.id, res);
    return res;
  };
  buses.forEach(calc);
  return out;
}

/** Load-schedule tables in the drawing-set layout (DESCRIPTION | LOAD). */
export function loadGrid(bus: LoadBus, r: LoadResult): Grid {
  const n = (x: number | null, d = 2) => (x == null ? "" : x.toFixed(d));
  const g: Grid = [[bus.title, ""], [bus.subtitle, ""], ["DESCRIPTION", "LOAD (W)"], ...r.rows.map((x) => [x.description, n(x.watts, 1)])];
  g.push(["TOTAL LOAD", n(r.totalW, 1)], ["TOTAL AMPS", n(r.amps)], [`OCPD ${Math.round((bus.ocpdFactor ?? 1.25) * 100)}%`, n(r.ocpdA)]);
  if (bus.source.ratingW || bus.source.ratingA) g.push([`${(bus.source.label || "SOURCE").toUpperCase()} SIZE`, bus.source.ratingW ? `${bus.source.ratingW} W` : `${bus.source.ratingA} A`], ["LOADING (%)", n(r.loadingPct, 1)]);
  return g;
}

/** Candidate loads for a bus: BOM lines whose part has an input-power rating, with their unit / tags. */
export function powerNodes(units: BomNode[], ctx?: BomCtx): { node: BomNode; unit: string; itemNo: string; label: string; watts: number | null; kind: PowerKind; voltage: number | null }[] {
  const nos = itemNumbers(units);
  const out: ReturnType<typeof powerNodes> = [];
  for (const u of units)
    walk(u.children, (n) => {
      if (n.kind !== "part") return;
      const id = nodeIdentity(n, ctx);
      if (!id.part?.powerIn && !id.part?.powerOut) return;
      out.push({ node: n, unit: u.tags[0] || u.name, itemNo: nos.get(n.id) ?? "", label: `${id.manufacturer} ${id.partNumber}`.trim(), watts: partWatts(id.part), kind: id.part?.powerIn?.kind ?? "", voltage: id.part?.powerIn?.voltage ?? null });
    });
  return out;
}

// ───────────────────────── equipment-list importer ─────────────────────────

const H = (s: string) => (s ?? "").toUpperCase().replace(/[^A-Z/]+/g, "");

/**
 * Parse an equipment list sheet in the drawing-set layout (No. | MANUFACTURER | PART NUMBER | DESCRIPTION | QTY | PREFIX [| TOTAL])
 * into a top-level unit. The unit tag comes from "EQUIPMENT LIST - RACK.01" (or `unitTag`). Item numbers rebuild the tree:
 * A → section, A1 → group, A1.1 → line, A1.1a → lettered line items.
 */
export function parseEquipmentList(grid: Grid, o: { unitTag?: string; match?: (mfr: string, pn: string) => Part | undefined; keepNumbers?: boolean } = {}): { unit: BomNode; warnings: string[]; parts: PartSnap[] } {
  const warnings: string[] = [];
  const hi = grid.findIndex((r) => r.some((c) => /^NO\.?$/i.test((c ?? "").trim())) && r.some((c) => H(c) === "PARTNUMBER"));
  if (hi < 0) throw new Error("Header row with No. and PART NUMBER not found");
  const head = grid[hi].map(H);
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const cNo = head.findIndex((h, i) => /^NO\.?$/i.test(grid[hi][i].trim()));
  const cM = col("MANUFACTURER", "MFR", "MAKE");
  const cP = col("PARTNUMBER", "PN");
  const cD = col("DESCRIPTION");
  const cQ = head.findIndex((h) => h.startsWith("QTY"));
  const cX = col("PREFIX", "TAG", "DEVICETAG");
  const cT = col("TOTAL");
  const titleRow = grid.slice(0, hi).flat().find((c) => /EQUIPMENT LIST/i.test(c ?? "")) ?? "";
  const unitTag = o.unitTag ?? (titleRow.split(/[-–]\s*/).slice(1).join("-").trim() || "UNIT");
  const unit = groupNode("", { tags: [unitTag], role: "loc" });
  const parts: PartSnap[] = [];
  let unitQty: number | null = null;
  const v = (r: string[], c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
  let section: BomNode | null = null;
  let group: BomNode | null = null;
  let line: BomNode | null = null;
  let lineNo = "";
  let first = true;
  const orig = new Map<BomNode, string>();
  const last = () => {
    const l = (line ?? group ?? section)?.children;
    return l?.[l.length - 1];
  };
  for (const r of grid.slice(hi + 1)) {
    const no = v(r, cNo);
    const before = countNodes(unit);
    if (!no && !v(r, cP) && !v(r, cD)) continue;
    const mfr = v(r, cM);
    const pn = v(r, cP);
    const desc = v(r, cD);
    const qty = Number(v(r, cQ).replace(",", ".")) || 0;
    const pre = parseTag(v(r, cX));
    const total = Number(v(r, cT)) || 0;
    if (total && qty && unitQty == null) unitQty = Math.round(total / qty);
    const tagFields = (q: number): Partial<BomNode> => {
      if (!pre.tag) return {};
      // "-RACK.01" (complete) → tag; "-FAN." / "NS." (prefix only) → prefix.
      if (/[.\-]$/.test(pre.tag) || q > 1) return { prefix: pre.tag };
      return { tags: [pre.tag] };
    };
    let m: RegExpMatchArray | null;
    if ((m = no.match(/^([A-Z]+)$/))) {
      section = groupNode(desc || mfr, { itemNo: undefined });
      if (first && m[1] !== "A") unit.sectionStart = m[1];
      first = false;
      unit.children.push(section);
      group = line = null;
    } else if ((m = no.match(/^([A-Z]+)(\d+)$/))) {
      if (!section) unit.children.push((section = groupNode("")));
      const asPart = !!pn;
      const node = asPart ? mkPart(mfr, pn, desc, qty || 1, o.match) : groupNode(desc, { maker: mfr || undefined, qty: qty || 1, ...tagFields(1) });
      if (asPart) Object.assign(node, tagFields(qty));
      section.children.push(node);
      group = node;
      line = null;
      if (asPart) parts.push({ manufacturer: mfr, partNumber: pn, description: desc });
    } else if ((m = no.match(/^([A-Z]+\d+)\.(\d+)([a-z])?$/))) {
      if (!group) {
        if (!section) unit.children.push((section = groupNode("")));
        section.children.push((group = groupNode("")));
      }
      const node = mkPart(mfr, pn, desc, qty || 1, o.match);
      Object.assign(node, tagFields(qty));
      if (pn) parts.push({ manufacturer: mfr, partNumber: pn, description: desc });
      if (m[3]) {
        const key = `${m[1]}.${m[2]}`;
        if (!line || lineNo !== key) {
          line = groupNode("", { line: true });
          lineNo = key;
          group.children.push(line);
        }
        line.children.push(node);
      } else {
        line = null;
        group.children.push(node);
      }
    } else {
      warnings.push(`Row "${no}" ${pn}: item number not recognised; added under the current group`);
      (group ?? section ?? unit).children.push(mkPart(mfr, pn, desc, qty || 1, o.match));
    }
    if (countNodes(unit) > before) {
      const n = no.match(/^[A-Z]+$/) ? section : no.match(/^[A-Z]+\d+$/) ? group : last();
      if (n) orig.set(n, no);
    }
  }
  if (o.keepNumbers) {
    // Pin item numbers that differ from the automatic numbering (gaps or out-of-order numbers in the sheet).
    const auto = itemNumbers([unit]);
    for (const [n, no] of orig) if (auto.get(n.id) !== no) n.itemNo = no;
    // Lettered lines: pin the line group so its children letter from it.
    walk([unit], (n) => {
      if (!n.line || !n.children.length) return;
      const c = orig.get(n.children[0]);
      if (c && c.length > 1) {
        const base = c.slice(0, -1);
        if (itemNumbers([unit]).get(n.id) !== base) n.itemNo = base;
        n.children.forEach((k) => {
          if (orig.get(k) && itemNumbers([unit]).get(k.id) === orig.get(k)) delete k.itemNo;
        });
      }
    });
  }
  if (unitQty && unitQty > 1) {
    unit.qty = unitQty;
    const base = unitTag.replace(/[.\s]+$/, "");
    unit.tags = Array.from({ length: unitQty }, (_, i) => `${base}.${String(i + 1).padStart(2, "0")}`);
    warnings.push(`${unitQty} instances of ${unitTag} (from the TOTAL column); tags ${unit.tags[0]} … ${unit.tags[unit.tags.length - 1]} — rename to your scheme`);
  }
  return { unit, warnings, parts };
}
function countNodes(n: BomNode): number {
  return 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
}
function mkPart(mfr: string, pn: string, desc: string, qty: number, match?: (m: string, p: string) => Part | undefined): BomNode {
  const hit = pn ? match?.(mfr, pn) : undefined;
  return { id: newId(), kind: "part", name: "", partId: hit?.id ?? null, snap: { manufacturer: mfr, partNumber: pn, description: desc }, qty, tags: [], children: [] };
}

/** Refresh every part line's snapshot from the live catalog (done before saving a version). */
export function refreshSnaps(units: BomNode[], ctx: BomCtx): BomNode[] {
  const rec = (l: BomNode[]): BomNode[] =>
    l.map((n) => {
      const p = n.partId ? ctx.parts.get(n.partId) : undefined;
      const snap = p ? { manufacturer: p.manufacturer, partNumber: p.partNumber, description: p.description } : n.snap;
      return { ...n, snap: n.kind === "part" ? snap ?? null : n.snap, children: rec(n.children) };
    });
  return rec(units);
}

/** Lines whose part is not (or no longer) in the catalog. */
export function unlinkedLines(units: BomNode[], ctx: BomCtx): BomNode[] {
  const out: BomNode[] = [];
  walk(units, (n) => n.kind === "part" && (!n.partId || !ctx.parts.has(n.partId)) && out.push(n));
  return out;
}

/** Default document order of the documentation package: datasheets, manuals, user guides first, then the other kinds by name. */
export const DEFAULT_DOC_ORDER = '(["Datasheet", "Manual", "User guide"].index(kind) if kind in ["Datasheet", "Manual", "User guide"] else 3, kind, title)';
