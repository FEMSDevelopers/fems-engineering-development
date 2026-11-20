import { describe, expect, it } from "vitest";
import { DEFAULT_DIFF_SPEC, bomCtx, diffBom, diffGrids, diffSheet, emptyPart, groupNode, partNode, type Part } from "../src/index.js";

const P = (id: string, pn: string, o: Partial<Part> = {}): Part => ({ ...emptyPart(), id, manufacturer: "M", partNumber: pn, description: `D ${pn}`, ...o }) as Part;
const a = P("a", "A1", { vendor: "Graybar", price: 2 });
const b = P("b", "B2", { vendor: "Anixter", price: 10 });
const ctx = bomCtx([a, b]);
const A = [groupNode("U", { tags: ["RACK.01"], children: [partNode(a, 2)] })];
const B = [groupNode("U", { tags: ["RACK.01"], children: [partNode(a, 5), partNode(b, 1)] })];

describe("compare export spec", () => {
  it("default columns reproduce the built-in sheet", () => {
    const d = diffBom(A, B);
    const ch = d.rollup.filter((r) => r.status !== "same");
    const g = diffSheet(ch, DEFAULT_DIFF_SPEC.changes, ctx, { a: "P v1.001 (60%)", b: "P v1.002 (90%)" });
    const ref = diffGrids(d, "P v1.001 (60%)", "P v1.002 (90%)")[0].grid;
    expect(g.errors).toEqual([]);
    expect(g.grid).toEqual(ref);
  });
  it("python columns from the master list and a python sort", () => {
    const d = diffBom(A, B);
    const g = diffSheet(d.rollup, { cols: [{ header: "VENDOR", expr: "vendor" }, { header: "PN", expr: "pn" }, { header: "EXT B", expr: 'f"{ext_b:.2f}" if ext_b else ""' }, { header: "BAD", expr: "nope" }], sort: "-delta", descending: false }, ctx, { a: "x", b: "y" });
    expect(g.grid[0]).toEqual(["VENDOR", "PN", "EXT B", "BAD"]);
    expect(g.grid[1].slice(0, 3)).toEqual(["Graybar", "A1", "10.00"]);
    expect(g.grid[2].slice(0, 3)).toEqual(["Anixter", "B2", "10.00"]);
    expect(g.errors.length).toBe(1);
  });
});
