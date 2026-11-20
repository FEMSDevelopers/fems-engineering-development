import { describe, expect, it } from "vitest";
import {
  applyArray, asmCheck, asmGroupRoot, asmIssues, asmShapes, bomCtx, cloneNode, emptyAsmLayout, emptyPart, groupNode, newAsmGroup, packAll, packRail, partNode, railUsage,
  syncUndefinedUnits, undefinedMechParts, unitLabelOf, type AsmLayout, type BomNode, type MechLayoutDoc, type Part,
} from "../src/index.js";

const P = (id: string, pn: string, mech: Partial<Part["mech"]>): Part => ({ ...emptyPart(), id, manufacturer: "M", partNumber: pn, description: pn, mech: { ...emptyPart().mech, ...mech } }) as Part;
const mcb = P("mcb", "2907595", { mount: "din", dinWidthMm: 36, heightMm: 90, depthMm: 70 });
const tb = P("tb", "3044102", { mount: "din", dinWidthMm: 6.2, heightMm: 47, depthMm: 40 });
const psu = P("psu", "QUINT", { mount: "din", dinWidthMm: 40, heightMm: 130, depthMm: 125 });
const ctx = bomCtx([mcb, tb, psu]);

function bom() {
  const b1 = groupNode("B1", { id: "B1", children: [partNode(mcb, 2, { id: "b1mcb" }), partNode(tb, 4, { id: "b1tb" })] });
  const b2 = groupNode("B2", { id: "B2", children: [partNode(mcb, 1, { id: "b2mcb" })] });
  const rack = groupNode("RACK", { id: "U1", tags: ["RACK.01"], children: [groupNode("PDU.01", { id: "PDU", children: [b1, b2] })] });
  return [rack];
}

describe("assembly groups", () => {
  it("composes a group from several BOM groups and checks quantities", () => {
    const units = bom();
    const l: AsmLayout = emptyAsmLayout("rack", 4);
    const g = newAsmGroup("PDU.01", { sources: ["B1", "B2"], layout: l });
    const { root, missing } = asmGroupRoot(g, units);
    expect(missing).toEqual([]);
    expect(root.children.map((c) => c.id)).toEqual(["B1", "B2"]);
    const rail = l.rails[0].id;
    g.layout = { ...l, items: [{ id: "i1", nodeId: "b1mcb", inst: 0, railId: rail, x: 20, y: 0 }, { id: "i2", nodeId: "b2mcb", inst: 0, railId: rail, x: 60, y: 0, side: "rear" }] };
    const c = asmCheck(g, units, ctx);
    expect(c.rows.find((r) => r.node.id === "b1mcb")).toMatchObject({ bom: 2, placed: 1, status: "short" });
    expect(c.rows.find((r) => r.node.id === "b2mcb")).toMatchObject({ bom: 1, placed: 1, status: "ok" });
    expect(c.ok).toBe(false);
  });
  it("flags shared sources and missing sources", () => {
    const units = bom();
    const a = newAsmGroup("A", { sources: ["PDU"] });
    const b = newAsmGroup("B", { sources: ["B1", "GONE"] });
    const c = asmCheck(b, units, ctx, [a, b]);
    expect(c.missing).toEqual(["GONE"]);
    expect(c.shared[0]).toMatchObject({ id: "B1", groups: ["A"] });
  });
  it("lists extras separately (not validated against the BOM)", () => {
    const units = bom();
    const g = newAsmGroup("X", { sources: ["B2"], extras: [groupNode("ADDED PARTS", { id: "ex", children: [partNode(psu, 1, { id: "expsu" })] })] });
    const c = asmCheck(g, units, ctx);
    expect(c.extras).toHaveLength(1);
    expect(c.extras[0]).toMatchObject({ qty: 1, placed: 0 });
  });
});

describe("rack-mounted front / rear rails and arrays", () => {
  const group: BomNode = groupNode("G", { children: [partNode(tb, 6, { id: "t" }), partNode(mcb, 2, { id: "m" })] });
  it("keeps separate usage for the front and the rear of the same rail", () => {
    const l0 = emptyAsmLayout("rack", 2);
    const r = l0.rails[0].id;
    const l = { ...l0, items: [{ id: "a", nodeId: "m", inst: 0, railId: r, x: 16, y: 0 }, { id: "b", nodeId: "m", inst: 1, railId: r, x: 16, y: 0, side: "rear" as const }] };
    const u = railUsage(l, group, ctx);
    expect(u.get(r)!.used).toBe(36);
    expect(u.get(`${r}|rear`)!.used).toBe(36);
    // Same x on different sides is no overlap.
    expect(asmIssues(l, group, ctx).filter((i) => i.level === "error")).toEqual([]);
    const sh = asmShapes(l, group, ctx);
    expect(sh.filter((s) => s.layer === "PLATE")).toHaveLength(2);
  });
  it("builds an array with spacing and packs the rail keeping it", () => {
    const l0 = emptyAsmLayout("din");
    const r = l0.rails[0].id;
    let l: AsmLayout = { ...l0, items: [{ id: "a", nodeId: "t", inst: 0, railId: r, x: 50, y: 0 }] };
    l = applyArray(l, "a", { n: 3, gap: 0.01, left: 0.01, right: 0.02, useLeft: true, useRight: true }, 6.2, [1, 2]);
    expect(l.items.filter((i) => i.arr)).toHaveLength(3);
    expect(l.arrays).toHaveLength(1);
    const xs = l.items.map((i) => i.x).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeCloseTo(6.21, 5);
    expect(railUsage(l, group, ctx).get(r)!.used).toBeCloseTo(3 * 6.2 + 2 * 0.01 + 0.01 + 0.02, 5);
    l = packRail(l, r, group, ctx);
    const p = l.items.map((i) => i.x).sort((a, b) => a - b);
    expect(p[0]).toBeCloseTo(0.01, 5);
    expect(p[2]).toBeCloseTo(0.01 + 2 * 6.21, 5);
    // Left spacing off → the array starts at the rail start.
    l = { ...l, arrays: l.arrays!.map((a) => ({ ...a, useLeft: false })) };
    l = packAll(l, group, ctx);
    expect(Math.min(...l.items.map((i) => i.x))).toBe(0);
    // n = 1 dissolves the array.
    l = applyArray(l, l.items[0].id, { n: 1, gap: 0, left: 0, right: 0, useLeft: false, useRight: false }, 6.2, []);
    expect(l.items).toHaveLength(1);
    expect(l.arrays).toEqual([]);
  });
  it("rail groups have no plate or DIN-rail part in the drawing export", () => {
    const l = emptyAsmLayout("rail");
    const sh = asmShapes(l, group, ctx);
    expect(sh.some((s) => s.layer === "PLATE" || s.layer === "DINRAIL")).toBe(false);
    expect(sh.some((s) => s.layer === "RAIL_REF")).toBe(true);
  });
  it("clone re-points palette keys and arrays", () => {
    const l0 = emptyAsmLayout("din");
    const g = groupNode("G", { children: [groupNode("S", { id: "s1", children: [partNode(tb, 2, { id: "t1" })] })], layout: { ...l0, palette: { s1: { color: "#ff0000", width: 2 } }, arrays: [{ id: "A", n: 2, gap: 1, left: 0, right: 0, useLeft: false, useRight: false }] } });
    const c = cloneNode(g);
    const sid = c.children[0].id;
    expect(sid).not.toBe("s1");
    expect(c.layout!.palette![sid]).toEqual({ color: "#ff0000", width: 2 });
    expect(c.layout!.arrays).toHaveLength(1);
  });
});

describe("undefined mechanical parts", () => {
  it("collects layout lines not on the BOM per unit and keeps one generated unit after it", () => {
    const units = bom();
    const lay: MechLayoutDoc = {
      kind: "rack", ref: { projectId: "p", projectName: "P", major: null, minor: null, unitId: "U1", unitLabel: "RACK.01" }, display: "both",
      unit: groupNode("RACK", { children: [partNode(psu, 2, { id: "lp" }), { ...partNode(mcb, 2, { id: "lm" }), bomNodeId: "b1mcb", links: ["b1mcb"] }] }),
    } as MechLayoutDoc;
    const set = { link: null, groups: [newAsmGroup("X", { sources: ["B2"], extras: [groupNode("ADDED", { children: [partNode(psu, 1)] })] })] };
    const want = undefinedMechParts(units, [lay], set, ctx);
    expect(want.get("U1")).toEqual([expect.objectContaining({ partId: "psu", qty: 3 })]);
    const next = syncUndefinedUnits(units, want, unitLabelOf);
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ mechUndef: "U1", name: "UNDEFINED MECHANICAL PARTS (RACK.01)" });
    expect(next[1].children[0]).toMatchObject({ partId: "psu", qty: 3 });
    // A copy of a group's extra placed in a layout is not counted twice.
    const exId = set.groups[0].extras[0].children[0].id;
    const lay2 = { ...lay, unit: { ...lay.unit, children: [...lay.unit.children, { ...partNode(psu, 1), bomNodeId: exId, links: [exId] }] } };
    expect(undefinedMechParts(units, [lay2], set, ctx).get("U1")![0].qty).toBe(3);
    // Idempotent; removed when nothing is undefined any more.
    expect(syncUndefinedUnits(next, want, unitLabelOf)).toBe(next);
    expect(syncUndefinedUnits(next, new Map(), unitLabelOf)).toHaveLength(1);
  });
});
