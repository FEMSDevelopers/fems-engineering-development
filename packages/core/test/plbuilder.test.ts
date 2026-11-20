import { describe, expect, it } from "vitest";
import { applyFilters, isLateRule, autoMatchTypes, defaultDtSet, fmtSeries, inferStdType, modiconRef, parseDtTypes, applyRule, conditionTable, dataTypeWords, defaultUnits, expand, iecType, matchUnit, PL_RULES, publishGrid, ruleExample, runBuild, suggestColumns, validateTable, type PlBuild, type PlCtx, type PlTable } from "../src/index.js";

const ctx = (o: Partial<PlCtx> = {}): PlCtx => ({ n: 3, row: 4, col: (h) => ({ Name: "Volt", Off: "10" })[h] ?? "", out: { tag: "T1" }, warn: () => {}, ...o });

describe("plbuilder rules", () => {
  it("expands placeholders", () => {
    expect(expand("R{n}_{nn}_{nnn}_{i}_{row}_{col:Name}_{out:tag}", ctx())).toBe("R3_03_003_2_5_Volt_T1");
  });
  it("applies text and number rules", () => {
    const x = ctx();
    expect(applyRule("a", { op: "prefix", a: "BMS{nn}_" }, x)).toBe("BMS03_a");
    expect(applyRule("0.1", { op: "add", a: "0.2" }, x)).toBe("0.3");
    expect(applyRule("5", { op: "add", a: "{col:Off}" }, x)).toBe("15");
    expect(applyRule("7", { op: "div", a: "2" }, x)).toBe("3.5");
    expect(applyRule("3.14159", { op: "round", a: "2" }, x)).toBe("3.14");
    expect(applyRule("holding", { op: "map", a: "Holding = HR\nInput = IR", b: "keep" }, x)).toBe("HR");
    expect(applyRule("zzz", { op: "map", a: "Holding = HR", b: "value", c: "??" }, x)).toBe("??");
    expect(applyRule("V_L1-N", { op: "replace", a: "[-_]", b: ".", c: "1" }, x)).toBe("V.L1.N");
    expect(applyRule("Reg 123 x", { op: "extract", a: "(\\d+)" }, x)).toBe("123");
    expect(applyRule("7", { op: "pad", a: "3" }, x)).toBe("007");
    expect(applyRule("", { op: "rowIndex", a: "100", b: "2" }, x)).toBe("108");
    expect(applyRule("40010", { op: "modicon", a: "offset" }, x)).toBe("9");
    expect(applyRule("300001", { op: "modicon", a: "table" }, x)).toBe("IR");
    expect(applyRule("0x1A", { op: "hex", a: "toDec" }, x)).toBe("26");
    expect(applyRule("float32", { op: "words" }, x)).toBe("2");
    expect(applyRule("x", { op: "set", a: "y", off: true }, x)).toBe("x");
  });
  it("warns on non-numeric input to arithmetic", () => {
    const w: string[] = [];
    expect(applyRule("abc", { op: "mul", a: "2" }, ctx({ warn: (m) => w.push(m) }))).toBe("abc");
    expect(w.length).toBe(1);
  });
  it("knows data type sizes and IEC type ids", () => {
    expect(dataTypeWords("UINT16")).toBe(1);
    expect(dataTypeWords("float32_abcd")).toBe(2);
    expect(dataTypeWords("float64")).toBe(4);
    expect(dataTypeWords("string")).toBeNull();
    expect(iecType("M_ME_NC_1")).toBe(13);
    expect(iecType("13")).toBe(13);
    expect(iecType("99")).toBeNull();
  });
});

const grid = [
  ["junk title"],
  ["Name", "Addr", "Type", "Kind"],
  ["V", "40001", "float32", "meas"],
  ["I", "40003", "float32", "meas"],
  ["", "", "", ""],
  ["Spare", "40005", "uint16", "spare"],
  ["SoC", "40006", "uint16", "meas"],
];
const table: PlTable = {
  id: "t1", name: "Rack", slot: "s1", headerRow: 2,
  filters: [{ col: "Kind", op: "ne", value: "spare" }],
  columns: [
    { id: "c1", field: "tag", type: "str", source: "Name", rules: [{ op: "prefix", a: "R{nn}_" }] },
    { id: "c2", field: "address", type: "num", source: "Addr", rules: [{ op: "modicon", a: "offset" }] },
    { id: "c3", field: "regType", type: "str", source: "", rules: [{ op: "set", a: "HR" }] },
    { id: "c4", field: "dataType", type: "str", source: "Type", rules: [] },
    { id: "c5", field: "", name: "Words", type: "num", source: "Type", rules: [{ op: "words" }] },
  ],
};
const build = (pl: Partial<PlBuild["placements"][0]>[], extra: PlTable[] = []): PlBuild => ({
  protocol: "modbus",
  slots: [{ id: "s1", name: "Raw", inputId: null, ver: null }],
  tables: [table, ...extra],
  placements: pl.map((p, i) => ({ id: `p${i}`, name: `P${i}`, table: "t1", count: 1, mode: "start", start: 0, stride: 0, gap: 0, nStart: 1, ...p })),
});

describe("plbuilder tables and arrays", () => {
  it("conditions a table with header row, filters and custom columns", () => {
    const rows = conditionTable(table, grid, 2);
    expect(rows.map((r) => r.v.tag)).toEqual(["R02_V", "R02_I", "R02_SoC"]);
    expect(rows.map((r) => r.v.address)).toEqual(["0", "2", "5"]);
    expect(rows[0].v["x:Words"]).toBe("2");
    expect(rows[2].src).toBe(7);
  });
  it("places a table once at its own addresses", () => {
    const r = runBuild(build([{}]), { s1: grid });
    expect(r.points.map((p) => p.addr)).toEqual([0, 2, 5]);
    expect(r.blocks).toEqual([expect.objectContaining({ space: "HR", start: 0, end: 5, points: 3 })]);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("repeats arrays from the array start block with block-size stride", () => {
    const r = runBuild(build([{ count: 3 }]), { s1: grid });
    expect(r.blocks.map((b) => [b.start, b.end])).toEqual([[0, 5], [6, 11], [12, 17]]);
    expect(r.points.map((p) => p.v.tag).slice(3, 4)).toEqual(["R02_V"]);
    expect(r.issues.filter((i) => i.kind === "overlap")).toEqual([]);
  });
  it("re-bases from register 0 / start with a stride", () => {
    const r = runBuild(build([{ count: 2, mode: "zero", start: 1000, stride: 100 }]), { s1: grid });
    expect(r.blocks.map((b) => [b.start, b.end])).toEqual([[1000, 1005], [1100, 1105]]);
  });
  it("continues from the last known register with a gap", () => {
    const r = runBuild(build([{}, { count: 2, mode: "last", gap: 4 }]), { s1: grid });
    expect(r.blocks.map((b) => [b.start, b.end])).toEqual([[0, 5], [10, 15], [16, 21]]);
    expect(r.last.HR).toBe(21);
  });
  it("counts overlapping registers and protocol violations", () => {
    const r = runBuild(build([{}, { count: 1 }]), { s1: grid });
    expect(r.issues.filter((i) => i.kind === "overlap").length).toBe(3);
    expect(r.issues.filter((i) => i.kind === "tag").length).toBe(3);
    const small = runBuild(build([{ count: 2, stride: 3 }]), { s1: grid });
    expect(small.issues.some((i) => i.kind === "overlap")).toBe(true);
    const coil: PlTable = { ...table, id: "t2", columns: table.columns.map((c) => (c.field === "regType" ? { ...c, rules: [{ op: "set", a: "CO" }] } : c)) };
    const rc = runBuild({ ...build([]), tables: [coil], placements: [{ id: "p", name: "C", table: "t2", count: 1, mode: "start", start: 0, stride: 0, gap: 0, nStart: 1 }] }, { s1: grid });
    expect(rc.issues.filter((i) => i.kind === "type" && i.level === "error").length).toBe(3);
    const far = runBuild(build([{ mode: "zero", start: 65534 }]), { s1: grid });
    expect(far.issues.some((i) => i.kind === "range")).toBe(true);
  });
  it("publishes a point-list grid with a protocol map", () => {
    const b = build([{ count: 2 }]);
    const r = runBuild(b, { s1: grid });
    const p = publishGrid(b, r, { origin: true });
    expect(p.grid[0]).toEqual(["Tag", "Register type", "Address / index", "Data type", "Words", "Block"]);
    expect(p.grid[4]).toEqual(["R02_V", "HR", "6", "float32", "2", "P0 #2"]);
    expect(p.protocolMap).toMatchObject({ tag: "Tag", regType: "Register type", address: "Address / index" });
  });
  it("suggests columns from headers", () => {
    let k = 0;
    const cols = suggestColumns("modbus", ["Name", "Register", "Data Type", "Units"], () => `c${k++}`);
    const by = Object.fromEntries(cols.map((c) => [c.field, c]));
    expect(by.tag.source).toBe("Name");
    expect(by.address.source).toBe("Register");
    expect(by.regType.rules[0]).toMatchObject({ op: "modicon", a: "table" });
    expect(by.dataType.source).toBe("Data Type");
    expect(by.address.rules[0]).toMatchObject({ op: "modicon", a: "offset" });
    expect(suggestColumns("modbus", ["Tag", "Register", "Register Type"], () => "x").find((c) => c.field === "address")!.rules).toEqual([]);
  });
});

describe("plbuilder round 2", () => {
  it("rule examples produce their documented outputs", () => {
    for (const d of PL_RULES) {
      expect(d.examples?.length, d.op).toBe(3);
      for (const ex of d.examples!) expect(ruleExample(d.op, ex), `${d.op}: ${ex.note}`).toEqual({ out: ex.out, warn: [] });
    }
  });
  it("fills undeclared registers with reserved points", () => {
    const t: PlTable = { ...table, reserve: { mode: "fill", n: 1, dataType: "uint16" } };
    const b = { ...build([{}]), tables: [t] };
    const r = runBuild(b, { s1: grid });
    // declared HR 0-3 (2 float32), 5 (uint16 SoC); spare row 4 filtered -> gap at 4 reserved
    expect(r.points.filter((p) => p.reserved).map((p) => [p.addr, p.v.tag])).toEqual([[4, "RESERVED_HR_4"]]);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
    const g2 = [["Name", "Addr", "Type", "Kind"], ["A", "40001", "uint16", ""], ["B", "40010", "uint16", ""]];
    const t2: PlTable = { ...table, headerRow: 1, filters: [], reserve: { mode: "fill", n: 1, dataType: "float32" } };
    const r2 = runBuild({ ...build([{}]), tables: [t2] }, { s1: g2 });
    expect(r2.points.filter((p) => p.reserved).map((p) => `${p.addr}:${p.size}`)).toEqual(["1:2", "3:2", "5:2", "7:2"]);
    const t3: PlTable = { ...t2, reserve: { mode: "gapN", n: 3, dataType: "uint16" } };
    const r3 = runBuild({ ...build([{}]), tables: [t3] }, { s1: g2 });
    expect(r3.points.filter((p) => p.reserved).map((p) => p.addr)).toEqual([1, 2, 3]);
  });
  it("places instances into free registers left by another table", () => {
    const g2 = [["Name", "Addr", "Type", "Kind"], ["A", "40001", "uint16", ""], ["B", "40003", "uint16", ""], ["C", "40005", "uint16", ""]];
    const sparse: PlTable = { ...table, id: "t1", headerRow: 1, filters: [], reserve: { mode: "leave", n: 0, dataType: "uint16" } };
    const one = [["Name", "Addr", "Type", "Kind"], ["X", "40001", "uint16", ""]];
    const single: PlTable = { ...table, id: "t2", slot: "s2", headerRow: 1, filters: [], columns: table.columns.map((c) => (c.field === "tag" ? { ...c, rules: [{ op: "prefix", a: "S{n}_" }] } : c)) };
    const b: PlBuild = {
      protocol: "modbus", slots: [{ id: "s1", name: "a", inputId: null, ver: null }, { id: "s2", name: "b", inputId: null, ver: null }], tables: [sparse, single],
      placements: [
        { id: "p1", name: "Sparse", table: "t1", count: 1, mode: "start", start: 0, stride: 0, gap: 0, nStart: 1 },
        { id: "p2", name: "Fill", table: "t2", count: 3, mode: "free", start: 0, stride: 0, gap: 0, nStart: 1 },
      ],
    };
    const r = runBuild(b, { s1: g2, s2: one });
    expect(r.points.filter((p) => p.placement === "p2").map((p) => p.addr)).toEqual([1, 3, 5]);
    expect(r.issues.filter((i) => i.kind === "overlap")).toEqual([]);
  });
  it("validates a table: span, use, free, stride", () => {
    const st = validateTable(build([]), "t1", grid);
    expect(st.spaces).toEqual([{ space: "HR", start: 0, end: 5, span: 6, used: 5, reserved: 0, free: 1, points: 3, utilization: 5 / 6 }]);
    expect(st.stride).toBe(6);
  });
  it("conditions units and computes the unit scaling", () => {
    const rows = defaultUnits().rows;
    expect(matchUnit(rows, "kw")).toMatchObject({ proper: "kW", factor: 1 });
    expect(matchUnit(rows, "MW")).toMatchObject({ proper: "MW", desired: "kW", factor: 1000 });
    expect(matchUnit(rows, "v")).toMatchObject({ proper: "V", factor: 0.001 });
    expect(matchUnit(rows, "MVAR")).toMatchObject({ proper: "MVAR", factor: 1000 });
    expect(matchUnit(rows, "kWh")).toMatchObject({ factor: 1 });
    expect(matchUnit(rows, "degC")).toBeNull();
    const t: PlTable = { ...table, units: { on: true, name: "x", rows }, columns: [...table.columns, { id: "u", field: "units", type: "str", source: "Unit", rules: [] }] };
    const g = [["Name", "Addr", "Type", "Unit"], ["P", "40001", "float32", "mw"], ["T", "40003", "float32", "degC"]];
    const out = conditionTable({ ...t, headerRow: 1, filters: [] }, g);
    expect(out.map((r) => [r.v.units, r.v.scaledUnit, r.v.unitScale])).toEqual([["MW", "kW", "1000"], ["degC", "", ""]]);
    expect(out[1].warn.units?.[0]).toMatch(/not in the unit conditioning/);
  });
  it("gives example valid values in issues", () => {
    const bad: PlTable = { ...table, columns: table.columns.map((c) => (c.field === "regType" ? { ...c, rules: [{ op: "set", a: "XX" }] } : c)) };
    const r = runBuild({ ...build([{}]), tables: [bad] }, { s1: grid });
    expect(r.issues.find((i) => i.kind === "space")?.msg).toMatch(/Unknown register type "XX" — use HR/);
  });
});

describe("plbuilder round 3", () => {
  it("standard data types: defaults, inference, bulk import, auto-match", () => {
    const set = defaultDtSet();
    expect(set.types.length).toBe(38);
    const by = Object.fromEntries(set.types.map((t) => [t.name, t]));
    expect(by["U32 (LE)"]).toMatchObject({ family: "Unsigned", bits: "32", registers: "2" });
    expect(by["FLT (BE)"]).toMatchObject({ family: "Float", bits: "32", registers: "2" });
    expect(by["HB-U16"]).toMatchObject({ family: "Heartbeat", bits: "16", registers: "1" });
    expect(by["BITFIELD_64 (LE)"]).toMatchObject({ family: "Bitfield", bits: "64", registers: "4" });
    expect(by["UTF8 (BE)"]).toMatchObject({ family: "Text", bits: "other", registers: "" });
    expect(by["Counter-U32 (BE)"]).toMatchObject({ family: "Counter", registers: "2" });
    expect(by["UNKNOWN"]).toMatchObject({ family: "Other", registers: "" });
    expect(inferStdType("I64")).toMatchObject({ family: "Signed", bits: "64", registers: "4" });
    expect(parseDtTypes("Name\tAlias\tSize\nU16\tuint\t1\nPower_10\t\t1\tOther\t16")).toEqual([
      { name: "U16", alias: "uint", family: "Unsigned", bits: "16", registers: "1" },
      { name: "Power_10", alias: "", family: "Other", bits: "16", registers: "1" },
    ]);
    expect(autoMatchTypes(["UINT16", "float32", "u32 (le)", "weird"], set)).toEqual({ uint16: "U16", float32: "FLT (BE)", "u32 (le)": "U32 (LE)" });
  });
  it("maps raw data types and sizes registers from the standard set", () => {
    const set = defaultDtSet();
    const g = [["Name", "Addr", "Type", "Kind"], ["A", "40001", "u64 (le)", ""], ["B", "40005", "weird", ""]];
    const t: PlTable = { ...table, headerRow: 1, filters: [], dtMap: { on: true, map: { weird: "I16" } } };
    const b: PlBuild = { ...build([{}]), tables: [t], dataTypes: set };
    const r = runBuild(b, { s1: g });
    expect(r.points.map((p) => [p.v.dataType, p.size])).toEqual([["U64 (LE)", 4], ["I16", 1]]);
    const t2: PlTable = { ...t, dtMap: { on: true, map: {} } };
    const out = conditionTable(t2, g, 1, 1, set);
    expect(out[1].warn.dataType?.[0]).toMatch(/not mapped to the EMS-SC set/);
  });
  it("formats series and resolves them once per row in result order", () => {
    expect(fmtSeries(32, "0000")).toBe("0032");
    expect(fmtSeries(7, "RK-00")).toBe("RK-07");
    expect(fmtSeries(5, "")).toBe("5");
    expect(fmtSeries(12, "#")).toBe("12");
    const t: PlTable = { ...table, columns: table.columns.map((c) => (c.field === "tag" ? { ...c, rules: [{ op: "set", a: "SIG{series:Sig}_{col:Name}" }] } : c)).concat([{ id: "d", field: "description", type: "str", source: "", rules: [{ op: "set", a: "Signal {series:Sig} at {Result!modicon}" }] }]) };
    const b: PlBuild = { ...build([{ count: 2 }]), tables: [t], series: [{ id: "s", name: "Sig", start: 10, step: 5, format: "000" }] };
    const r = runBuild(b, { s1: grid });
    expect(r.points.map((p) => p.v.tag)).toEqual(["SIG010_V", "SIG015_I", "SIG020_SoC", "SIG025_V", "SIG030_I", "SIG035_SoC"]);
    expect(r.points[3].v.description).toBe("Signal 025 at 40007");
    expect(r.issues.filter((i) => i.kind === "tag")).toEqual([]);
  });
  it("resolves {Result!…} to the placed address and warns about unknown series", () => {
    expect(modiconRef("HR", 14)).toBe("40015");
    expect(modiconRef("CO", 0)).toBe("00001");
    expect(modiconRef("IR", 10000)).toBe("310001");
    const t: PlTable = { ...table, columns: table.columns.map((c) => (c.field === "tag" ? { ...c, rules: [{ op: "set", a: "R{n}_{Result!address}_{Result!space}_{series:Nope}" }] } : c)) };
    const r = runBuild({ ...build([{ count: 2, mode: "zero", start: 100 }]), tables: [t] }, { s1: grid });
    expect(r.points.map((p) => p.v.tag)[3]).toBe("R2_106_HR_{series:Nope}");
    expect(r.issues.some((i) => /Series "Nope" is not defined/.test(i.msg))).toBe(true);
  });
});

describe("plbuilder round 4: references and expressions", () => {
  const g = [["Name", "Addr", "Type", "Register Type", "Source_Device", "Unit"], ["V", "40001", "float32", "HR", "PCS1", "v"], ["P", "40003", "float32", "HR", "PCS1", "mw"]];
  const units = { on: true, name: "x", rows: [{ variable: "Voltage", match: "v, kv", proper: "V, kV", desired: "kV" }, { variable: "Active power", match: "w, kw, mw", proper: "W, kW, MW", desired: "kW" }] };
  const base: PlTable = {
    ...table, headerRow: 1, filters: [], units,
    columns: [
      { id: "t", field: "tag", type: "str", source: "Name", rules: [] },
      { id: "a", field: "address", type: "num", source: "Addr", rules: [{ op: "modicon", a: "offset" }] },
      { id: "r", field: "regType", type: "str", source: "Register Type", rules: [] },
      { id: "d", field: "dataType", type: "str", source: "Type", rules: [] },
      { id: "s", field: "", name: "Source_Device", type: "str", source: "Source_Device", rules: [] },
      { id: "u", field: "units", type: "str", source: "Unit", rules: [] },
    ],
  };
  const withTag = (rules: PlTable["columns"][0]["rules"]): PlTable => ({ ...base, columns: base.columns.map((c) => (c.id === "t" ? { ...c, rules } : c)) });
  const run = (t: PlTable) => runBuild({ ...build([{ mode: "zero", start: 13 }]), tables: [t] }, { s1: g });
  it("template: {col:…}, {Result!address|pad:4}, {out:Name}, {unit:desired}", () => {
    const t = withTag([{ op: "set", a: "{col:Register Type}_{Result!address|pad:4}_{out:Source_Device}_{unit:desired}" }]);
    expect(conditionTable(t, g)[0].v.tag).toBe("HR_{Result!address|pad:4}_{out:Source_Device}_{unit:desired}");
    expect(run(t).points.map((p) => p.v.tag)).toEqual(["HR_0013_PCS1_kV", "HR_0015_PCS1_kW"]);
  });
  it("python expression for the same tag, evaluated after placement", () => {
    const t = withTag([{ op: "expr", a: `f"{col['Register Type']}_{result.address:04d}_{out['Source_Device']}_{unit.desired}"` }]);
    expect(isLateRule(t.columns[0].rules[0])).toBe(true);
    expect(conditionTable(t, g)[0].v.tag).toMatch(/^\{=f"/);
    const r = run(t);
    expect(r.points.map((p) => p.v.tag)).toEqual(["HR_0013_PCS1_kV", "HR_0015_PCS1_kW"]);
    expect(r.issues.filter((i) => i.kind === "rule" || i.kind === "tag")).toEqual([]);
  });
  it("set value pad / prefix / suffix and rules after a deferred one", () => {
    const t = withTag([{ op: "set", a: "{Result!address}", b: "5", c: "0", d: "R_", e: "_{col:Name}" }, { op: "case", a: "lower" }]);
    expect(run(t).points.map((p) => p.v.tag)).toEqual(["r_00013_v", "r_00015_p"]);
    const t2 = withTag([{ op: "set", a: "{col:Name}", b: "4", c: "_", d: "X" }]);
    expect(conditionTable(t2, g).map((r) => r.v.tag)).toEqual(["X___V", "X___P"]);
  });
  it("expression errors are rule warnings; immediate expressions run while conditioning", () => {
    const t = withTag([{ op: "expr", a: `value + 1` }]);
    const rows = conditionTable(t, g);
    expect(rows[0].v.tag).toBe("V");
    expect(rows[0].warn.tag?.[0]).toMatch(/Expression: can only concatenate str/);
    const t2 = withTag([{ op: "expr", a: `value.lower() + "_" + out["Register type"]` }]);
    expect(conditionTable({ ...t2, columns: [t2.columns[2], t2.columns[0]] }, g)[0].v.tag).toBe("v_HR");
  });
  it("filters", () => {
    expect(applyFilters("14", "|pad:4")).toBe("0014");
    expect(applyFilters("14", "|pad:4:_|prefix:R|suffix:!")).toBe("R__14!");
    expect(applyFilters("7", "|fmt:RK-000")).toBe("RK-007");
    expect(applyFilters("3.14159", "|py:06.2f")).toBe("003.14");
    expect(applyFilters("", "|default:n/a|upper")).toBe("N/A");
  });
});
