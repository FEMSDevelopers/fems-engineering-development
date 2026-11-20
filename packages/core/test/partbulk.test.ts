import { describe, expect, it } from "vitest";
import { bulkApply, emptyPart, parseSpec, type Part, type Subcategory } from "../src/index.js";

const sub: Subcategory = { id: "s1", category: "Power", name: "MCB", tagPrefix: "MCB.", sort: 0, portTypes: [], fields: [
  { key: "poles", label: "Poles", type: "number" }, { key: "curve", label: "Curve", type: "select" }, { key: "ul", label: "UL", type: "bool" }, { key: "v", label: "V", type: "range" },
] };
const sub2: Subcategory = { ...sub, id: "s2", category: "Network", name: "Switch", fields: [] };
const subs = new Map([[sub.id, sub], [sub2.id, sub2]]);
const P = (o: Partial<Part>): Part => ({ ...emptyPart(), id: "p", manufacturer: "M", partNumber: "X", description: "d", ...o }) as Part;

describe("bulk update", () => {
  it("overwrites or fills empty fields only", () => {
    const p = P({ vendor: "Graybar", series: "", subcategoryId: "s1", custom: { poles: 2 } });
    const sets = [{ key: "vendor", value: "RS" }, { key: "series", value: "QR" }, { key: "spec:poles", value: "3" }, { key: "spec:curve", value: "C" }];
    const o = bulkApply(p, sets, "overwrite", subs);
    expect(o.patch).toMatchObject({ vendor: "RS", series: "QR", custom: { poles: 3, curve: "C" } });
    const e = bulkApply(p, sets, "empty", subs);
    expect(e.patch).toMatchObject({ series: "QR", custom: { poles: 2, curve: "C" } });
    expect(e.patch!.vendor).toBeUndefined();
    expect(e.skipped).toEqual(expect.arrayContaining(["vendor", "spec:poles"]));
  });
  it("types numbers, mechanical fields, subcategory, booleans and ranges; reports bad values", () => {
    const p = P({});
    const r = bulkApply(p, [{ key: "price", value: "12,5" }, { key: "mech.dinWidthMm", value: "17.5" }, { key: "mech.mount", value: "din" }, { key: "subcategoryId", value: "s2" }, { key: "stock", value: "abc" }], "overwrite", subs);
    expect(r.patch).toMatchObject({ price: 12.5, mech: { dinWidthMm: 17.5, mount: "din" }, subcategoryId: "s2", category: "Network" });
    expect(r.errors).toHaveLength(1);
    expect(parseSpec(sub.fields[2], "yes")).toBe(true);
    expect(parseSpec(sub.fields[3], "100-240")).toEqual([100, 240]);
    expect(bulkApply(P({ price: 3 }), [{ key: "price", value: "3" }], "overwrite", subs).patch).toBeNull();
    expect(bulkApply(P({ price: 3 }), [{ key: "price", value: "" }], "overwrite", subs).patch).toEqual({ price: null });
  });
});
