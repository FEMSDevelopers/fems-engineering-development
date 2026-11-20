/**
 * Point list builder: turns pasted raw tables into a protocol point list with reusable rules.
 *
 *   inputs (pasted grids, versioned separately)
 *     → tables      (row filters + one rule chain per output column)
 *     → placements  (each table placed once or repeated as an array of blocks, with address offsets)
 *     → result      (every populated point, with blocks and an issue list)
 *
 * The whole build (protocol, input slots, tables, placements) is the reusable template.
 */
import { isBlankRow } from "./grid.js";
import { codeNames, evalExpr, exprNames, PyDict, PyError, PyFloat, runCode, type PyValue } from "./expr.js";
import { normDnp3Type, resolveModbus } from "./protocol.js";
import { normName } from "./ruleset.js";
import type { Grid } from "./types.js";
import type { Ver } from "./version.js";

export type PlProtocol = "modbus" | "dnp3" | "iec104";
export const PL_PROTOCOLS: Record<PlProtocol, string> = { modbus: "Modbus TCP", dnp3: "DNP3", iec104: "IEC 60870-5-104" };

// --- target fields -----------------------------------------------------------------

export interface PlField {
  key: string;
  label: string;
  type: "num" | "str";
  required?: boolean;
  hint?: string;
}
const F = (key: string, label: string, type: "num" | "str", required = false, hint?: string): PlField => ({ key, label, type, required, hint });
const TAIL = [F("dataType", "Data type", "str", false, "bool, int16, uint16, int32, uint32, float32, int64, uint64, float64, string"), F("scale", "Scale", "num"), F("units", "Units", "str"), F("access", "Access", "str", false, "R, W or RW")];
export const PL_FIELDS: Record<PlProtocol, PlField[]> = {
  modbus: [
    F("tag", "Tag", "str", true),
    F("description", "Description", "str"),
    F("regType", "Register type", "str", true, "HR, IR, CO or DI (Modicon 4xxxx addresses also resolve it)"),
    F("address", "Address / index", "num", true, "Location in the server: zero-based register offset (0–65535); Modicon 5/6-digit addresses (40001) are converted"),
    TAIL[0],
    F("length", "Length (registers)", "num", false, "Register count for strings, or to override the data type's size"),
    ...TAIL.slice(1),
  ],
  dnp3: [
    F("tag", "Tag", "str", true),
    F("description", "Description", "str"),
    F("pointType", "Point type / object", "str", true, "AI, BI, AO, BO or CTR (object groups g30, g1, g40, g10, g20 are accepted)"),
    F("index", "Index / address", "num", true, "Location in the server for this point type: 0–65535"),
    F("variation", "Variation", "num"),
    F("eventClass", "Event class", "num", false, "0 to 3"),
    ...TAIL,
  ],
  iec104: [
    F("tag", "Tag", "str", true),
    F("description", "Description", "str"),
    F("typeId", "Type ID", "str", true, "Number (e.g. 13) or mnemonic (M_ME_NC_1)"),
    F("ioa", "IOA (address / index)", "num", true, "Information object address: 1–16777215"),
    ...TAIL,
  ],
};
/** Field holding the address within a space, and the field naming the space. */
export const PL_ADDR: Record<PlProtocol, { addr: string; space: string }> = {
  modbus: { addr: "address", space: "regType" },
  dnp3: { addr: "index", space: "pointType" },
  iec104: { addr: "ioa", space: "" },
};
export const PL_MAX_ADDR: Record<PlProtocol, number> = { modbus: 65535, dnp3: 65535, iec104: 16777215 };

// --- rules -----------------------------------------------------------------------

export type PlRuleOp =
  | "set" | "prefix" | "suffix" | "ifEmpty"
  | "add" | "sub" | "mul" | "div" | "round" | "floor" | "ceil"
  | "map" | "replace" | "extract" | "substr" | "pad" | "case" | "trim"
  | "rowIndex" | "modicon" | "hex" | "words" | "expr" | "code";

/** One step of a column's rule chain. Parameters are strings; most accept placeholders (see `expand`). */
export interface PlRule {
  op: PlRuleOp;
  a?: string;
  b?: string;
  c?: string;
  d?: string;
  e?: string;
  off?: boolean;
}

export interface PlRuleDef {
  op: PlRuleOp;
  label: string;
  group: "Text" | "Number" | "Lookup" | "Protocol" | "Expression";
  params: { key: "a" | "b" | "c" | "d" | "e"; label: string; kind?: "text" | "lines" | "select" | "check" | "expr" | "code"; options?: [string, string][]; ph?: string }[];
  help: string;
  /** Three worked use cases (outputs are computed with applyRule, see ruleExample). */
  examples?: PlRuleExample[];
}
export interface PlRuleExample {
  /** Value before the rule. */
  in: string;
  r: Omit<PlRule, "op">;
  /** Input columns available to {col:…}. */
  cols?: Record<string, string>;
  n?: number;
  row?: number;
  /** Expected output (checked by the tests). */
  out: string;
  note: string;
}
export const PL_RULES: PlRuleDef[] = [
  { op: "set", label: "Set value", group: "Text", params: [{ key: "a", label: "Value", ph: "e.g. Rack{n}_{col:Name}" }, { key: "b", label: "Pad to (characters)", ph: "e.g. 4" }, { key: "c", label: "Pad character", ph: "0" }, { key: "d", label: "Prefix", ph: "e.g. BMS_" }, { key: "e", label: "Suffix", ph: "e.g. _R" }], help: "Replace the value with a template, optionally padded on the left to a width, then prefixed and suffixed. Any placeholder can be formatted inline with filters, e.g. {Result!address|pad:4}." , examples: [{ in: "V_RACK", r: {a: "Rack{nn}_{col:Name}"}, cols: {"Name": "V_RACK"}, n: 3, out: "Rack03_V_RACK", note: "Array tag from the instance number and the Name column" }, { in: "", r: {a: "HR"}, out: "HR", note: "Constant register type for a whole table" }, { in: "x", r: {a: "{col:Signal} ({col:Unit})"}, cols: {"Signal": "Rack voltage", "Unit": "V"}, out: "Rack voltage (V)", note: "Description built from two input columns" }] },
  { op: "prefix", label: "Prefix", group: "Text", params: [{ key: "a", label: "Text", ph: "e.g. BMS{nn}_" }], help: "Add text in front." , examples: [{ in: "SOC", r: {a: "BMS{nn}_"}, n: 2, out: "BMS02_SOC", note: "Prefix each array instance" }, { in: "Breaker", r: {a: "{col:Bay} "}, cols: {"Bay": "F12"}, out: "F12 Breaker", note: "Prefix from another column" }, { in: "1", r: {a: "PCS"}, out: "PCS1", note: "Turn a number into a name" }] },
  { op: "suffix", label: "Suffix", group: "Text", params: [{ key: "a", label: "Text", ph: "e.g. _{col:Units}" }], help: "Add text at the end." , examples: [{ in: "P", r: {a: "_{col:Unit}"}, cols: {"Unit": "kW"}, out: "P_kW", note: "Unit in the tag" }, { in: "Temp", r: {a: "_R{n}"}, n: 4, out: "Temp_R4", note: "Instance number at the end" }, { in: "Rack voltage", r: {a: " (rack {n})"}, out: "Rack voltage (rack 1)", note: "Readable description per instance" }] },
  { op: "ifEmpty", label: "If empty", group: "Text", params: [{ key: "a", label: "Default", ph: "e.g. 1" }], help: "Use a default when the value is empty." , examples: [{ in: "", r: {a: "1"}, out: "1", note: "Default scale of 1" }, { in: "R", r: {a: "RW"}, out: "R", note: "Existing values are kept" }, { in: "", r: {a: "{col:Name}"}, cols: {"Name": "SOC"}, out: "SOC", note: "Fall back to another column" }] },
  { op: "replace", label: "Replace", group: "Text", params: [{ key: "a", label: "Find" }, { key: "b", label: "With" }, { key: "c", label: "Regex", kind: "check" }], help: "Replace every match (plain text or a regular expression; $1 inserts a group)." , examples: [{ in: "V L1-N", r: {a: " ", b: "_"}, out: "V_L1-N", note: "Spaces to underscores" }, { in: "Rack_01_Volt", r: {a: "_(\\d+)_", b: "$1", c: "1"}, out: "Rack01Volt", note: "Regex with a captured group" }, { in: "kW (avg)", r: {a: "\\s*\\(.*\\)", b: "", c: "1"}, out: "kW", note: "Strip a bracketed comment" }] },
  { op: "extract", label: "Extract", group: "Text", params: [{ key: "a", label: "Regex", ph: "e.g. (\\d+)" }, { key: "b", label: "Group", ph: "1" }], help: "Keep only the matching part (empty if no match)." , examples: [{ in: "Reg 40021 (HR)", r: {a: "(\\d+)"}, out: "40021", note: "Number out of free text" }, { in: "Rack 3 cell 12", r: {a: "cell (\\d+)", b: "1"}, out: "12", note: "Specific group" }, { in: "PCS-INV-07", r: {a: "[A-Z]+-([A-Z]+)", b: "1"}, out: "INV", note: "Middle part of a code" }] },
  { op: "substr", label: "Substring", group: "Text", params: [{ key: "a", label: "Start", ph: "0" }, { key: "b", label: "Length", ph: "(rest)" }], help: "Characters from Start (0-based; negative counts from the end)." , examples: [{ in: "40021", r: {a: "1"}, out: "0021", note: "Drop the Modicon table digit" }, { in: "BMS_RACK_SOC", r: {a: "-3"}, out: "SOC", note: "Last three characters" }, { in: "ABCDEF", r: {a: "0", b: "3"}, out: "ABC", note: "First three characters" }] },
  { op: "pad", label: "Pad", group: "Text", params: [{ key: "a", label: "Length", ph: "3" }, { key: "b", label: "Char", ph: "0" }], help: "Pad on the left to a length." , examples: [{ in: "7", r: {a: "3"}, out: "007", note: "Fixed-width numbers in tags" }, { in: "12", r: {a: "4", b: "0"}, out: "0012", note: "Four digits" }, { in: "5", r: {a: "2", b: "_"}, out: "_5", note: "Other fill character" }] },
  { op: "case", label: "Case", group: "Text", params: [{ key: "a", label: "To", kind: "select", options: [["upper", "UPPER"], ["lower", "lower"], ["title", "Title"]] }], help: "Change letter case." , examples: [{ in: "soc", r: {a: "upper"}, out: "SOC", note: "Upper-case tags" }, { in: "RACK VOLTAGE", r: {a: "title"}, out: "Rack Voltage", note: "Readable descriptions" }, { in: "FLOAT32", r: {a: "lower"}, out: "float32", note: "Lower-case data types" }] },
  { op: "trim", label: "Trim", group: "Text", params: [], help: "Remove leading/trailing spaces and collapse inner spaces." , examples: [{ in: "  SOC  ", r: {}, out: "SOC", note: "Leading and trailing spaces" }, { in: "Rack   voltage", r: {}, out: "Rack voltage", note: "Repeated inner spaces" }, { in: " A ", r: {}, out: "A", note: "Units pasted with spaces" }] },
  { op: "add", label: "Add", group: "Number", params: [{ key: "a", label: "Value", ph: "e.g. 100 or {col:Offset}" }], help: "value + x" , examples: [{ in: "40001", r: {a: "-40001"}, out: "0", note: "Modicon 40001 to offset 0" }, { in: "100", r: {a: "{col:Offset}"}, cols: {"Offset": "20"}, out: "120", note: "Offset from another column" }, { in: "0", r: {a: "1"}, out: "1", note: "Zero-based to one-based" }] },
  { op: "sub", label: "Subtract", group: "Number", params: [{ key: "a", label: "Value" }], help: "value − x" , examples: [{ in: "40001", r: {a: "40001"}, out: "0", note: "Holding register to offset" }, { in: "101", r: {a: "1"}, out: "100", note: "One-based to zero-based" }, { in: "30010", r: {a: "30001"}, out: "9", note: "Input register to offset" }] },
  { op: "mul", label: "Multiply", group: "Number", params: [{ key: "a", label: "Value" }], help: "value × x" , examples: [{ in: "0.1", r: {a: "1000"}, out: "100", note: "kW scale to W" }, { in: "2", r: {a: "{col:Words}"}, cols: {"Words": "2"}, out: "4", note: "Multiply by another column" }, { in: "1", r: {a: "0.001"}, out: "0.001", note: "Apply a resolution" }] },
  { op: "div", label: "Divide", group: "Number", params: [{ key: "a", label: "Value" }], help: "value ÷ x" , examples: [{ in: "1000", r: {a: "10"}, out: "100", note: "Per-mille to percent" }, { in: "16", r: {a: "2"}, out: "8", note: "Bytes to registers" }, { in: "1", r: {a: "1000"}, out: "0.001", note: "W scale to kW" }] },
  { op: "round", label: "Round", group: "Number", params: [{ key: "a", label: "Decimals", ph: "0" }], help: "Round to a number of decimals." , examples: [{ in: "3.14159", r: {a: "2"}, out: "3.14", note: "Two decimals" }, { in: "0.30000000004", r: {a: "1"}, out: "0.3", note: "Remove float noise" }, { in: "12.5", r: {a: "0"}, out: "13", note: "Whole number" }] },
  { op: "floor", label: "Floor", group: "Number", params: [], help: "Round down." , examples: [{ in: "12.9", r: {}, out: "12", note: "Whole registers" }, { in: "-0.5", r: {}, out: "-1", note: "Negative values round down" }, { in: "7", r: {}, out: "7", note: "Whole numbers unchanged" }] },
  { op: "ceil", label: "Ceil", group: "Number", params: [], help: "Round up." , examples: [{ in: "12.1", r: {}, out: "13", note: "Registers needed for a size" }, { in: "0.001", r: {}, out: "1", note: "At least one" }, { in: "-1.5", r: {}, out: "-1", note: "Negative values round up" }] },
  { op: "hex", label: "Hex ↔ decimal", group: "Number", params: [{ key: "a", label: "Direction", kind: "select", options: [["toDec", "hex → decimal"], ["toHex", "decimal → hex"]] }], help: "Convert 0x1A / 1Ah ↔ 26." , examples: [{ in: "0x1A", r: {a: "toDec"}, out: "26", note: "Hex address from a vendor map" }, { in: "FFh", r: {a: "toDec"}, out: "255", note: "Suffix notation" }, { in: "4096", r: {a: "toHex"}, out: "0x1000", note: "Decimal to hex" }] },
  { op: "rowIndex", label: "Row counter", group: "Number", params: [{ key: "a", label: "Start", ph: "0" }, { key: "b", label: "Step", ph: "1" }], help: "Start + row × Step over the rows kept by the filters (restarts in each array instance)." , examples: [{ in: "", r: {a: "0", b: "1"}, row: 4, out: "4", note: "Sequential DNP3 index" }, { in: "", r: {a: "100", b: "2"}, row: 3, out: "106", note: "Every second register from 100" }, { in: "", r: {a: "{col:Base}", b: "1"}, cols: {"Base": "1000"}, row: 2, out: "1002", note: "Start from a column value" }] },
  { op: "map", label: "Map values", group: "Lookup", params: [{ key: "a", label: "from = to (one per line)", kind: "lines", ph: "Holding = HR\nInput = IR" }, { key: "b", label: "Otherwise", kind: "select", options: [["keep", "keep value"], ["empty", "empty"], ["value", "use value →"]] }, { key: "c", label: "Value" }], help: "Look up the value (case-insensitive) in a table." , examples: [{ in: "Holding", r: {a: "Holding = HR\nInput = IR", b: "keep"}, out: "HR", note: "Vendor register names" }, { in: "read/write", r: {a: "read = R\nread/write = RW\nwrite = W", b: "keep"}, out: "RW", note: "Access wording" }, { in: "unknown", r: {a: "float = float32", b: "value", c: "uint16"}, out: "uint16", note: "Default when not listed" }] },
  { op: "modicon", label: "Modicon address", group: "Protocol", params: [{ key: "a", label: "Take", kind: "select", options: [["offset", "zero-based offset"], ["table", "register type (HR/IR/CO/DI)"]] }], help: "40001 → 0 / HR, 300010 → 9 / IR, 00005 → 4 / CO." , examples: [{ in: "40001", r: {a: "offset"}, out: "0", note: "Holding register 40001 → offset 0" }, { in: "300010", r: {a: "offset"}, out: "9", note: "6-digit input register" }, { in: "00005", r: {a: "table"}, out: "CO", note: "Register type from the address" }] },
  { op: "words", label: "Data type → registers", group: "Protocol", params: [], help: "int16 → 1, float32 → 2, float64 → 4 (strings: unchanged)." , examples: [{ in: "float32", r: {}, out: "2", note: "32-bit types use 2 registers" }, { in: "UINT16", r: {}, out: "1", note: "16-bit types use 1" }, { in: "float64", r: {}, out: "4", note: "64-bit types use 4" }] },
  { op: "expr", label: "Expression (Python)", group: "Expression", params: [{ key: "a", label: "Expression", kind: "expr", ph: 'e.g. f"{col[\'Register Type\']}_{result.address:04d}"' }], help: "Python expression; the result replaces the value. Names: value, col[\"Header\"], out[\"Column\"], n, i, row, and after placement result.*, unit.*, series[\"Name\"]. Open the builder for the full list.", examples: [{ in: "soc", r: { a: 'value.upper() + "_" + col["Bay Name"]' }, cols: { "Bay Name": "F12" }, out: "SOC_F12", note: "Column with a space in its name" }, { in: "7", r: { a: 'f"{int(value):04d}"' }, out: "0007", note: "Number formatted to 4 digits" }, { in: "", r: { a: '"RW" if col["Mode"].lower() == "write" else "R"' }, cols: { "Mode": "Write" }, out: "RW", note: "Conditional value" }] },
  { op: "code", label: "Python code", group: "Expression", params: [{ key: "a", label: "Code (return the new value)", kind: "code", ph: 'parts = value.split("_")\nreturn parts[-1].upper()' }], help: "Several lines of Python (assignments, if/elif/else, for, while, comprehensions); the value of return replaces the value. Same names as Expression.", examples: [{ in: "BMS_Rack_3_SOC", r: { a: 'parts = value.split("_")\nrack = int(parts[2])\nreturn f"R{rack:02d}_{parts[-1]}"' }, out: "R03_SOC", note: "Split, convert and format" }, { in: "", r: { a: 'kind = col["Kind"].lower()\nif kind == "alarm":\n    return "ALM"\nelif kind == "status":\n    return "STS"\nreturn "VAL"' }, cols: { Kind: "Alarm" }, out: "ALM", note: "Several conditions" }, { in: "a;b;;c", r: { a: 'items = [x.strip() for x in value.split(";") if x.strip()]\nreturn "|".join(items)' }, out: "a|b|c", note: "Clean a list" }] },
];
export const ruleDef = (op: string) => PL_RULES.find((r) => r.op === op);
/** Result of a rule example. */
export function ruleExample(op: PlRuleOp, ex: PlRuleExample): { out: string; warn: string[] } {
  const warn: string[] = [];
  const out = applyRule(ex.in, { op, ...ex.r }, { n: ex.n ?? 1, row: ex.row ?? 0, col: (h) => ex.cols?.[h] ?? "", out: {}, warn: (m) => warn.push(m) }, 1);
  return { out, warn };
}

// --- build model -------------------------------------------------------------------

/** An input slot: a named place for a pasted table, bound to a saved input (variant + version, or latest). */
export interface PlSlot {
  id: string;
  name: string;
  inputId: string | null;
  /** null = always the latest version */
  ver: Ver | null;
}

export type PlFilterOp = "notEmpty" | "empty" | "eq" | "ne" | "contains" | "notContains" | "startsWith" | "regex";
export const PL_FILTER_OPS: [PlFilterOp, string][] = [
  ["notEmpty", "is not empty"], ["empty", "is empty"], ["eq", "equals"], ["ne", "does not equal"],
  ["contains", "contains"], ["notContains", "does not contain"], ["startsWith", "starts with"], ["regex", "matches regex"],
];
export interface PlFilter {
  col: string;
  op: PlFilterOp;
  value?: string;
}

/** One output column: a target field (or a custom column), the input column it starts from and its rule chain. */
export interface PlColumn {
  id: string;
  /** Protocol field key, or "" for a custom (calculated) column. */
  field: string;
  /** Header for custom columns. */
  name?: string;
  type: "num" | "str";
  /** Input header the value starts from ("" = start empty). */
  source: string;
  rules: PlRule[];
}

export interface PlTable {
  id: string;
  name: string;
  slot: string;
  /** 1-based row holding the column headers (rows above are ignored). */
  headerRow: number;
  filters: PlFilter[];
  columns: PlColumn[];
  /** What to do with undeclared registers between declared ones. */
  reserve?: PlReserve;
  /** Unit conditioning for the Units column. */
  units?: PlUnits;
  /** Last validation (block size used to set array strides). */
  validated?: { at: string; span: number };
  /** Raw data type → standard data type of the build's data type set. */
  dtMap?: PlDtMap;
}

/**
 * Undeclared registers / indexes between the first and last declared one of a table:
 *   leave — stay free; other placements ("Into free registers") may use them
 *   fill  — every gap is filled with reserved points of `dataType`
 *   gapN  — only the first `n` registers of each gap are reserved; the rest stay free
 */
export type PlReserveMode = "leave" | "fill" | "gapN";
export interface PlReserve {
  mode: PlReserveMode;
  n: number;
  dataType: string;
}
export const PL_RESERVE_MODES: [PlReserveMode, string][] = [["fill", "Fill all with reserved"], ["gapN", "Reserve n per gap"], ["leave", "Leave free for other placements"]];
/** Data types offered for reserved points (bit spaces always use bool; counters uint32). */
export const PL_RESERVE_TYPES: Record<PlProtocol, [string, string][]> = {
  modbus: [["uint16", "uint16 (1 register)"], ["int16", "int16 (1 register)"], ["uint32", "uint32 (2 registers)"], ["int32", "int32 (2 registers)"], ["float32", "float32 (2 registers)"], ["float64", "float64 (4 registers)"]],
  dnp3: [["int16", "int16"], ["int32", "int32"], ["float32", "float32"]],
  iec104: [["M_ME_NB_1", "11 M_ME_NB_1 · scaled"], ["M_ME_NC_1", "13 M_ME_NC_1 · float"], ["M_SP_NA_1", "1 M_SP_NA_1 · single point"], ["M_DP_NA_1", "3 M_DP_NA_1 · double point"], ["M_IT_NA_1", "15 M_IT_NA_1 · integrated total"]],
};
export const defaultReserve = (p: PlProtocol): PlReserve => ({ mode: "leave", n: 1, dataType: PL_RESERVE_TYPES[p][0][0] });

// --- unit conditioning ---------------------------------------------------------------

/** One variable category: units it accepts (case-insensitive), their proper spelling and the desired unit. */
export interface PlUnitRow {
  variable: string;
  /** Accepted units, comma or slash separated, matched case-insensitively (first match wins). */
  match: string;
  /** Proper spelling for each accepted unit, in the same order. */
  proper: string;
  /** Unit every value of this variable is scaled to (Unit-Scaling column). */
  desired: string;
}
export interface PlUnits {
  on: boolean;
  /** Category name used when saving, e.g. PowerEnergy. */
  name: string;
  rows: PlUnitRow[];
}
export const DEFAULT_UNIT_ROWS: PlUnitRow[] = [
  { variable: "Current", match: "ma, a, ka", proper: "mA, A, kA", desired: "A" },
  { variable: "Voltage", match: "mv, v, kv", proper: "mV, V, kV", desired: "kV" },
  { variable: "Active power", match: "w, kw, mw, gw", proper: "W, kW, MW, GW", desired: "kW" },
  { variable: "Reactive power", match: "var, kvar, mvar, gvar", proper: "VAR, kVAR, MVAR, GVAR", desired: "kVAR" },
  { variable: "Apparent power", match: "va, kva, mva, gva", proper: "VA, kVA, MVA, GVA", desired: "kVA" },
  { variable: "Energy", match: "wh, kwh, mwh, gwh", proper: "Wh, kWh, MWh, GWh", desired: "kWh" },
];
export const defaultUnits = (): PlUnits => ({ on: false, name: "PowerEnergy", rows: DEFAULT_UNIT_ROWS.map((r) => ({ ...r })) });
const PREFIX: Record<string, number> = { "": 1, p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, c: 1e-2, k: 1e3, M: 1e6, G: 1e9, T: 1e12 };
const splitList = (s: string) => s.split(/[,/;]/).map((x) => x.trim()).filter(Boolean);
/** Multiplier of a unit relative to the base unit (the shortest proper spelling), from its SI prefix. */
function prefixOf(unit: string, base: string): number | null {
  if (unit === base) return 1;
  if (!base || !unit.endsWith(base)) return null;
  const f = PREFIX[unit.slice(0, unit.length - base.length)];
  return f ?? null;
}
export interface PlUnitMatch {
  variable: string;
  /** Proper spelling of the row's unit. */
  proper: string;
  desired: string;
  /** Multiply the value by this to express it in the desired unit (null when it can't be derived from SI prefixes). */
  factor: number | null;
}
/** Look a unit up in the unit conditioning (case-insensitive). */
export function matchUnit(rows: PlUnitRow[], unit: string): PlUnitMatch | null {
  const u = unit.trim().toLowerCase();
  if (!u) return null;
  for (const r of rows) {
    const m = splitList(r.match);
    const pr = splitList(r.proper);
    let i = m.findIndex((x) => x.toLowerCase() === u);
    if (i < 0) i = pr.findIndex((x) => x.toLowerCase() === u);
    if (i < 0) continue;
    const proper = pr[i] ?? m[i] ?? unit.trim();
    const all = pr.length ? pr : m;
    const base = all.reduce((a, b) => (b.length < a.length ? b : a), all[0] ?? "");
    const desired = r.desired.trim() || proper;
    const a = prefixOf(proper, base);
    const d = prefixOf(desired, base);
    return { variable: r.variable, proper, desired, factor: a != null && d != null ? a / d : null };
  }
  return null;
}
/**
 * How a table is laid out in the address space:
 *   start — at its own addresses; instance k shifted by k × stride ("from array start block")
 *   zero  — re-based so its first register is `start`; instance k at start + k × stride ("from register 0")
 *   last  — after the last register already used in each space + gap; instances packed by stride ("from last known register")
 *   free  — each instance goes to the first address (from `start`) where its declared registers are all still free,
 *           e.g. into the gaps another table left free ("Into free registers")
 */
export type PlMode = "start" | "zero" | "last" | "free";
export const PL_MODES: [PlMode, string][] = [["start", "From array start block"], ["zero", "From register 0"], ["last", "From last known register"], ["free", "Into free registers"]];
export interface PlPlacement {
  id: string;
  name: string;
  table: string;
  /** 1 = place the table once; more = array of blocks. */
  count: number;
  mode: PlMode;
  /** zero mode: first register of instance 1; free mode: address the search starts from. */
  start: number;
  /** Registers between instance starts; 0 = block size (packed). */
  stride: number;
  /** last mode: free registers left before the first block. */
  gap: number;
  /** Number given to the first instance for {n} / {nn}. */
  nStart: number;
  off?: boolean;
}

export interface PlBuild {
  protocol: PlProtocol;
  slots: PlSlot[];
  tables: PlTable[];
  placements: PlPlacement[];
  /** Source last published from this build. */
  publish?: { sourceId: string | null; name: string };
  /** Standard data types (protocol independent) that tables map their raw data types to. */
  dataTypes?: PlDtSet;
  /** Function libraries (saved Python def's) available to Expression / Python code rules. */
  libs?: PyLibRef[];
  /** Named counters used as {series:Name}. */
  series?: PlSeries[];
}

// --- standard data types ----------------------------------------------------------------

export type PlDtFamily = "Unsigned" | "Signed" | "Float" | "Enum" | "Bitfield" | "Counter" | "Heartbeat" | "Text" | "Other";
export const PL_DT_FAMILIES: PlDtFamily[] = ["Unsigned", "Signed", "Float", "Enum", "Bitfield", "Counter", "Heartbeat", "Text", "Other"];
export type PlDtBits = "16" | "32" | "64" | "other";
export const PL_DT_BITS: [PlDtBits, string][] = [["16", "16-bit"], ["32", "32-bit"], ["64", "64-bit"], ["other", "Other size"]];
/** A standard data type. `registers` (content size) applies to Modbus TCP / serial only; "" = not fixed (e.g. strings: use Length). */
export interface PlStdType {
  name: string;
  alias: string;
  family: PlDtFamily;
  bits: PlDtBits;
  registers: string;
}
export interface PlDtSet {
  name: string;
  types: PlStdType[];
}
export interface PlDtMap {
  on: boolean;
  /** lower-case raw value → standard type name */
  map: Record<string, string>;
}

/** Family, size and register count guessed from a standard type name (U32 (LE), HB-U16, BITFIELD_64, FLT (BE)…). */
export function inferStdType(name: string, alias = "", registers?: string): PlStdType {
  const n = name.trim();
  const u = n.toUpperCase();
  const fam: PlDtFamily = /^(UTF|ASCII|STR|CHAR|TEXT)/.test(u) ? "Text"
    : /^HB/.test(u) ? "Heartbeat"
    : /^COUNTER|^CNT/.test(u) ? "Counter"
    : /^ENUM/.test(u) ? "Enum"
    : /^BIT|^NUMBIT|BITMASK/.test(u) ? "Bitfield"
    : /^(FLT|FLOAT|REAL|F32|F64|DOUBLE)/.test(u) ? "Float"
    : /^(I\d|INT|S\d|SINT)/.test(u) ? "Signed"
    : /^(U\d|UINT|WORD|DWORD)/.test(u) ? "Unsigned"
    : "Other";
  const m = u.match(/(16|32|64)/);
  let bits: PlDtBits = m ? (m[1] as PlDtBits) : fam === "Float" ? "32" : "other";
  if (fam === "Text" && !/(16|32|64)/.test(u.replace(/^UTF8/, ""))) bits = "other";
  const regs = registers ?? (bits === "16" ? "1" : bits === "32" ? "2" : bits === "64" ? "4" : "");
  return { name: n, alias: alias.trim(), family: fam, bits, registers: regs };
}
const DEFAULT_DT_NAMES = [
  "U16", "I16", "U32", "I32", "ENUM_16", "ENUM_32", "BITFIELD_16", "BITFIELD_32", "FLT (BE)", "FLT (LE)", "BITFIELD_32 (LE)", "BITFIELD_64",
  "BITFIELD_64 (LE)", "Bitmask", "BitmaskArray", "NumBit", "BitNum", "HB", "HB-U16", "HB-U32 (BE)", "HB-U32 (LE)", "Counter-U16",
  "Counter-U32 (BE)", "Counter-U32 (LE)", "I32 (BE)", "I32 (LE)", "I64", "Power_10", "U16_Passthrough", "U32 (BE)", "U32 (LE)",
  "U32_Passthrough", "U64", "U64 (BE)", "U64 (LE)", "UTF8 (BE)", "ASCII", "UNKNOWN",
];
export const defaultDtSet = (): PlDtSet => ({ name: "EMS-SC", types: DEFAULT_DT_NAMES.map((n) => inferStdType(n)) });
const stdOf = (set: PlDtSet | undefined, dt: string) => {
  const k = dt.trim().toLowerCase();
  return k ? set?.types.find((x) => x.name.toLowerCase() === k || (x.alias && x.alias.toLowerCase() === k)) : undefined;
};
export const stdType = stdOf;
/** Bulk import: one type per line — Name [, Alias] [, Content size] [, Family] [, Size 16/32/64/other]; tab, ; or , separated; a header row is skipped. */
export function parseDtTypes(text: string): PlStdType[] {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const d = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : lines.some((l) => /\(.*,.*\)/.test(l)) ? "\t" : ",";
  const body = /^(name|data ?type|type)\b/i.test(lines[0]) ? lines.slice(1) : lines;
  return body.map((l) => {
    const [name = "", alias = "", regs, fam, bits] = l.split(d).map((x) => x.trim());
    const t = inferStdType(name, alias, regs !== undefined && regs !== "" ? regs : undefined);
    if (fam && PL_DT_FAMILIES.some((f) => f.toLowerCase() === fam.toLowerCase())) t.family = PL_DT_FAMILIES.find((f) => f.toLowerCase() === fam.toLowerCase())!;
    if (bits && ["16", "32", "64", "other"].includes(bits.toLowerCase())) t.bits = bits.toLowerCase() as PlDtBits;
    return t;
  }).filter((t) => t.name);
}
const DT_SYN: [RegExp, string][] = [
  [/^(u?int|uint)16$|^u16$|^word$|^ushort$|^unsigned16$/, "U16"],
  [/^int16$|^i16$|^s16$|^short$|^signed16$/, "I16"],
  [/^uint32$|^u32$|^dword$|^udint$|^ulong$/, "U32"],
  [/^int32$|^i32$|^s32$|^dint$|^long$/, "I32"],
  [/^uint64$|^u64$|^ulint$/, "U64"],
  [/^int64$|^i64$|^lint$/, "I64"],
  [/^(float|float32|real|f32|ieee754|single)$/, "FLT (BE)"],
  [/^(string|ascii|str|char|text)$/, "ASCII"],
  [/^utf8$/, "UTF8 (BE)"],
];
/** Suggest standard types for raw values: exact name/alias match first, then common spellings (uint16 → U16, float32 → FLT (BE)…). */
export function autoMatchTypes(raws: string[], set: PlDtSet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of raws) {
    const exact = stdOf(set, r);
    if (exact) {
      out[r.trim().toLowerCase()] = exact.name;
      continue;
    }
    const k = r.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hit = DT_SYN.find(([re]) => re.test(k));
    if (hit && set.types.some((t) => t.name === hit[1])) out[r.trim().toLowerCase()] = hit[1];
  }
  return out;
}

// --- series -----------------------------------------------------------------------------

/** A named counter: {series:Name} takes the next number each time a row uses it (one number per row). */
export interface PlSeries {
  id: string;
  name: string;
  start: number;
  step: number;
  /** "0000" → 0032; zeros (or #) mark the digits, other text is kept ("RK-00" → RK-07); empty = plain number. */
  format: string;
}
export function fmtSeries(n: number, format: string): string {
  const f = format ?? "";
  const m = [...f.matchAll(/0+|#+/g)].pop();
  if (!m) return f ? f + String(n) : String(n);
  const digits = m[0][0] === "0" ? String(Math.abs(n)).padStart(m[0].length, "0") : String(Math.abs(n));
  return f.slice(0, m.index) + (n < 0 ? "-" : "") + digits + f.slice(m.index! + m[0].length);
}
/** Final-address syntax resolved only in the Result: {Result!address}, {Result!modicon}, {Result!end}, {Result!space}, {Result!block}, {Result!n}. */
export const RESULT_TOKENS: [string, string][] = [
  ["address", "Final address / index after placement (zero-based)"],
  ["modicon", "Modbus 5/6-digit reference, e.g. HR 14 → 40015 (other protocols: the address)"],
  ["end", "Last register used (multi-register types)"],
  ["space", "HR / IR / CO / DI, AI / BI / AO / BO / CTR or IOA"],
  ["block", "Placement name"],
  ["n", "Instance number of the array"],
];
const MODICON_PREFIX: Record<string, string> = { CO: "0", DI: "1", IR: "3", HR: "4" };
export function modiconRef(space: string, addr: number): string {
  const pre = MODICON_PREFIX[space];
  if (pre == null) return String(addr);
  const one = addr + 1;
  return pre + (one <= 9999 ? String(one).padStart(4, "0") : String(one).padStart(5, "0"));
}

export const emptyBuild = (protocol: PlProtocol = "modbus"): PlBuild => ({ protocol, slots: [], tables: [], placements: [] });

// --- evaluation ------------------------------------------------------------------

const num = (s: string): number | null => {
  const t = s.trim().replace(/,/g, "");
  if (!t) return null;
  if (/^[+-]?0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16) * (t.startsWith("-") ? -1 : 1);
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
/** Number → text without float noise (0.1 + 0.2 → "0.3"). */
export const fmtNum = (n: number) => String(Number(n.toPrecision(12)));

export interface PlCtx {
  /** Instance number for {n} (nStart-based). */
  n: number;
  /** Filtered row index (0-based) within the table instance. */
  row: number;
  /** Input row by header. */
  col: (h: string) => string;
  /** Output values computed so far in this row. */
  out: Record<string, string>;
  warn: (msg: string) => void;
  /** Output value by column name (custom name or field label), e.g. {out:Source_Device}. */
  outName?: (name: string) => string | undefined;
  /** Values known only after placement (Result, unit, series); absent while conditioning. */
  late?: PlLate;
  /** Extra names for Expression / Python code rules (e.g. el, parent, lookup in the JSON editor). */
  extra?: Record<string, PyValue>;
  /** No placement stage (JSON editor): every rule is evaluated at once. */
  immediate?: boolean;
}

/** Values available after placement. */
export interface PlLate {
  result: Record<string, string | number | null>;
  unit: Record<string, string | number | null>;
  series: (name: string) => string | undefined;
}
/** {unit:…} tokens (resolved in the Result). */
export const UNIT_TOKENS: [string, string][] = [
  ["desired", "Desired unit of the row's variable (Scaled-Unit)"],
  ["proper", "Row unit with proper spelling"],
  ["factor", "Unit-Scaling factor to the desired unit"],
  ["variable", "Variable of the unit set, e.g. Active power"],
];
/** Inline filters for any placeholder: {Result!address|pad:4}. */
export const PL_FILTERS: [string, string][] = [
  ["pad:4", "Pad on the left with 0 to 4 characters (pad:4:_ uses _)"],
  ["prefix:R_", "Add text in front"],
  ["suffix:_x", "Add text at the end"],
  ["fmt:RK-000", "Number format as in Series (zeros mark the digits)"],
  ["py:05.1f", "Python format spec (number)"],
  ["upper", "UPPER CASE"],
  ["lower", "lower case"],
  ["trim", "Remove surrounding spaces"],
  ["default:n/a", "Text used when the value is empty"],
];
/** Apply "|pad:4|prefix:R_" filters to a value. */
export function applyFilters(v: string, filters: string): string {
  if (!filters) return v;
  for (const f of filters.split("|").slice(1)) {
    const i = f.indexOf(":");
    const name = (i < 0 ? f : f.slice(0, i)).trim().toLowerCase();
    const arg = i < 0 ? "" : f.slice(i + 1);
    switch (name) {
      case "pad": {
        const [w, c] = arg.split(":");
        v = v.padStart(Number(w) || 0, (c ?? "0")[0] ?? "0");
        break;
      }
      case "prefix": v = arg + v; break;
      case "suffix": v = v + arg; break;
      case "upper": v = v.toUpperCase(); break;
      case "lower": v = v.toLowerCase(); break;
      case "trim": v = v.trim(); break;
      case "default": if (!v.trim()) v = arg; break;
      case "fmt": {
        const n = num(v);
        if (n != null) v = fmtSeries(n, arg);
        break;
      }
      case "py": {
        const n = num(v);
        try {
          v = pyFormatNum(n == null ? v : n, arg);
        } catch {
          /* keep */
        }
        break;
      }
    }
  }
  return v;
}
const LATE_RE = /\{(Result![a-z]+|series:[^}|]*|unit:[a-z]+)(\|[^}]*)?\}/gi;
/** Resolve one after-placement token ("Result!address", "series:Sig", "unit:desired"); undefined if unknown. */
function lateToken(k: string, late: PlLate): string | undefined {
  const l = k.toLowerCase();
  if (l.startsWith("result!")) {
    const v = late.result[l.slice(7)];
    return v === undefined ? undefined : v == null ? "" : String(v);
  }
  if (l.startsWith("series:")) return late.series(k.slice(7).trim());
  if (l.startsWith("unit:")) {
    const v = late.unit[l.slice(5)];
    return v === undefined ? undefined : v == null ? "" : String(v);
  }
  return undefined;
}
/** Does a rule need values known only after placement? */
export function isLateRule(r: PlRule): boolean {
  if (r.off) return false;
  if (r.op === "expr" || r.op === "code") {
    const n = r.op === "code" ? codeNames(r.a ?? "") : exprNames(r.a ?? "");
    return n.has("result") || n.has("unit") || n.has("series");
  }
  return [r.a, r.b, r.c, r.d, r.e].some((x) => !!x && /\{(Result!|series:|unit:)/i.test(x));
}

/** Fill placeholders: {n} instance, {nn} instance padded to 2, {nnn} to 3, {i} instance from 0, {row}, {col:Header}, {out:field}. */
export function expand(t: string | undefined, x: PlCtx, n0 = 1): string {
  if (!t) return "";
  return t.replace(/\{(n+|i|row|col:[^}|]*|out:[^}|]*|Result![a-z]+|series:[^}|]*|unit:[a-z]+)(\|[^}]*)?\}/gi, (all, k: string, f: string | undefined) => {
    let v: string | undefined;
    if (/^n+$/.test(k)) v = String(x.n).padStart(k.length, "0");
    else if (k === "i") v = String(x.n - n0);
    else if (k === "row") v = String(x.row + 1);
    else if (k.startsWith("col:")) v = x.col(k.slice(4));
    else if (k.startsWith("out:")) {
      v = x.out[k.slice(4)] ?? x.outName?.(k.slice(4));
      // A column computed later in the row: keep the syntax (resolved in the Result).
      if (v === undefined) {
        if (!x.late) return all;
        v = "";
      }
    }
    else {
      // After-placement tokens stay as written until the Result.
      if (!x.late) return all;
      v = lateToken(k, x.late);
      if (v === undefined) return all;
    }
    return applyFilters(v, f ?? "");
  });
}

const WORDS: [RegExp, number][] = [
  [/^(bool|boolean|bit|coil|binary|digital)$/, 1],
  [/^(u?int16|[us]16|i16|word|short|ushort|int|uint|signed|unsigned|enum16)$/, 1],
  [/^(u?int32|[us]32|i32|f32|float|float32|real|dint|udint|dword|long|ulong|ieee754|single)$/, 2],
  [/^(u?int64|[us]64|i64|f64|float64|double|lreal|lint|ulint|lword)$/, 4],
];
/** Registers used by a Modbus data type (null for strings or unknown types). */
export function dataTypeWords(dt: string): number | null {
  const t = normName(dt).replace(/(be|le|sw|ws|abcd|cdab|badc|dcba)$/, "");
  if (!t) return 1;
  for (const [re, w] of WORDS) if (re.test(t)) return w;
  return null;
}
export const isStringType = (dt: string) => /^(string|str|ascii|char|text)/.test(normName(dt));
export const isBoolType = (dt: string) => /^(bool|boolean|bit|coil|binary|digital)$/.test(normName(dt));

const dictOf = (get: (k: string) => string | undefined, keys: () => string[]) => new PyDict((k) => get(k), keys);
const numOrNull = (v: string | number | null): PyValue => (v == null || v === "" ? null : typeof v === "number" ? (Number.isInteger(v) ? v : new PyFloat(v)) : v);
/** Names available to an Expression rule. */
export function exprScope(v: string, x: PlCtx, n0 = 1): Record<string, PyValue> {
  const sc: Record<string, PyValue> = {
    value: v,
    n: x.n,
    i: x.n - n0,
    row: x.row + 1,
    col: dictOf((k) => x.col(k), () => []),
    out: dictOf((k) => x.out[k] ?? x.outName?.(k), () => Object.keys(x.out)),
  };
  if (x.late) {
    const L = x.late;
    sc.result = new PyDict((k) => (k.toLowerCase() in L.result ? numOrNull(L.result[k.toLowerCase()]) : undefined), () => Object.keys(L.result));
    sc.unit = new PyDict((k) => (k.toLowerCase() in L.unit ? numOrNull(L.unit[k.toLowerCase()]) : undefined), () => Object.keys(L.unit));
    sc.series = new PyDict((k) => L.series(k), () => []);
    sc.Result = sc.result;
  }
  if (x.extra) Object.assign(sc, x.extra);
  return sc;
}
function pyFormatNum(n: number | string, spec: string): string {
  return evalExpr(`format(x, s)`, { x: typeof n === "number" ? (Number.isInteger(n) && !/[eEfF%g]/.test(spec) ? n : new PyFloat(n)) : n, s: spec });
}

/** Apply one rule. */
export function applyRule(v: string, r: PlRule, x: PlCtx, n0 = 1): string {
  if (r.off) return v;
  const A = () => expand(r.a, x, n0);
  const arith = (f: (a: number, b: number) => number) => {
    const a = num(v);
    const b = num(A());
    if (a == null) {
      if (v.trim()) x.warn(`"${v}" is not a number (${ruleDef(r.op)?.label})`);
      return v;
    }
    if (b == null) {
      x.warn(`${ruleDef(r.op)?.label}: "${A()}" is not a number`);
      return v;
    }
    if (r.op === "div" && b === 0) {
      x.warn("Divide by zero");
      return v;
    }
    return fmtNum(f(a, b));
  };
  const one = (f: (a: number) => number) => {
    const a = num(v);
    if (a == null) {
      if (v.trim()) x.warn(`"${v}" is not a number (${ruleDef(r.op)?.label})`);
      return v;
    }
    return fmtNum(f(a));
  };
  switch (r.op) {
    case "set": {
      let t = A();
      const w = Number(expand(r.b, x, n0)) || 0;
      if (w > 0) t = t.padStart(w, (r.c || "0")[0]);
      return expand(r.d, x, n0) + t + expand(r.e, x, n0);
    }
    case "expr":
    case "code": {
      const src = (r.a ?? "").trim();
      if (!src) return v;
      if (!x.late && !x.immediate && isLateRule(r)) return `{=${r.op === "code" ? "code" : src}}`;
      try {
        return r.op === "code" ? runCode(src, exprScope(v, x, n0)) : evalExpr(src, exprScope(v, x, n0));
      } catch (e) {
        x.warn(`${r.op === "code" ? "Python code" : "Expression"}: ${e instanceof PyError ? e.message : String(e)}`);
        return v;
      }
    }
    case "prefix": return A() + v;
    case "suffix": return v + A();
    case "ifEmpty": return v.trim() ? v : A();
    case "add": return arith((a, b) => a + b);
    case "sub": return arith((a, b) => a - b);
    case "mul": return arith((a, b) => a * b);
    case "div": return arith((a, b) => a / b);
    case "round": {
      const d = Math.max(0, Math.min(10, Number(r.a) || 0));
      return one((a) => Math.round(a * 10 ** d) / 10 ** d);
    }
    case "floor": return one(Math.floor);
    case "ceil": return one(Math.ceil);
    case "map": {
      const key = v.trim().toLowerCase();
      for (const line of (r.a ?? "").split("\n")) {
        const i = line.indexOf("=");
        if (i < 0) continue;
        if (line.slice(0, i).trim().toLowerCase() === key) return expand(line.slice(i + 1).trim(), x, n0);
      }
      return r.b === "empty" ? "" : r.b === "value" ? expand(r.c, x, n0) : v;
    }
    case "replace": {
      if (!r.a) return v;
      if (r.c === "1") {
        try {
          return v.replace(new RegExp(r.a, "g"), expand(r.b, x, n0));
        } catch {
          x.warn(`Invalid regex /${r.a}/`);
          return v;
        }
      }
      return v.split(r.a).join(expand(r.b, x, n0));
    }
    case "extract": {
      if (!r.a) return v;
      try {
        const m = v.match(new RegExp(r.a));
        return m ? m[Number(r.b) || (m.length > 1 ? 1 : 0)] ?? "" : "";
      } catch {
        x.warn(`Invalid regex /${r.a}/`);
        return v;
      }
    }
    case "substr": {
      const s = Number(r.a) || 0;
      const l = r.b?.trim() ? Number(r.b) : undefined;
      const st = s < 0 ? Math.max(0, v.length + s) : s;
      return l == null || Number.isNaN(l) ? v.slice(st) : v.slice(st, st + l);
    }
    case "pad": return v.padStart(Number(r.a) || 0, (r.b || "0")[0]);
    case "case":
      return r.a === "lower" ? v.toLowerCase() : r.a === "title" ? v.toLowerCase().replace(/(^|[\s_\-/])(\p{L})/gu, (_, p, c) => p + c.toUpperCase()) : v.toUpperCase();
    case "trim": return v.trim().replace(/\s+/g, " ");
    case "rowIndex": return fmtNum((num(expand(r.a, x, n0)) ?? 0) + x.row * (num(expand(r.b, x, n0)) ?? 1));
    case "modicon": {
      const m = resolveModbus(v, "");
      if (!m.inferred) {
        if (v.trim()) x.warn(`"${v}" is not a Modicon address (5/6 digits starting 0, 1, 3 or 4)`);
        return r.a === "table" ? "" : v;
      }
      return r.a === "table" ? m.table ?? "" : String(m.offset);
    }
    case "hex": {
      if (r.a === "toHex") {
        const n = num(v);
        return n == null ? v : "0x" + Math.trunc(n).toString(16).toUpperCase();
      }
      const t = v.trim().replace(/^0x/i, "").replace(/h$/i, "");
      if (!/^[0-9a-f]+$/i.test(t)) {
        if (v.trim()) x.warn(`"${v}" is not hexadecimal`);
        return v;
      }
      return String(parseInt(t, 16));
    }
    case "words": {
      const w = dataTypeWords(v);
      return w == null ? v : String(w);
    }
  }
  return v;
}

export const colKey = (c: PlColumn) => c.field || `x:${(c.name ?? "").trim() || c.id}`;
export const colLabel = (c: PlColumn, protocol: PlProtocol) =>
  (c.name ?? "").trim() || (c.field ? PL_FIELDS[protocol].find((f) => f.key === c.field)?.label ?? c.field : "(custom)");

/** Headers and data rows of an input grid for a table (header row is 1-based). */
export function tableInput(t: Pick<PlTable, "headerRow">, grid: Grid | null | undefined): { headers: string[]; rows: string[][]; first: number } {
  if (!grid?.length) return { headers: [], rows: [], first: 0 };
  const h = Math.max(1, Math.min(grid.length, Math.floor(t.headerRow || 1)));
  return { headers: grid[h - 1].map((s) => s.trim()), rows: grid.slice(h), first: h + 1 };
}

const passes = (f: PlFilter, v: string) => {
  const s = v.trim();
  const w = (f.value ?? "").trim();
  switch (f.op) {
    case "notEmpty": return s !== "";
    case "empty": return s === "";
    case "eq": return s.toLowerCase() === w.toLowerCase();
    case "ne": return s.toLowerCase() !== w.toLowerCase();
    case "contains": return s.toLowerCase().includes(w.toLowerCase());
    case "notContains": return !s.toLowerCase().includes(w.toLowerCase());
    case "startsWith": return s.toLowerCase().startsWith(w.toLowerCase());
    case "regex":
      try {
        return new RegExp(w, "i").test(s);
      } catch {
        return true;
      }
  }
  return true;
};

export interface PlRow {
  /** Output values by column key. */
  v: Record<string, string>;
  /** Excel row number in the input. */
  src: number;
  /** Per column key: rule warnings. */
  warn: Record<string, string[]>;
  /** Rule chains that need values known only after placement (evaluated in the Result). */
  deferred?: PlDeferred[];
  /** Input cells of the row (kept for deferred chains). */
  cells?: Record<string, string>;
  /** Row index within the table instance (0-based). */
  k?: number;
}
export interface PlDeferred {
  key: string;
  /** Value before the first deferred rule. */
  start: string;
  rules: PlRule[];
}
/** Does a rule read an output column that is computed later in the row? */
function refsLater(r: PlRule, names: Map<string, string>, done: Record<string, string>, t: PlTable): boolean {
  if (r.off) return false;
  const refs: string[] = [];
  for (const p of [r.a, r.b, r.c, r.d, r.e]) for (const m of (p ?? "").matchAll(/\{out:([^}|]*)/g)) refs.push(m[1]);
  if (r.op === "expr" || r.op === "code") for (const m of (r.a ?? "").matchAll(/\bout\s*(?:\[\s*(["'])(.*?)\1\s*\]|\.(\w+))/g)) refs.push(m[2] ?? m[3]);
  const keys = new Set(t.columns.map(colKey));
  return refs.some((nm) => {
    const k = keys.has(nm) ? nm : names.get(nm.trim().toLowerCase());
    return !!k && !(k in done);
  });
}

/** Column name → key (custom name, field key or any field label). */
export function outNames(t: PlTable): Map<string, string> {
  const m = new Map<string, string>();
  const add = (n: string | undefined, k: string) => n && !m.has(n.trim().toLowerCase()) && m.set(n.trim().toLowerCase(), k);
  for (const c of t.columns) add(c.name, colKey(c));
  for (const c of t.columns) if (c.field) {
    add(c.field, c.field);
    for (const fs of Object.values(PL_FIELDS)) add(fs.find((f) => f.key === c.field)?.label, c.field);
  }
  add("Scaled-Unit", "scaledUnit");
  add("Unit-Scaling", "unitScale");
  return m;
}

/** Condition a table for one instance: filter rows, then run each column's rule chain. */
/** Reference to a saved function library (null version = latest). */
export interface PyLibRef {
  id: string;
  ver: Ver | null;
}
export function conditionTable(t: PlTable, grid: Grid | null | undefined, n = 1, n0 = 1, dataTypes?: PlDtSet, extra?: Record<string, PyValue>): PlRow[] {
  const { headers, rows, first } = tableInput(t, grid);
  const names = outNames(t);
  const idx = new Map<string, number>();
  headers.forEach((h, j) => !idx.has(h) && idx.set(h, j));
  const out: PlRow[] = [];
  let k = 0;
  rows.forEach((r, i) => {
    if (isBlankRow(r)) return;
    const cell = (h: string) => {
      const j = idx.get(h.trim());
      return j == null ? "" : String(r[j] ?? "").trim();
    };
    if (!t.filters.every((f) => !f.col || passes(f, cell(f.col)))) return;
    const v: Record<string, string> = {};
    const warn: Record<string, string[]> = {};
    const deferred: PlDeferred[] = [];
    for (const c of t.columns) {
      const key = colKey(c);
      const x: PlCtx = { n, row: k, col: cell, out: v, extra, warn: (m) => (warn[key] ??= []).push(m), outName: (nm) => { const kk = names.get(nm.trim().toLowerCase()); return kk ? v[kk] : undefined; } };
      let s = c.source ? cell(c.source) : "";
      if (c.source && !idx.has(c.source.trim())) x.warn(`Input column "${c.source}" not found`);
      // Rules from the first one that needs after-placement values (or a column computed later) run in the Result.
      const lateAt = c.rules.findIndex((r0) => isLateRule(r0) || refsLater(r0, names, v, t));
      c.rules.forEach((r0, j) => {
        if (j === lateAt) deferred.push({ key, start: s, rules: c.rules.slice(j) });
        s = lateAt >= 0 && j >= lateAt && (r0.op === "expr" || r0.op === "code") && !r0.off ? `{=${r0.op === "code" ? "code" : (r0.a ?? "").trim()}}` : applyRule(s, r0, x, n0);
      });
      if (c.type === "num" && s.trim() && num(s) == null) x.warn(`"${s}" is not a number`);
      v[key] = s;
    }
    if (t.dtMap?.on && dataTypes) {
      const raw = (v.dataType ?? "").trim();
      const std = raw ? t.dtMap.map[raw.toLowerCase()] ?? stdOf(dataTypes, raw)?.name : undefined;
      if (std) v.dataType = std;
      else if (raw) (warn.dataType ??= []).push(`Data type "${raw}" is not mapped to the ${dataTypes.name} set — drag a standard type onto it in Data types…, e.g. U16, I32, FLT (BE)`);
    }
    if (t.units?.on) {
      const u = (v.units ?? "").trim();
      const m = u ? matchUnit(t.units.rows, u) : null;
      if (m) {
        v.units = m.proper;
        v.scaledUnit = m.desired;
        v.unitScale = m.factor == null ? "" : fmtNum(m.factor);
        if (m.factor == null) (warn.units ??= []).push(`No SI-prefix factor from ${m.proper} to ${m.desired} (${m.variable})`);
      } else {
        v.unitScale = "";
        v.scaledUnit = "";
        if (u) (warn.units ??= []).push(`Unit "${u}" is not in the unit conditioning — e.g. ${t.units.rows.slice(0, 4).map((r) => splitList(r.proper).slice(0, 2).join("/")).join(", ")}`);
      }
    }
    out.push({ v, src: first + i, warn, k, ...(deferred.length ? { deferred, cells: Object.fromEntries(headers.map((h, j) => [h, String(r[j] ?? "").trim()])) } : {}) });
    k++;
  });
  return out;
}

// --- placement, result and issues --------------------------------------------------------

export interface PlPoint {
  /** Values by column key; the address field holds the final (zero-based) address. */
  v: Record<string, string>;
  /** Address space: HR/IR/CO/DI, AI/BI/AO/BO/CTR, or "IOA". */
  space: string;
  addr: number | null;
  /** Registers / indexes used. */
  size: number;
  placement: string;
  table: string;
  /** Instance number as shown ({n}). */
  inst: number;
  /** Input row (Excel numbering). */
  src: number;
  /** Indexes into result.issues. */
  issues: number[];
  /** Generated to reserve an undeclared register. */
  reserved?: boolean;
  /** Rule chains evaluated after placement, with the input cells they read. */
  deferred?: PlDeferred[];
  cells?: Record<string, string>;
  k?: number;
}
export interface PlBlock {
  placement: string;
  name: string;
  inst: number;
  space: string;
  start: number;
  end: number;
  points: number;
}
export interface PlIssue {
  level: "error" | "warn";
  /** Index into points, or null for build-level issues. */
  point: number | null;
  field: string;
  kind: "overlap" | "range" | "address" | "tag" | "type" | "access" | "rule" | "space" | "config";
  msg: string;
}
export interface PlResult {
  points: PlPoint[];
  blocks: PlBlock[];
  issues: PlIssue[];
  /** Highest used register per space after all placements. */
  last: Record<string, number>;
}

const IEC_TYPES: Record<number, string> = {
  1: "M_SP_NA_1", 3: "M_DP_NA_1", 5: "M_ST_NA_1", 7: "M_BO_NA_1", 9: "M_ME_NA_1", 11: "M_ME_NB_1", 13: "M_ME_NC_1", 15: "M_IT_NA_1",
  20: "M_PS_NA_1", 21: "M_ME_ND_1", 30: "M_SP_TB_1", 31: "M_DP_TB_1", 32: "M_ST_TB_1", 33: "M_BO_TB_1", 34: "M_ME_TD_1", 35: "M_ME_TE_1",
  36: "M_ME_TF_1", 37: "M_IT_TB_1", 38: "M_EP_TD_1", 39: "M_EP_TE_1", 40: "M_EP_TF_1",
  45: "C_SC_NA_1", 46: "C_DC_NA_1", 47: "C_RC_NA_1", 48: "C_SE_NA_1", 49: "C_SE_NB_1", 50: "C_SE_NC_1", 51: "C_BO_NA_1",
  58: "C_SC_TA_1", 59: "C_DC_TA_1", 60: "C_RC_TA_1", 61: "C_SE_TA_1", 62: "C_SE_TB_1", 63: "C_SE_TC_1", 64: "C_BO_TA_1",
};
/** IEC 104 type identification from a number or mnemonic; null if unknown. */
export function iecType(s: string): number | null {
  const t = s.trim().toUpperCase();
  if (/^\d+$/.test(t)) return IEC_TYPES[Number(t)] ? Number(t) : null;
  const e = Object.entries(IEC_TYPES).find(([, m]) => m === t || m.replace(/_/g, "") === t.replace(/_/g, ""));
  return e ? Number(e[0]) : null;
}
export const iecMnemonic = (n: number) => IEC_TYPES[n] ?? "";

/** Space and size of a conditioned row (before placement). */
function locate(protocol: PlProtocol, v: Record<string, string>, set?: PlDtSet): { space: string; addr: number | null; size: number } {
  if (protocol === "modbus") {
    const raw = (v.address ?? "").trim();
    const m = resolveModbus(raw, v.regType ?? "");
    const space = m.table ?? "";
    const dt = v.dataType ?? "";
    const len = num(v.length ?? "");
    const std = stdOf(set, dt);
    const stdRegs = std ? num(std.registers) : null;
    let size = space === "CO" || space === "DI" ? 1 : len != null && len > 0 ? Math.floor(len) : std && stdRegs != null && stdRegs > 0 ? stdRegs : std?.family === "Text" || isStringType(dt) ? 0 : dataTypeWords(dt) ?? 1;
    if (size < 0) size = 0;
    return { space, addr: m.offset, size };
  }
  if (protocol === "dnp3") return { space: normDnp3Type(v.pointType ?? "") ?? "", addr: num(v.index ?? ""), size: 1 };
  return { space: "IOA", addr: num(v.ioa ?? ""), size: 1 };
}

const SPACE_HINT: Record<PlProtocol, string> = {
  modbus: "use HR (holding, 4xxxx), IR (input, 3xxxx), CO (coil, 0xxxx) or DI (discrete input, 1xxxx)",
  dnp3: "use AI (g30), BI (g1), AO (g40), BO (g10/CROB) or CTR (g20)",
  iec104: "",
};
const ADDR_HINT: Record<PlProtocol, string> = {
  modbus: "e.g. 0, 100 or Modicon 40001",
  dnp3: "e.g. 0, 15, 120",
  iec104: "e.g. 1001, 4097",
};

interface Entry {
  v: Record<string, string>;
  l: { space: string; addr: number | null; size: number };
  src: number;
  warn: Record<string, string[]>;
  reserved?: boolean;
  row?: PlRow;
}

/** Reserved points for the undeclared registers of one table instance (table addresses). */
function reservedEntries(P: PlProtocol, t: PlTable, ents: Entry[]): Entry[] {
  const res = t.reserve;
  if (!res || res.mode === "leave") return [];
  const out: Entry[] = [];
  const spaces = new Map<string, Set<number>>();
  for (const e of ents) {
    if (e.l.addr == null || !e.l.space || !Number.isInteger(e.l.addr)) continue;
    const set = spaces.get(e.l.space) ?? new Set<number>();
    for (let a = e.l.addr; a < e.l.addr + Math.max(1, e.l.size); a++) set.add(a);
    spaces.set(e.l.space, set);
  }
  for (const [sp, set] of spaces) {
    const lo = Math.min(...set);
    const hi = Math.max(...set);
    if (hi - lo > 200000) continue;
    const bit = sp === "CO" || sp === "DI" || sp === "BI" || sp === "BO";
    const dt = bit ? "bool" : sp === "CTR" ? "uint32" : res.dataType;
    const w = P === "modbus" && !bit ? dataTypeWords(dt) ?? 1 : 1;
    let a = lo;
    while (a <= hi) {
      if (set.has(a)) {
        a++;
        continue;
      }
      let e = a;
      while (e + 1 <= hi && !set.has(e + 1)) e++;
      let left = res.mode === "fill" ? e - a + 1 : Math.min(Math.max(0, Math.floor(res.n || 0)), e - a + 1);
      let at = a;
      while (left > 0) {
        const size = left >= w ? w : 1;
        const v: Record<string, string> = { tag: "", description: "Reserved", access: "R" };
        if (P === "modbus") Object.assign(v, { regType: sp, address: String(at), dataType: size === w ? dt : "uint16" });
        if (P === "dnp3") Object.assign(v, { pointType: sp, index: String(at), dataType: dt });
        if (P === "iec104") Object.assign(v, { ioa: String(at), typeId: res.dataType, dataType: "" });
        out.push({ v, l: { space: sp, addr: at, size }, src: 0, warn: {}, reserved: true });
        at += size;
        left -= size;
      }
      a = e + 1;
    }
  }
  return out;
}

/** Run the whole build. `grids` maps slot id → input grid. */
export function runBuild(b: PlBuild, grids: Record<string, Grid | null | undefined>, opts: { extra?: Record<string, PyValue> } = {}): PlResult {
  const P = b.protocol;
  const A = PL_ADDR[P].addr;
  const max = PL_MAX_ADDR[P];
  const points: PlPoint[] = [];
  const blocks: PlBlock[] = [];
  const issues: PlIssue[] = [];
  const last: Record<string, number> = {};
  /** Registers already taken by earlier placements, per space (for "Into free registers"). */
  const taken = new Map<string, Set<number>>();
  const issue = (i: PlIssue) => {
    issues.push(i);
    if (i.point != null) points[i.point].issues.push(issues.length - 1);
  };
  const tables = new Map(b.tables.map((t) => [t.id, t]));
  const blockName = (id: string) => {
    const pl = b.placements.find((x) => x.id === id);
    return pl?.name || tables.get(pl?.table ?? "")?.name || "other block";
  };
  const addrLabel = PL_FIELDS[P].find((f) => f.key === A)?.label ?? A;

  for (const pl of b.placements) {
    if (pl.off) continue;
    const t = tables.get(pl.table);
    if (!t) {
      issues.push({ level: "error", point: null, field: "", kind: "config", msg: `${pl.name || "Placement"}: table not found — pick a table in Placements & arrays` });
      continue;
    }
    const grid = grids[t.slot];
    if (!grid?.length) {
      issues.push({ level: "warn", point: null, field: "", kind: "config", msg: `${pl.name || t.name}: input "${b.slots.find((s) => s.id === t.slot)?.name ?? "?"}" has no data — paste a table in Inputs` });
      continue;
    }
    if (!t.columns.some((c) => c.field === A)) issues.push({ level: "error", point: null, field: A, kind: "config", msg: `${t.name}: no column allocated to ${addrLabel} — set Protocol data = ${addrLabel} on one column` });
    const count = Math.max(1, Math.min(10000, Math.floor(pl.count || 1)));
    const entriesFor = (n: number): Entry[] => {
      const rows = conditionTable(t, grid, n, pl.nStart, b.dataTypes, opts.extra);
      const ents: Entry[] = rows.map((r) => ({ v: r.v, l: locate(P, r.v, b.dataTypes), src: r.src, warn: r.warn, row: r.deferred ? r : undefined }));
      return [...ents, ...reservedEntries(P, t, ents)];
    };
    // Block geometry from instance 1 (per space): min address and span.
    const baseEnts = entriesFor(pl.nStart);
    const geo = new Map<string, { min: number; end: number }>();
    for (const { l } of baseEnts) {
      if (l.addr == null || !l.space) continue;
      const g = geo.get(l.space) ?? { min: l.addr, end: l.addr + Math.max(1, l.size) - 1 };
      g.min = Math.min(g.min, l.addr);
      g.end = Math.max(g.end, l.addr + Math.max(1, l.size) - 1);
      geo.set(l.space, g);
    }
    const first = new Map<string, number>();
    for (const [sp, g] of geo) first.set(sp, pl.mode === "zero" ? pl.start || 0 : pl.mode === "last" ? (last[sp] ?? -1) + 1 + (pl.gap || 0) : g.min);
    const stepFor = (sp: string) => {
      const g = geo.get(sp)!;
      return pl.stride > 0 ? pl.stride : g.end - g.min + 1;
    };

    for (let k = 0; k < count; k++) {
      const n = pl.nStart + k;
      const ents = k === 0 ? baseEnts : entriesFor(n);
      // Start address of this instance per space.
      const at = new Map<string, number>();
      for (const [sp, g] of geo) {
        if (pl.mode !== "free") {
          at.set(sp, first.get(sp)! + k * stepFor(sp));
          continue;
        }
        const rel = new Set<number>();
        for (const { l } of ents)
          if (l.space === sp && l.addr != null && Number.isInteger(l.addr)) for (let a = l.addr; a < l.addr + Math.max(1, l.size); a++) rel.add(a - g.min);
        const tk = taken.get(sp) ?? new Set<number>();
        const span = g.end - g.min;
        let a0 = Math.max(0, pl.start || 0);
        while (a0 + span <= max && [...rel].some((r) => tk.has(a0 + r))) a0++;
        at.set(sp, a0);
      }
      const bk = new Map<string, PlBlock>();
      for (const e of ents) {
        const l = e.l;
        const g = l.space ? geo.get(l.space) : undefined;
        let addr = l.addr;
        if (addr != null && g) addr = at.get(l.space)! + (addr - g.min);
        const v = { ...e.v };
        if (addr != null) v[A] = fmtNum(addr);
        if (P === "modbus" && l.space) v.regType = l.space;
        if (P === "dnp3" && l.space) v.pointType = l.space;
        if (e.reserved) v.tag = `RESERVED_${l.space}_${addr}`;
        const pi = points.push({ v, space: l.space, addr, size: l.size, placement: pl.id, table: t.id, inst: n, src: e.src, issues: [], ...(e.reserved ? { reserved: true } : {}), ...(e.row ? { deferred: e.row.deferred, cells: e.row.cells, k: e.row.k } : {}) }) - 1;
        for (const [f, ws] of Object.entries(e.warn)) for (const m of ws) issue({ level: "warn", point: pi, field: f, kind: "rule", msg: m });
        if (addr != null && l.space) {
          const end = addr + Math.max(1, l.size) - 1;
          const blk = bk.get(l.space) ?? { placement: pl.id, name: pl.name || t.name, inst: n, space: l.space, start: addr, end, points: 0 };
          blk.start = Math.min(blk.start, addr);
          blk.end = Math.max(blk.end, end);
          blk.points++;
          bk.set(l.space, blk);
          if (Number.isInteger(addr)) {
            const tk = taken.get(l.space) ?? new Set<number>();
            for (let a = addr; a <= end; a++) tk.add(a);
            taken.set(l.space, tk);
          }
        }
      }
      blocks.push(...bk.values());
      for (const blk of bk.values()) last[blk.space] = Math.max(last[blk.space] ?? -1, blk.end);
    }
  }

  // Values known only after placement: deferred rule chains (Expression rules and rules using {Result!…},
  // {series:…} or {unit:…}), then any of those tokens left in the values. A series gives one number per row.
  const series = new Map((b.series ?? []).map((x) => [x.name.trim().toLowerCase(), { s: x, k: 0 }]));
  const plName = new Map(b.placements.map((x) => [x.id, x.name || tables.get(x.table)?.name || ""]));
  const namesBy = new Map(b.tables.map((t) => [t.id, outNames(t)]));
  points.forEach((p, i) => {
    const used = new Map<string, string>();
    const missing = new Set<string>();
    const t = tables.get(p.table);
    const um = t?.units?.on && p.v.units ? matchUnit(t.units.rows, p.v.units) : null;
    const end = p.addr == null ? null : p.addr + Math.max(1, p.size) - 1;
    const late: PlLate = {
      result: {
        address: p.addr,
        modicon: p.addr == null ? null : P === "modbus" ? modiconRef(p.space, p.addr) : p.addr,
        end,
        space: p.space,
        block: plName.get(p.placement) ?? "",
        n: p.inst,
      },
      unit: { desired: um?.desired ?? p.v.scaledUnit ?? "", proper: um?.proper ?? p.v.units ?? "", factor: um?.factor ?? null, variable: um?.variable ?? "" },
      series: (nm) => {
        const k = nm.trim().toLowerCase();
        const sr = series.get(k);
        if (!sr) {
          missing.add(nm.trim());
          return undefined;
        }
        if (!used.has(k)) used.set(k, fmtSeries(sr.s.start + sr.k++ * sr.s.step, sr.s.format));
        return used.get(k)!;
      },
    };
    if (p.deferred) {
      const names = namesBy.get(p.table);
      const cells = p.cells ?? {};
      const cellOf = (h: string) => cells[h.trim()] ?? Object.entries(cells).find(([k]) => k.toLowerCase() === h.trim().toLowerCase())?.[1] ?? "";
      for (const d of p.deferred) {
        const x: PlCtx = {
          n: p.inst, row: p.k ?? 0, col: cellOf, out: p.v, late, extra: opts.extra,
          warn: (m) => issue({ level: "warn", point: i, field: d.key, kind: "rule", msg: m }),
          outName: (nm) => { const kk = names?.get(nm.trim().toLowerCase()); return kk ? p.v[kk] : undefined; },
        };
        let s0 = d.start;
        for (const r0 of d.rules) s0 = applyRule(s0, r0, x, b.placements.find((q) => q.id === p.placement)?.nStart ?? 1);
        p.v[d.key] = s0;
      }
    }
    for (const [key, val] of Object.entries(p.v)) {
      if (!val || !val.includes("{")) continue;
      p.v[key] = val.replace(LATE_RE, (all, k: string, f: string | undefined) => {
        const r = lateToken(k, late);
        return r === undefined ? all : applyFilters(r, f ?? "");
      });
    }
    for (const m of missing) issue({ level: "warn", point: i, field: "tag", kind: "rule", msg: `Series "${m}" is not defined — add it with Series… (e.g. name ${m}, start 1, increment 1, format 0000)` });
  });

  // Per-point checks.
  const fields = PL_FIELDS[P];
  const tags = new Map<string, number>();
  const occ = new Map<string, number>();
  points.forEach((p, i) => {
    const v = p.v;
    const lab = (k: string) => fields.find((f) => f.key === k)?.label ?? k;
    const tag = (v.tag ?? "").trim();
    if (!tag) issue({ level: "error", point: i, field: "tag", kind: "tag", msg: "Tag is empty — e.g. BMS01_SOC (allocate a column to Tag, or add a Set value rule such as R{nn}_{col:Name})" });
    else if (tags.has(tag.toLowerCase())) issue({ level: "warn", point: i, field: "tag", kind: "tag", msg: `Duplicate tag (also point ${tags.get(tag.toLowerCase())! + 1}) — make it unique, e.g. add a Prefix rule R{nn}_ for array instances` });
    else tags.set(tag.toLowerCase(), i);

    if (!p.space) {
      const raw = P === "modbus" ? v.regType : v.pointType;
      const f = lab(PL_ADDR[P].space);
      issue({ level: "error", point: i, field: PL_ADDR[P].space, kind: "space", msg: `${raw?.trim() ? `Unknown ${f.toLowerCase()} "${raw}"` : `${f} missing`} — ${SPACE_HINT[P]}` });
    }
    if (p.addr == null) issue({ level: "error", point: i, field: A, kind: "address", msg: `${(v[A] ?? "").trim() ? `${lab(A)} "${v[A]}" is not a number` : `${lab(A)} missing`} — ${ADDR_HINT[P]}` });
    else if (!Number.isInteger(p.addr)) issue({ level: "error", point: i, field: A, kind: "address", msg: `${lab(A)} ${p.addr} is not a whole number — ${ADDR_HINT[P]} (add a Round or Floor rule)` });
    else if (p.addr < (P === "iec104" ? 1 : 0) || p.addr + Math.max(1, p.size) - 1 > max)
      issue({ level: "error", point: i, field: A, kind: "range", msg: `${lab(A)} ${p.addr}${p.size > 1 ? `–${p.addr + p.size - 1}` : ""} outside the valid range ${P === "iec104" ? 1 : 0}–${max}` });

    for (const f of fields)
      if (f.type === "num" && (v[f.key] ?? "").trim() && num(v[f.key]) == null && f.key !== A)
        issue({ level: "warn", point: i, field: f.key, kind: "type", msg: `${f.label} "${v[f.key]}" is not a number — e.g. ${f.key === "scale" ? "0.1, 1, 1000" : f.key === "eventClass" ? "0, 1, 2, 3" : "1, 2, 10"}` });

    const dt = (v.dataType ?? "").trim();
    const acc = (v.access ?? "").trim().toUpperCase().replace(/[^RW]/g, "");
    if (acc && !["R", "W", "RW", "WR"].includes(acc)) issue({ level: "warn", point: i, field: "access", kind: "access", msg: `Access "${v.access}" — use R (read), W (write) or RW (read/write)` });
    const std = stdOf(b.dataTypes, dt);
    if (P === "modbus" && std) {
      const regs = num(std.registers);
      if ((p.space === "CO" || p.space === "DI") && regs != null && regs > 0) issue({ level: "error", point: i, field: "dataType", kind: "type", msg: `${dt} (${regs} register${regs > 1 ? "s" : ""}) in ${p.space === "CO" ? "coils" : "discrete inputs"} — this space holds 1 bit: use a bit type, or move the value to ${p.space === "CO" ? "HR" : "IR"}` });
      if ((p.space === "HR" || p.space === "IR") && (regs == null || regs <= 0) && !(num(v.length ?? "")! > 0))
        issue({ level: std.family === "Text" ? "error" : "warn", point: i, field: "length", kind: "type", msg: `${dt} has no fixed content size — set Length (registers), e.g. ${std.family === "Text" ? "10 for 20 characters" : "1"}, or a content size in Data types…` });
      if ((p.space === "HR" || p.space === "IR") && regs && num(v.length ?? "") != null && num(v.length)! > 0 && num(v.length) !== regs)
        issue({ level: "warn", point: i, field: "length", kind: "type", msg: `Length ${v.length} differs from ${dt} (${regs} register${regs > 1 ? "s" : ""}) — leave Length empty or set ${regs}` });
      if ((p.space === "IR" || p.space === "DI") && acc.includes("W")) issue({ level: "error", point: i, field: "access", kind: "access", msg: `${p.space === "IR" ? "Input registers" : "Discrete inputs"} are read-only — set Access to R, or use ${p.space === "IR" ? "HR" : "CO"} for writable values` });
    } else if (P === "modbus") {
      if (dt && !isStringType(dt) && dataTypeWords(dt) == null) issue({ level: "warn", point: i, field: "dataType", kind: "type", msg: `Unknown data type "${dt}" — e.g. bool, uint16, int16, uint32, int32, float32, uint64, float64, string` });
      if ((p.space === "CO" || p.space === "DI") && dt && !isBoolType(dt)) issue({ level: "error", point: i, field: "dataType", kind: "type", msg: `${dt} in ${p.space === "CO" ? "coils" : "discrete inputs"} — this space holds 1 bit: use bool, or move the value to ${p.space === "CO" ? "HR" : "IR"}` });
      if ((p.space === "HR" || p.space === "IR") && isStringType(dt) && !(num(v.length ?? "")! > 0)) issue({ level: "error", point: i, field: "length", kind: "type", msg: "String without a length — set Length (registers), e.g. 10 for 20 characters" });
      if ((p.space === "IR" || p.space === "DI") && acc.includes("W")) issue({ level: "error", point: i, field: "access", kind: "access", msg: `${p.space === "IR" ? "Input registers" : "Discrete inputs"} are read-only — set Access to R, or use ${p.space === "IR" ? "HR" : "CO"} for writable values` });
      const w = dataTypeWords(dt);
      if ((p.space === "HR" || p.space === "IR") && w && num(v.length ?? "") != null && num(v.length)! > 0 && num(v.length) !== w)
        issue({ level: "warn", point: i, field: "length", kind: "type", msg: `Length ${v.length} differs from ${dt} (${w} register${w > 1 ? "s" : ""}) — leave Length empty or set ${w}` });
    }
    if (P === "dnp3") {
      const ec = (v.eventClass ?? "").trim();
      if (ec && !/^[0-3]$/.test(ec)) issue({ level: "warn", point: i, field: "eventClass", kind: "type", msg: `Event class "${ec}" — use 0 (no events), 1, 2 or 3` });
      if ((p.space === "AI" || p.space === "BI" || p.space === "CTR") && acc.includes("W")) issue({ level: "error", point: i, field: "access", kind: "access", msg: `${p.space} points are read-only — set Access to R, or use AO/BO for commands` });
    }
    if (P === "iec104") {
      const ti = iecType(v.typeId ?? "");
      const hint = "e.g. 13 / M_ME_NC_1 (float), 11 / M_ME_NB_1 (scaled), 1 / M_SP_NA_1 (single point), 45 / C_SC_NA_1 (single command)";
      if (!(v.typeId ?? "").trim()) issue({ level: "error", point: i, field: "typeId", kind: "type", msg: `Type ID missing — ${hint}` });
      else if (ti == null) issue({ level: "error", point: i, field: "typeId", kind: "type", msg: `Unknown type ID "${v.typeId}" — ${hint}` });
      else if (ti < 45 && acc.includes("W")) issue({ level: "warn", point: i, field: "access", kind: "access", msg: `Monitor type ${iecMnemonic(ti)} marked writable — commands use 45–64, e.g. 45 C_SC_NA_1, 50 C_SE_NC_1` });
    }

    // Register occupancy: two points writing the same register / index.
    if (p.addr != null && Number.isInteger(p.addr) && p.space) {
      const sp = P === "iec104" ? "IOA" : p.space;
      for (let a = p.addr; a < p.addr + Math.max(1, p.size); a++) {
        const k = `${sp}:${a}`;
        const o = occ.get(k);
        if (o != null && o !== i) {
          const q = points[o];
          issue({
            level: "error", point: i, field: A, kind: "overlap",
            msg: `${sp} ${a} already used by ${q.v.tag || `point ${o + 1}`}${q.placement !== p.placement || q.inst !== p.inst ? ` (${blockName(q.placement)} #${q.inst})` : ""} — move a block (Stride / Start / Into free registers) or remove the duplicate`,
          });
          break;
        }
        occ.set(k, i);
      }
    }
  });
  return { points, blocks, issues, last };
}

/** Address usage of one space in a validated table. */
export interface PlSpaceStats {
  space: string;
  start: number;
  end: number;
  /** end − start + 1 */
  span: number;
  /** Registers / indexes used by declared points. */
  used: number;
  /** Registers / indexes taken by reserved points. */
  reserved: number;
  /** Registers / indexes neither declared nor reserved. */
  free: number;
  points: number;
  /** used / span */
  utilization: number;
}
export interface PlTableStats {
  spaces: PlSpaceStats[];
  /** Largest span: the stride that packs array instances without overlap. */
  stride: number;
  points: number;
  errors: number;
  warnings: number;
  issues: PlIssue[];
}

/** Validate one table on its own (placed once at its own addresses) for the build's protocol. */
export function validateTable(b: PlBuild, tableId: string, grid: Grid | null | undefined, extra?: Record<string, PyValue>): PlTableStats {
  const t = b.tables.find((x) => x.id === tableId);
  const empty: PlTableStats = { spaces: [], stride: 0, points: 0, errors: 0, warnings: 0, issues: [] };
  if (!t) return empty;
  const r = runBuild({ ...b, placements: [{ id: "validate", name: t.name, table: t.id, count: 1, mode: "start", start: 0, stride: 0, gap: 0, nStart: 1 }] }, { [t.slot]: grid }, { extra });
  const by = new Map<string, { used: Set<number>; res: Set<number>; points: number }>();
  for (const p of r.points) {
    if (p.addr == null || !p.space || !Number.isInteger(p.addr)) continue;
    const s = by.get(p.space) ?? { used: new Set<number>(), res: new Set<number>(), points: 0 };
    for (let a = p.addr; a < p.addr + Math.max(1, p.size); a++) (p.reserved ? s.res : s.used).add(a);
    if (!p.reserved) s.points++;
    by.set(p.space, s);
  }
  const spaces: PlSpaceStats[] = [...by.entries()].sort(([a], [c]) => a.localeCompare(c)).map(([space, s]) => {
    const all = [...s.used, ...s.res];
    const start = Math.min(...all);
    const end = Math.max(...all);
    const span = end - start + 1;
    return { space, start, end, span, used: s.used.size, reserved: s.res.size, free: span - s.used.size - s.res.size, points: s.points, utilization: s.used.size / span };
  });
  const errors = r.issues.filter((i) => i.level === "error").length;
  return { spaces, stride: Math.max(0, ...spaces.map((s) => s.span)), points: r.points.filter((p) => !p.reserved).length, errors, warnings: r.issues.length - errors, issues: r.issues };
}

/** Columns of the result / published table: protocol fields used by any table, then custom columns. */
export function resultColumns(b: PlBuild): { key: string; label: string }[] {
  const used = new Set(b.tables.flatMap((t) => t.columns.map(colKey)));
  const named = (k: string, def: string) => b.tables.flatMap((t) => t.columns).find((c) => c.field === k && c.name?.trim())?.name?.trim() || def;
  const out = PL_FIELDS[b.protocol].filter((f) => used.has(f.key) || f.required).map((f) => ({ key: f.key, label: named(f.key, f.label) }));
  if (b.tables.some((t) => t.units?.on)) {
    const at = out.findIndex((c) => c.key === "dataType");
    out.splice(at >= 0 ? at + 1 : out.length, 0, { key: "scaledUnit", label: "Scaled-Unit" }, { key: "unitScale", label: "Unit-Scaling" });
  }
  const seen = new Set(out.map((c) => c.key));
  for (const t of b.tables)
    for (const c of t.columns)
      if (!c.field && !seen.has(colKey(c))) {
        seen.add(colKey(c));
        out.push({ key: colKey(c), label: colLabel(c, b.protocol) });
      }
  return out;
}

/** Map from builder fields to the source protocol declaration (PointField → header). */
const PUB_MAP: Record<PlProtocol, Record<string, string>> = {
  modbus: { tag: "tag", description: "description", regType: "regType", address: "address", dataType: "dataType", scale: "scale", units: "units", access: "access" },
  dnp3: { tag: "tag", description: "description", pointType: "pointType", index: "index", eventClass: "eventClass", dataType: "dataType", scale: "scale", units: "units", access: "access" },
  iec104: { tag: "tag", description: "description", typeId: "typeId", ioa: "ioa", dataType: "dataType", scale: "scale", units: "units", access: "access" },
};

/** Grid + protocol map for publishing the result as a point-list source. */
export function publishGrid(b: PlBuild, r: PlResult, opts: { origin?: boolean } = {}): { grid: Grid; protocolMap: Record<string, string> } {
  const cols = resultColumns(b);
  const names = new Map(b.placements.map((p) => [p.id, p.name || b.tables.find((t) => t.id === p.table)?.name || ""]));
  const head = [...cols.map((c) => c.label), ...(opts.origin ? ["Block"] : [])];
  const rows = r.points.map((p) => [
    ...cols.map((c) => (c.key === "typeId" && b.protocol === "iec104" ? String(iecType(p.v.typeId ?? "") ?? p.v.typeId ?? "") : p.v[c.key] ?? "")),
    ...(opts.origin ? [`${names.get(p.placement) ?? ""} #${p.inst}`] : []),
  ]);
  const protocolMap: Record<string, string> = {};
  for (const c of cols) if (PUB_MAP[b.protocol][c.key]) protocolMap[PUB_MAP[b.protocol][c.key]] = c.label;
  return { grid: [head, ...rows], protocolMap };
}

/** Columns for every required/known field the input headers suggest (used by "Auto-map"). */
export function suggestColumns(protocol: PlProtocol, headers: string[], newId: () => string): PlColumn[] {
  const SYN: Record<string, string[]> = {
    tag: ["tag", "name", "point", "pointname", "signal", "tagname", "label", "variable"],
    description: ["description", "desc", "comment", "text"],
    regType: ["regtype", "registertype", "function", "fc", "table", "objecttype"],
    address: ["register", "address", "addr", "reg", "offset", "registeraddress", "modbusaddress", "startaddress"],
    dataType: ["datatype", "format", "dtype", "type"],
    length: ["length", "len", "size", "words", "registers", "count", "quantity"],
    scale: ["scale", "multiplier", "factor", "gain", "scaling", "resolution"],
    units: ["unit", "units", "eu", "engunits", "uom"],
    access: ["access", "rw", "readwrite", "writable", "mode", "permission"],
    pointType: ["pointtype", "dnp3type", "objtype", "group", "type"],
    index: ["index", "idx", "pointindex", "dnp3index", "point"],
    variation: ["variation", "var", "defaultvariation", "staticvariation"],
    eventClass: ["class", "eventclass"],
    typeId: ["typeid", "asdutype", "ti", "asdu", "iectype", "type"],
    ioa: ["ioa", "objectaddress", "informationobjectaddress", "infoaddr", "address"],
  };
  const used = new Set<number>();
  const find = (k: string) => headers.findIndex((h) => (SYN[k] ?? []).includes(normName(h)));
  // Without a register-type column, Modicon addresses (40001…) give both the table and the offset.
  const modicon = protocol === "modbus" && find("regType") < 0 && find("address") >= 0;
  return PL_FIELDS[protocol].map((f) => {
    const j = headers.findIndex((h, k) => !used.has(k) && (SYN[f.key] ?? []).includes(normName(h)));
    if (j >= 0) used.add(j);
    const rules: PlRule[] = [];
    if (f.key === "regType" && protocol === "modbus" && j < 0) {
      const a = headers.findIndex((h) => (SYN.address ?? []).includes(normName(h)));
      if (a >= 0) return { id: newId(), field: f.key, type: f.type, source: headers[a], rules: [{ op: "modicon", a: "table" }] };
    }
    if (f.key === "address" && modicon) rules.push({ op: "modicon", a: "offset" });
    if (f.key === "regType" && protocol === "modbus") rules.push({ op: "map", a: "holding = HR\nholding register = HR\ninput = IR\ninput register = IR\ncoil = CO\ndiscrete = DI\ndiscrete input = DI", b: "keep" });
    return { id: newId(), field: f.key, type: f.type, source: j >= 0 ? headers[j] : "", rules };
  });
}

export const blockSummary = (bl: PlBlock[]) => bl.map((b) => `${b.space} ${b.start}–${b.end}`).join(", ");

