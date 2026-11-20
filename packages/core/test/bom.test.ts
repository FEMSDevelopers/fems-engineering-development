import { describe, expect, it } from "vitest";
import {
  autoTags, bomCtx, computeLoads, diffBom, emptyBus, emptyPart, equipmentListGrids, explode, fullTagsOf, groupNode, guessSubcategory, itemNumbers,
  letters, loadGrid, parseEquipmentList, parseTag, partMatcher, partNode, rollup, tagIssues, tagListGrid, cloneNode, moveNode, findNode,
  type BomNode, type LoadBus, type Part, type Subcategory,
} from "../src/index.js";

const P = (id: string, manufacturer: string, partNumber: string, description: string, over: Partial<Part> = {}): Part => ({ ...emptyPart(), id, manufacturer, partNumber, description, ...over }) as Part;

const parts: Part[] = [
  P("rack", "TRIPP LITE", "SR42UB", "19in 42U cabinet"),
  P("fan", "COOLTRON", "FA1238B22T7-97", "Axial fan 230VAC", { powerIn: { kind: "AC1", voltage: 230, range: "", watts: 24, amps: null, pf: 1, feeds: 1, terminals: ["L", "N", "G"] } }),
  P("mcb", "PHOENIX CONTACT", "2907595", "MCB 2P C16", { tagPrefix: "MCB." }),
  P("ps", "PHOENIX CONTACT", "2904602", "QUINT 24VDC 480W", { tagPrefix: "PS.", powerOut: { kind: "DC", voltage: 24, watts: 480, amps: 20, efficiency: 0.92, terminals: ["+", "-"] } }),
  P("sc", "FRACTAL", "SC-09-R-GPIC", "Site controller", { powerIn: { kind: "DC", voltage: 24, range: "", watts: 65, amps: null, pf: null, feeds: 1, terminals: [] } }),
  P("sw", "FORTINET", "FSR-424F", "Rugged switch", { powerIn: { kind: "DC", voltage: 24, range: "", watts: 107.1, amps: null, pf: null, feeds: 2, terminals: [] } }),
  P("ws", "ONLOGIC", "WST", "Workstation", { powerIn: { kind: "DC", voltage: 24, range: "", watts: 65, amps: null, pf: null, feeds: 1, terminals: [] } }),
  P("ts", "DATANAB", "MBUS_WTH_LCD_ETH", "Temp sensor", { powerIn: { kind: "DC", voltage: 24, range: "", watts: 5, amps: null, pf: null, feeds: 1, terminals: [] } }),
];
const ctx = bomCtx(parts);

function rack(): BomNode {
  const pdu = groupNode("AC ELECTRICAL PROTECTION DEVICES", { maker: "FRACTAL", tags: ["PDU.01"] });
  pdu.children.push(partNode(parts[2], 2, { tags: ["MCB.01A", "MCB.01B"] }));
  const r = groupNode("", { tags: ["RACK.01"] });
  const a = groupNode("FRACTAL SITE EQUIPMENT / HARDWARE");
  const a1 = groupNode("SERVER RACK");
  const line = groupNode("", { line: true });
  line.children.push(partNode(parts[0], 1, { tags: ["RACK.01"] }), partNode(parts[1], 12, { prefix: "FAN." }));
  a1.children.push(line);
  a.children.push(a1);
  const b = groupNode("FRACTAL ASSEMBLIES");
  b.children.push(pdu);
  r.children.push(a, b);
  return r;
}

describe("tags", () => {
  it("parses signs and builds hierarchical tags", () => {
    expect(parseTag("-MCB.01A")).toEqual({ tag: "MCB.01A", role: "prod" });
    expect(parseTag("+RACK.01")).toEqual({ tag: "RACK.01", role: "loc" });
    const r = rack();
    const hit = findNode([r], r.children[1].children[0].children[0].id)!;
    expect(fullTagsOf(hit.node, hit.parents)).toEqual(["+RACK.01-PDU.01-MCB.01A", "+RACK.01-PDU.01-MCB.01B"]);
  });
  it("auto tags skip used numbers", () => {
    expect(autoTags("RTAC", 4, "seq")).toEqual(["RTAC.01", "RTAC.02", "RTAC.03", "RTAC.04"]);
    expect(autoTags("MCB.", 2, "letters", ["MCB.01A"])).toEqual(["MCB.02A", "MCB.02B"]);
    expect(autoTags("PS.", 4, "seqLetters")).toEqual(["PS.01A", "PS.01B", "PS.02A", "PS.02B"]);
  });
  it("reports duplicates and count mismatches", () => {
    const r = rack();
    r.children[1].children[0].children.push(partNode(parts[2], 1, { tags: ["MCB.01A"] }));
    const iss = tagIssues([r]);
    expect(Object.values(iss).flat().some((m) => m.includes("Duplicate tag +RACK.01-PDU.01-MCB.01A"))).toBe(true);
  });
  it("a sub-assembly reused under two parents gets unique full tags", () => {
    const pdu = rack().children[1].children[0];
    const r1 = groupNode("", { tags: ["RACK.01"], children: [groupNode("B", { children: [cloneNode(pdu)] })] });
    const r2 = groupNode("", { tags: ["RACK.02"], children: [groupNode("E", { children: [cloneNode(pdu)] })] });
    expect(Object.keys(tagIssues([r1, r2]))).toHaveLength(0);
  });
});

describe("numbering and explode", () => {
  it("numbers sections, groups, lines and lettered items", () => {
    const r = rack();
    const nos = itemNumbers([r]);
    const l = explode([r], ctx);
    expect(l.map((x) => nos.get(x.nodeId))).toEqual(["A", "A1", "A1.1", "A1.1a", "A1.1b", "B", "B1", "B1.1"]);
    const r2 = groupNode("", { tags: ["RACK.02"], children: [groupNode("X")] });
    expect(itemNumbers([r, r2]).get(r2.children[0].id)).toBe("C");
    expect(letters(26)).toBe("AA");
  });
  it("multiplies quantities through unit instances", () => {
    const fne = groupNode("", { tags: ["FNE.01", "FNE.02", "FNE.03"], qty: 3, children: [groupNode("P", { children: [partNode(parts[1], 4)] })] });
    const fan = explode([fne], ctx).find((x) => x.partId === "fan")!;
    expect(fan.perUnit).toBe(4);
    expect(fan.total).toBe(12);
    expect(rollup([rack(), fne], ctx).find((x) => x.partId === "fan")!.total).toBe(24);
    expect(tagListGrid([fne], ctx).map((r) => r[0])).toEqual(["FULL TAG", "+FNE.01", "+FNE.02", "+FNE.03"]);
  });
  it("equipment list grid", () => {
    const g = equipmentListGrids([rack()], ctx)[0];
    expect(g.title).toBe("EQUIPMENT LIST - RACK.01");
    expect(g.grid[0]).toEqual(["No.", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", "QTY", "PREFIX", "DEVICE TAGS"]);
    expect(g.grid.find((r) => r[0] === "A1.1b")).toEqual(["A1.1b", "COOLTRON", "FA1238B22T7-97", "Axial fan 230VAC", "12", "-FAN.", ""]);
    expect(g.grid.find((r) => r[0] === "A1.1")).toBeUndefined();
  });
  it("move refuses cycles", () => {
    const r = rack();
    const a = r.children[0];
    expect(moveNode([r], a.id, a.children[0].id)).toEqual([r]);
  });
});

describe("compare", () => {
  it("reports purchasing and line changes", () => {
    const a = [rack()];
    const b = [cloneNode(a[0], false)];
    b[0].children[0].children[0].children[0].children[1].qty = 8; // fans 12 → 8
    b[0].children[1].children[0].children.push(partNode(parts[3], 2, { tags: ["PS.01A", "PS.01B"] }));
    const d = diffBom(a, b, ctx);
    expect(d.rollup.find((r) => r.partNumber === "2904602")?.status).toBe("added");
    expect(d.rollup.find((r) => r.partNumber === "FA1238B22T7-97")).toMatchObject({ status: "decreased", a: 12, b: 8, delta: -4 });
    expect(d.lines.filter((l) => l.status !== "same").length).toBe(2);
    expect(d.summary.added).toBe(1);
  });
});

describe("load schedule (RACK.01 drawing set values)", () => {
  it("reproduces the 24VDC bus and the feeder totals", () => {
    const dc = groupNode("DC", { children: [partNode(parts[4], 1, { tags: ["SC.01"] }), partNode(parts[5], 2, { tags: ["MNS.01", "MNS.02"] }), partNode(parts[6], 1, { tags: ["WST.01"] }), partNode(parts[7], 1, { tags: ["TS.01"] })] });
    const unit = groupNode("", { tags: ["RACK.01"], children: [dc] });
    const [sc, sw, ws, ts] = dc.children;
    const bus24: LoadBus = emptyBus({
      id: "b24", title: "LOAD SCHEDULE - EMS ENCLOSURE (RACK.01)", kind: "DC", voltage: 24,
      source: { label: "PS.01/02", ratingW: null, ratingA: 20, efficiency: 0.92 },
      entries: [
        { id: "1", kind: "node", nodeId: sc.id, label: "SITE CONTROLLER", watts: null },
        { id: "2", kind: "node", nodeId: sw.id, label: "FORTISWITCH 424F", watts: null },
        { id: "3", kind: "node", nodeId: ws.id, label: "WORKSTATION", watts: null },
        { id: "4", kind: "node", nodeId: ts.id, label: "TEMP SENSOR", watts: null },
        { id: "5", kind: "loss", label: "REDUNDANCY MODULE LOSS", watts: null, efficiency: 349.2 / 351.2103092783505 },
      ],
    });
    const ac: LoadBus = emptyBus({
      id: "ac", kind: "AC1", voltage: 230,
      entries: [
        { id: "a", kind: "manual", label: "OTHER AC LOADS", watts: 1965.35033617212 - 351.2103092783505 - 30.54002689376959 },
        { id: "b", kind: "bus", busId: "b24", label: "", watts: null },
      ],
    });
    const res = computeLoads([ac, bus24], [unit], ctx);
    const r24 = res.get("b24")!;
    expect(r24.totalW).toBeCloseTo(351.2103, 3);
    expect(r24.amps).toBeCloseTo(14.6338, 3);
    expect(r24.ocpdA).toBeCloseTo(18.2922, 3);
    expect(r24.loadingPct).toBeCloseTo(73.1688, 3);
    const rac = res.get("ac")!;
    expect(rac.rows.find((x) => x.description.startsWith("MAX POWER SUPPLY LOSSES"))!.watts).toBeCloseTo(30.54, 2);
    expect(rac.totalW).toBeCloseTo(1965.3503, 3);
    expect(rac.amps).toBeCloseTo(8.545, 3);
    expect(rac.ocpdA).toBeCloseTo(10.6813, 3);
    expect(loadGrid(bus24, r24).some((r) => r[0] === "FORTISWITCH 424F (-MNS.01, -MNS.02)" && r[1] === "214.2")).toBe(true);
  });
  it("flags circular supply", () => {
    const a = emptyBus({ id: "a", entries: [{ id: "1", kind: "bus", busId: "b", label: "", watts: null }] });
    const b = emptyBus({ id: "b", entries: [{ id: "2", kind: "bus", busId: "a", label: "", watts: null }] });
    const r = computeLoads([a, b], [], ctx);
    expect([...r.values()].some((x) => x.issues.length > 0)).toBe(true);
  });
});

describe("importers", () => {
  const grid = [
    ["EQUIPMENT LIST - RACK.02", "", "", "", "", ""],
    ["No.", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", "QTY", "PREFIX"],
    ["D", "", "", "FRACTAL SITE EQUIPMENT / HARDWARE", "", ""],
    ["D1", "", "", "SERVER RACK", "", ""],
    ["D1.1", "TRIPP LITE", "SR42UB", "19in cabinet", "1", "-RACK.02"],
    ["D1.3a", "RS", "70133260", "Power cable", "2", ""],
    ["D1.3b", "RS", "71581455", "Power cable C13", "4", ""],
    ["E", "", "", "FRACTAL ASSEMBLIES", "", ""],
    ["E1", "FRACTAL", "", "AC ELECTRICAL PROTECTION DEVICES", "1", "-PDU.02"],
    ["E1.2", "PHOENIX CONTACT", "2907595", "MCB", "2", "-MCB."],
  ];
  it("rebuilds the tree from item numbers and keeps the section letters", () => {
    const { unit, parts: found } = parseEquipmentList(grid, { match: partMatcher(parts) });
    expect(unit.tags).toEqual(["RACK.02"]);
    expect(unit.sectionStart).toBe("D");
    const nos = itemNumbers([unit]);
    const lines = explode([unit], ctx);
    expect(lines.filter((l) => !l.line).map((l) => nos.get(l.nodeId))).toEqual(["D", "D1", "D1.1", "D1.2a", "D1.2b", "E", "E1", "E1.1"]);
    expect(lines.find((l) => l.partNumber === "SR42UB")!.partId).toBe("rack");
    expect(lines.find((l) => l.partNumber === "2907595")!.prefix).toBe("MCB.");
    expect(lines.find((l) => l.description.startsWith("AC ELECTRICAL"))!.tags).toEqual(["PDU.02"]);
    expect(found).toHaveLength(4);
  });
  it("infers FNE instances from TOTAL", () => {
    const g = [["EQUIPMENT LIST - FNE"], ["No.", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", "QTY/FNE", "PREFIX", "TOTAL"], ["P", "", "", "HW", "", "", ""], ["P1", "", "", "ENCLOSURE", "", "", ""], ["P1.1", "SAGINAW", "SCE-36EL3616LP", "Enclosure", "1", "", "17"]];
    const { unit } = parseEquipmentList(g);
    expect(unit.qty).toBe(17);
    expect(unit.sectionStart).toBe("P");
    expect(unit.tags).toHaveLength(17);
  });
  it("guesses subcategories", () => {
    const subs: Subcategory[] = ["MCB", "RCBO", "24VDC Power Supply", "Terminal Block", "Terminal Accessory", "Network Switch"].map((n, i) => ({ id: String(i), category: "Electrical", name: n, tagPrefix: "", fields: [], portTypes: [], sort: i }));
    expect(guessSubcategory("RESIDUAL CURRENT BREAKER (RCBO), 10 KA", subs)?.name).toBe("RCBO");
    expect(guessSubcategory("TERMINAL BLOCK PARTITION PLATE, D-XTV 10", subs)?.name).toBe("Terminal Accessory");
    expect(guessSubcategory("QUINT SERIES 100-240VAC OUTPUT 24VDC", subs)?.name).toBe("24VDC Power Supply");
    expect(guessSubcategory("FORTISWITCH 424F", subs)?.name).toBe("Network Switch");
  });
});

describe("importer keeps original numbers", () => {
  it("pins gaps", () => {
    const g = [["EQUIPMENT LIST - RACK.01"], ["No.", "MANUFACTURER", "PART NUMBER", "DESCRIPTION", "QTY", "PREFIX"], ["A", "", "", "HW", "", ""], ["A1", "", "", "RACK", "", ""],
      ["A1.1a", "T", "R1", "rack", "1", ""], ["A1.1b", "C", "F1", "fan", "12", ""], ["A1.3a", "A", "C1", "cable", "24", ""], ["A1.5", "S", "S1", "shelf", "2", ""]];
    const { unit } = parseEquipmentList(g, { keepNumbers: true });
    const nos = itemNumbers([unit]);
    const l = explode([unit]).filter((x) => !x.line).map((x) => nos.get(x.nodeId));
    expect(l).toEqual(["A", "A1", "A1.1a", "A1.1b", "A1.3a", "A1.5"]);
  });
});

describe("tag details", () => {
  it("does not repeat a tag equal to its ancestor's", () => {
    const cab = partNode(parts[0], 1, { tags: ["RACK.01"] });
    const u = groupNode("", { tags: ["RACK.01"], children: [groupNode("A", { children: [cab] })] });
    const hit = findNode([u], cab.id)!;
    expect(fullTagsOf(hit.node, hit.parents)).toEqual(["+RACK.01"]);
    expect(tagIssues([u])).toEqual({});
  });
  it("prefers the type column when guessing", () => {
    const subs: Subcategory[] = ["Firewall", "Network Switch"].map((n, i) => ({ id: String(i), category: "Network", name: n, tagPrefix: "", fields: [], portTypes: [], sort: i }));
    expect(guessSubcategory(["Networking - Rugged Switches (424F)", "FORTISWITCHRUGGED-424F-POE ... FORTIGATE SWITCH CONTROLLER"], subs)?.name).toBe("Network Switch");
    expect(guessSubcategory(["", "FORTIGATE-201G 10 X GE RJ45 (INCLUDING 8 X SWITCH PORTS)"], subs)?.name).toBe("Firewall");
    expect(guessSubcategory(["", "FORTISWITCHRUGGED-424F-POE LAYER 2/3 RUGGEDIZED FORTIGATE SWITCH CONTROLLER"], subs)?.name).toBe("Network Switch");
  });
});
