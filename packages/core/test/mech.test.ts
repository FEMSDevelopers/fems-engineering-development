import { describe, expect, it } from "vitest";
import {
  asmIssues, autoArrange, bomCtx, cloneNode, emptyAsmLayout, emptyFne, emptyPart, emptyRack, fneIssues, freeU, freeZones, FNE_SIZES, groupNode, packRail,
  partDims, partNode, placeSlot, rackCandidates, rackIssues, toDxf, unitsOf, zoneFit, ductPreset, IN_MM, U_MM,
  type Part, type RackSlot,
} from "../src/index.js";

const P = (id: string, pn: string, mech: Partial<Part["mech"]>): Part => ({ ...emptyPart(), id, manufacturer: "M", partNumber: pn, description: pn, mech: { ...emptyPart().mech, ...mech } }) as Part;
const fw = P("fw", "FG-201G", { mount: "rack", rackUnits: 1, widthMm: 432, heightMm: 44, depthMm: 330 });
const srv = P("srv", "R650", { mount: "rack", rackUnits: 1, depthMm: 750, addZMm: 50 });
const cab = P("cab", "SR42UB", { mount: "floor", rackUnits: 42 });
const mcb = P("mcb", "2907595", { mount: "din", dinWidthMm: 36, heightMm: 90, depthMm: 70 });
const tb = P("tb", "3044102", { mount: "din", dinWidthMm: 6.2, heightMm: 47, depthMm: 40 });
const ups = P("ups", "TRIO3-UPS", { mount: "panel", widthMm: 120, heightMm: 130, depthMm: 125 });
const ctx = bomCtx([fw, srv, cab, mcb, tb, ups]);
const S = (id: string, u: number, h = 1, face: "front" | "rear" = "front", fullDepth = false): RackSlot => ({ id, nodeId: id, inst: 0, u, h, face, fullDepth });

describe("dimensions", () => {
  it("adds clearance adders and derives height from U", () => {
    expect(partDims(srv)).toMatchObject({ x: null, y: U_MM, z: 800 });
  });
});

describe("rack", () => {
  it("shifts colliding equipment up with an extra gap", () => {
    const slots = [S("a", 10, 2), S("b", 12, 1), S("c", 20, 1)];
    const r = placeSlot(slots, S("m", 1, 2), 10, "up", 1, 42);
    expect(r.ok).toBe(true);
    const u = Object.fromEntries(r.slots.map((s) => [s.id, s.u]));
    expect(u).toEqual({ m: 10, a: 13, b: 15, c: 20 });
    expect(r.moved).toBe(2);
  });
  it("shifts down and refuses to push out of the rack", () => {
    const slots = [S("a", 3, 2), S("b", 1, 2)];
    expect(placeSlot(slots, S("m", 20, 2), 3, "down", 0, 42).ok).toBe(false);
    const r = placeSlot([S("a", 10, 2)], S("m", 20, 2), 10, "down", 0, 42);
    expect(Object.fromEntries(r.slots.map((s) => [s.id, s.u]))).toEqual({ a: 8, m: 10 });
  });
  it("front and rear do not collide unless full depth", () => {
    expect(placeSlot([S("a", 5, 1, "rear")], S("m", 1, 1), 5, "up", 0, 42).slots.find((s) => s.id === "a")!.u).toBe(5);
    expect(placeSlot([S("a", 5, 1, "rear", true)], S("m", 1, 1), 5, "up", 0, 42).slots.find((s) => s.id === "a")!.u).toBe(6);
    expect(freeU([S("a", 42, 1)], 2, 42, "front")).toBe(40);
  });
  it("lists candidates and checks the layout", () => {
    const unit = groupNode("", { tags: ["RACK.01"], children: [partNode(cab, 1), partNode(fw, 2, { tags: ["FW.01", "FW.02"] }), partNode(srv, 3)] });
    const c = rackCandidates(unit, ctx);
    expect(c.map((x) => [x.node.partId, x.count])).toEqual([["fw", 2], ["srv", 3]]);
    const rack = { ...emptyRack(42), depthMm: 760, slots: [{ ...S("s1", 40), nodeId: c[0].node.id }, { ...S("s2", 40), nodeId: c[1].node.id }] };
    const iss = rackIssues(rack, unit, ctx).map((i) => i.msg);
    expect(iss.some((m) => m.includes("overlap"))).toBe(true);
    expect(iss.some((m) => m.includes("800 mm deep"))).toBe(true);
  });
});

describe("DIN assemblies", () => {
  it("auto-arranges, packs and checks rail length", () => {
    const g = groupNode("PDU", { children: [partNode(mcb, 2, { tags: ["MCB.01A", "MCB.01B"] }), partNode(tb, 12)] });
    let l = { ...emptyAsmLayout("din"), widthMm: 120 };
    l.rails[0].length = 120;
    l = autoArrange(l, g, ctx);
    expect(l.items).toHaveLength(14);
    expect(asmIssues(l, g, ctx).some((i) => i.msg.includes("146.4 mm of devices on 120 mm"))).toBe(true);
    l.items[1].x = 60;
    l = packRail(l, l.rails[0].id, g, ctx);
    expect(l.items[1].x).toBe(36);
    expect(unitsOf(g)).toHaveLength(14);
  });
  it("clones layouts with the node ids remapped", () => {
    const g = groupNode("PDU", { children: [partNode(mcb, 1)] });
    g.layout = autoArrange(emptyAsmLayout("rack", 4), g, ctx);
    const c = cloneNode(g);
    expect(c.layout!.items[0].nodeId).toBe(c.children[0].id);
    expect(c.layout!.items[0].nodeId).not.toBe(g.children[0].id);
    expect(c.layout!.heightMm).toBeCloseTo(4 * U_MM);
  });
});

describe("FNE", () => {
  it("finds the free rows between wire ducts", () => {
    const f = emptyFne(FNE_SIZES[1]);
    const z = freeZones(f);
    // frame + 2 horizontal ducts → 3 rows inside the side ducts
    expect(z).toHaveLength(3);
    expect(z[0].w).toBeCloseTo(32.94 * IN_MM - 2 * 57.15, 1);
    expect(freeZones({ panel: f.panel, ducts: ductPreset("none", f.panel) })).toHaveLength(1);
  });
  it("centres an assembly in its zone and checks clearances and depth", () => {
    const f = emptyFne(FNE_SIZES[1]);
    const z = freeZones(f)[1];
    const zp = { id: "z", nodeId: "n", inst: 0, px: z.x + 10, py: z.y + 10, offX: 0, offY: 0, clrX: 10, clrY: 10, clrZ: 25 };
    const ok = zoneFit(f, zp, { w: 400, h: 150, d: 120 });
    expect(ok.ok).toBe(true);
    expect(ok.x).toBeCloseTo(z.x + (z.w - 400) / 2);
    expect(zoneFit(f, zp, { w: z.w, h: 150, d: 120 }).msgs[0]).toMatch(/wide/);
    expect(zoneFit(f, zp, { w: 100, h: 100, d: 400 }).msgs[0]).toMatch(/depth/);
  });
  it("flags items on ducts and overlaps", () => {
    const unit = groupNode("", { tags: ["FNE.01"], children: [partNode(ups, 2)] });
    const f = emptyFne(FNE_SIZES[0]);
    const n = unit.children[0];
    f.items = [{ id: "a", nodeId: n.id, inst: 0, x: 10, y: 100 }, { id: "b", nodeId: n.id, inst: 1, x: 100, y: 150 }];
    const m = fneIssues(f, unit, ctx).map((i) => i.msg);
    expect(m.some((x) => x.includes("wire duct"))).toBe(true);
    expect(m.some((x) => x.includes("overlap"))).toBe(true);
  });
});

describe("DXF", () => {
  it("writes entities with y flipped", () => {
    const d = toDxf([{ t: "rect", x: 0, y: 0, w: 10, h: 5 }, { t: "text", x: 1, y: 5, h: 2, text: "-FW.01" }]);
    expect(d).toContain("ENTITIES");
    expect(d.match(/\r\nLINE\r\n/g)).toHaveLength(4);
    expect(d).toContain("-FW.01");
    expect(d.trim().endsWith("EOF")).toBe(true);
  });
});

import { labelAnchor } from "../src/index.js";
describe("part-line balloons", () => {
  it("places balloons inside or outside the device", () => {
    const b = { x: 0, y: 0, w: 100, h: 40 };
    expect(labelAnchor(b, "TL", false, 5)).toEqual({ x: 7, y: 7 });
    expect(labelAnchor(b, "TL", true, 5)).toEqual({ x: -7, y: -7 });
    expect(labelAnchor(b, "R", true, 5)).toEqual({ x: 107, y: 20 });
    expect(labelAnchor(b, "B", false, 5)).toEqual({ x: 50, y: 33 });
    expect(labelAnchor(b, "BR", false, 5, 1)).toEqual({ x: 81, y: 33 });
  });
});
