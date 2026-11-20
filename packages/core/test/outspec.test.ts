import { describe, expect, it } from "vitest";
import {
  bomCtx, emptyPart, eqCopyRows, equipmentLists, groupNode, partNode, rollup, rollupGridSpec, sortRollup, toTsv, DEFAULT_EQ_SPEC, type Part,
} from "../src/index.js";

const P = (id: string, pn: string, o: Partial<Part>): Part => ({ ...emptyPart(), id, manufacturer: "M", partNumber: pn, description: `D ${pn}`, ...o }) as Part;
const a = P("a", "B200", { vendor: "Graybar", price: 10, subcategoryId: "s1", custom: { poles: 2 } });
const b = P("b", "A100", { vendor: "Anixter", price: 50, subcategoryId: "s1" });
const c = P("c", "C300", { vendor: "Graybar", price: 1 });
const ctx = bomCtx([a, b, c], [{ id: "s1", category: "Power", name: "MCB", tagPrefix: "MCB.", fields: [{ key: "poles", label: "Poles", type: "number" }], portTypes: [], sort: 0 }]);
const units = [groupNode("RACK", { tags: ["RACK.01"], children: [groupNode("SECTION", { children: [partNode(a, 2), partNode(b, 1)] }), partNode(c, 5)] })];

describe("equipment list columns", () => {
  it("adds master-part and spec columns and keeps the default layout", () => {
    const def = equipmentLists(units, ctx)[0];
    expect(def.grid[0]).toEqual(["No.", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", "QTY", "PREFIX", "DEVICE TAGS"]);
    const g = equipmentLists(units, ctx, { cols: [...DEFAULT_EQ_SPEC.cols, { key: "part:vendor" }, { key: "spec:poles", label: "P" }] })[0];
    expect(g.grid[0].slice(-2)).toEqual(["VENDOR", "P"]);
    const row = g.grid.find((r) => r[2] === "B200")!;
    expect(row.slice(-2)).toEqual(["Graybar", "2"]);
  });
  it("copies rows without the header, or header + full rows without sub-headers", () => {
    const g = equipmentLists(units, ctx)[0];
    const body = eqCopyRows(g, "body");
    expect(body).toHaveLength(g.grid.length - 1);
    expect(body.some((r) => r[3] === "SECTION")).toBe(true);
    const full = eqCopyRows(g, "full");
    expect(full[0][0]).toBe("No.");
    expect(full.slice(1).every((r) => r[2])).toBe(true);
    expect(full).toHaveLength(4);
    expect(toTsv([["a\tb", "c"]])).toBe("a b\tc");
  });
  it("can leave group rows out", () => {
    const g = equipmentLists(units, ctx, { ...DEFAULT_EQ_SPEC, groups: false })[0];
    expect(g.groupRows).toEqual([]);
  });
});

describe("purchasing roll-up spec", () => {
  it("sorts by several levels and builds the chosen columns", () => {
    const rows = rollup(units, ctx);
    const byVendor = sortRollup(rows, [{ key: "vendor" }, { key: "mfr" }, { key: "sub" }, { key: "pn" }], ctx);
    expect(byVendor.map((r) => r.partNumber)).toEqual(["A100", "B200", "C300"]);
    expect(sortRollup(rows, [{ key: "price", desc: true }], ctx).map((r) => r.partNumber)).toEqual(["A100", "B200", "C300"]);
    expect(sortRollup(rows, [{ key: "total", desc: true }], ctx)[0].partNumber).toBe("C300");
    expect(sortRollup(rows, [{ key: "desc", desc: true }], ctx)[0].partNumber).toBe("C300");
    const g = rollupGridSpec(byVendor, ["RACK.01"], { cols: [{ key: "vendor" }, { key: "mfr" }, { key: "sub" }, { key: "pn" }, { key: "units" }, { key: "ext" }], sortMode: "keys", sort: [] }, ctx);
    expect(g[0]).toEqual(["VENDOR", "MANUFACTURER", "SUBCATEGORY", "PART NUMBER", "RACK.01", "EXT. PRICE"]);
    expect(g[2]).toEqual(["Graybar", "M", "MCB", "B200", "2", "20.00"]);
  });
});

import { compareSortValues, multiSort } from "../src/outspec";
describe("multiSort", () => {
  const rows = [
    { m: "Siemens", pn: "A10", p: "12.5", s: "" },
    { m: "ABB", pn: "A2", p: "9", s: "x" },
    { m: "siemens", pn: "A2", p: "", s: "y" },
    { m: "ABB", pn: "A10", p: "1,250", s: "" },
  ];
  const v = (k: string, r: (typeof rows)[number]) => (r as Record<string, string>)[k];
  it("sorts by several levels, natural order, case-insensitive, stable", () => {
    expect(multiSort(rows, [{ key: "m" }, { key: "pn" }], v).map((r) => `${r.m} ${r.pn}`)).toEqual(["ABB A2", "ABB A10", "siemens A2", "Siemens A10"]);
    expect(multiSort(rows, [{ key: "m", desc: true }], v).map((r) => r.pn)).toEqual(["A10", "A2", "A2", "A10"]);
    expect(multiSort(rows, [], v)).toEqual(rows);
  });
  it("compares numbers as numbers and puts empty values last in both directions", () => {
    expect(multiSort(rows, [{ key: "p" }], v).map((r) => r.p)).toEqual(["9", "12.5", "1,250", ""]);
    expect(multiSort(rows, [{ key: "p", desc: true }], v).map((r) => r.p)).toEqual(["1,250", "12.5", "9", ""]);
    expect(multiSort(rows, [{ key: "s", desc: true }, { key: "pn" }], v).map((r) => r.s || "-")).toEqual(["y", "x", "-", "-"]);
    expect(compareSortValues("\u221240", "5")).toBeLessThan(0);
    expect(compareSortValues("10 A", "2 A")).toBeGreaterThan(0);
  });
});

