import { describe, expect, it } from "vitest";
import { arrayElements, checkCell, elementKeys, emptyInstance, instanceMeta, legacyOutputs, type JsInstance, getIn, guessColType, parseJson, runCond, scanJson, setIn, tableIssues, type JsCond, type JsTableData } from "../src/index.js";

const doc = {
  site: "Alpha",
  devices: [
    { name: "PCS-1", ip: "10.0.0.1", points: [{ tag: "P", addr: 1, meta: { unit: "kW" } }, { tag: "Q", addr: 3, meta: { unit: "kVAR" } }] },
    { name: "PCS-2", ip: "10.0.0.2", points: [{ tag: "P", addr: 1, meta: { unit: "kW" } }] },
    { name: "BMS-1", ip: "10.0.0.3", points: [], "odd key": true },
  ],
  matrix: [[1, 2], [3]],
};
const tags: JsTableData = {
  columns: [{ name: "Device", type: "text" }, { name: "Prefix", type: "text" }, { name: "Rack", type: "integer" }],
  rows: [["PCS-1", "PCS01", "1"], ["pcs-2", "PCS02", "2"]],
};

describe("json editor core", () => {
  it("validates column types (ISO 8601) and guesses them", () => {
    expect(checkCell("date", "2026-10-22")).toBeNull();
    expect(checkCell("date", "2026-02-30")).toBe("no such date");
    expect(checkCell("time", "14:05:30")).toBeNull();
    expect(checkCell("datetime", "2026-10-22T14:05:30Z")).toBeNull();
    expect(checkCell("integer", "3.5")).toMatch(/not an integer/);
    expect(guessColType(["1", "2"])).toBe("integer");
    expect(guessColType(["1.5", "2"])).toBe("number");
    expect(guessColType(["2026-01-01"])).toBe("date");
    expect(guessColType(["1", "2", "3", "x"])).toBe("integer");
    expect(guessColType(["1", "2", "x"])).toBe("text");
    expect(tableIssues({ columns: [{ name: "A", type: "integer" }, { name: "a", type: "text" }], rows: [["x", ""]] }).map((i) => i.msg)).toEqual(['A: "x" not an integer (e.g. 42)', 'Duplicate column name "a"']);
  });
  it("reports JSON syntax errors with line and column", () => {
    const r = parseJson('{\n  "a": 1,\n  "b": }');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Unexpected '}' at line 3, column 8");
    const r2 = parseJson("{'a': 1}");
    if (!r2.ok) expect(r2.error).toMatch(/double quotes/);
    const r3 = parseJson('[1, 2,]');
    if (!r3.ok) expect(r3.error).toBe("Trailing comma before ']' at line 1, column 7");
  });
  it("scans nested arrays and objects with element summaries", () => {
    const n = Object.fromEntries(scanJson(doc).map((x) => [x.path, x]));
    expect(n["$.devices"]).toMatchObject({ kind: "array", instances: 1, count: 3, itemKinds: { object: 3 } });
    expect(n["$.devices[*].points"]).toMatchObject({ kind: "array", instances: 3, count: 3, min: 0, max: 2, parent: "$.devices[*]" });
    expect(n["$.devices[*].points[*].meta"]).toMatchObject({ kind: "object", instances: 3, count: 1 });
    expect(n["$.matrix[*]"]).toMatchObject({ kind: "array", instances: 2, count: 3 });
    expect(n['$.devices[*]']).toMatchObject({ kind: "object", count: 4 });
  });
  it("resolves elements with their parents and lists element keys", () => {
    const els = arrayElements(doc, "$.devices[*].points");
    expect(els.map((e) => e.ptr)).toEqual(["$.devices[0].points[0]", "$.devices[0].points[1]", "$.devices[1].points[0]"]);
    expect(els.map((e) => (e.parent as { name: string }).name)).toEqual(["PCS-1", "PCS-1", "PCS-2"]);
    expect(elementKeys(els).map((k) => `${k.path}:${k.count}`)).toEqual(["tag:3", "addr:3", "meta.unit:3"]);
    expect(getIn(doc, '$.devices[2]["odd key"]')).toBe(true);
    const o = {};
    setIn(o, "a.b", 1);
    expect(o).toEqual({ a: { b: 1 } });
  });
  it("conditions elements with rules, expressions, python code and lookups", () => {
    const cond: JsCond = {
      lookups: [],
      fields: [
        { id: "1", target: "tag", source: "tag", out: "auto", rules: [{ op: "expr", a: `lookup("Tags", "Device", parent["name"], "Prefix", default="X") + "_" + value + "_" + f"{el['addr']:03d}"` }] },
        { id: "2", target: "rack", source: "", out: "auto", rules: [{ op: "code", a: `row = lookup_row("Tags", "Device", parent.name)\nif row is None:\n    return 0\nreturn row["Rack"] * 10` }] },
        { id: "3", target: "label", source: "meta.unit", out: "text", rules: [{ op: "prefix", a: "{col:parent.name}/" }] },
        { id: "4", target: "addr", source: "addr", out: "auto", rules: [{ op: "add", a: "100" }] },
        { id: "5", target: "kind", source: "", out: "text", rules: [{ op: "code", a: `unit = el["meta"]["unit"]\nresult = "power" if unit in ("kW", "kVAR") else "other"\nreturn result` }] },
      ],
    };
    const r = runCond(doc, "$.devices[*].points", cond, { Tags: tags });
    const pts = (r.out as typeof doc).devices.flatMap((d) => d.points) as Record<string, unknown>[];
    expect(pts.map((p) => p.tag)).toEqual(["PCS01_P_001", "PCS01_Q_003", "PCS02_P_001"]);
    expect(pts.map((p) => p.addr)).toEqual([101, 103, 101]);
    expect(pts[0].label).toBe("PCS-1/kW");
    expect(pts.map((p) => p.kind)).toEqual(["power", "power", "power"]);
    expect(pts.map((p) => p.rack)).toEqual(["10", "10", "20"]); // new key, Auto → text
    // a function library used by the conditioning (it can call lookup())
    const lib = `def prefix_of(device):\n    """Prefix of a device from the Tags table."""\n    return lookup("Tags", "Device", device, "Prefix", default="X")`;
    const r2 = runCond(doc, "$.devices[*].points", { lookups: [], fields: [{ id: "1", target: "tag", source: "tag", out: "text", rules: [{ op: "expr", a: `prefix_of(parent["name"]) + "-" + value` }] }] }, { Tags: tags }, { libs: [lib] });
    expect(((r2.out as typeof doc).devices[1].points[0] as Record<string, unknown>).tag).toBe("PCS02-P");
    expect(r.changed).toBe(3);
    expect(doc.devices[0].points[0].tag).toBe("P");
  });
});

describe("instances", () => {
  it("holds a document; legacy outputs are recognised", () => {
    const i = emptyInstance();
    expect(i).toEqual({ source: { name: "", text: "" } });
    i.source = { name: "Plant A", text: "x".repeat(2048) };
    expect(instanceMeta(i)).toMatchObject({ source: "Plant A", kb: 2 });
    expect(legacyOutputs(i)).toEqual([]);
    const old: JsInstance = { ...i, outputs: [
      { id: "a", name: "Output 1", path: "$.devices", cond: { fields: [{ id: "f", target: "t", source: "", out: "auto", rules: [] }], lookups: [] } },
      { id: "b", name: "Output 2", path: "", cond: { fields: [], lookups: [] } },
    ] };
    expect(legacyOutputs(old).map((o) => o.id)).toEqual(["a"]);
  });
});
