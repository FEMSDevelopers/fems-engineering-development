import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAMING, bomCtx, cloneNode, computeOverlay, placedByBom, docFileName, emptyPart, equipmentListGrids, groupNode, importUnit, itemNumbers, partDocNames, partNode, walk,
  type Part,
} from "../src/index.js";

const P = (id: string, pn: string, mech: Partial<Part["mech"]> = {}): Part => ({ ...emptyPart(), id, manufacturer: "PHOENIX CONTACT", partNumber: pn, description: pn, mech: { ...emptyPart().mech, ...mech } }) as Part;
const mcb = P("mcb", "2907595", { mount: "din" });
const fw = P("fw", "FG-201G", { mount: "rack", rackUnits: 1 });
const ctx = bomCtx([mcb, fw]);

describe("sub-assemblies", () => {
  it("letter their items at any depth and nest", () => {
    const inner = groupNode("", { line: true, alias: "TB-A", children: [partNode(mcb, 1), partNode(mcb, 1)] });
    const sub = groupNode("", { line: true, alias: "AC DISTRIBUTION", children: [partNode(mcb, 2), inner] });
    const u = groupNode("", { tags: ["RACK.01"], children: [groupNode("SECTION", { children: [groupNode("GROUP", { children: [sub] })] })] });
    const nos = itemNumbers([u]);
    expect([sub, sub.children[0], inner, ...inner.children].map((n) => nos.get(n.id))).toEqual(["A1.1", "A1.1a", "A1.1b", "A1.1b.1", "A1.1b.2"]);
    const g = equipmentListGrids([u], ctx)[0].grid;
    expect(g.find((r) => r[0] === "A1.1")?.[3]).toBe("AC DISTRIBUTION");
    expect(g.find((r) => r[0] === "A1.1b")?.[3]).toBe("TB-A");
  });
});

describe("naming standard", () => {
  it("builds standard names, keeps extensions and avoids duplicates", () => {
    const p = { manufacturer: "Phoenix Contact", partNumber: "2904602", series: "QUINT" };
    expect(docFileName(DEFAULT_NAMING, { kind: "Datasheet", title: "x", fileName: "quint power.PDF" }, p)).toBe("PHOENIX_CONTACT_2904602_DS.pdf");
    expect(docFileName(DEFAULT_NAMING, { kind: "Certificate", title: "c", fileName: "c.pdf", ref: "cert:UL 61010-1", prefix: "A2.3" }, p)).toBe("A2_3_PHOENIX_CONTACT_2904602_CERT_UL_61010_1.pdf");
    const names = partDocNames(DEFAULT_NAMING, [{ kind: "Manual", title: "a", fileName: "a.pdf" }, { kind: "Manual", title: "b", fileName: "b.pdf" }], p);
    expect(names).toEqual(["PHOENIX_CONTACT_2904602_MAN.pdf", "PHOENIX_CONTACT_2904602_MAN_2.pdf"]);
    const custom = { ...DEFAULT_NAMING, case: "asis" as const, sep: "-" as const, rules: [{ kind: "Manual", code: "M", pattern: "{pn}-{code}-{n}" }] };
    expect(partDocNames(custom, [{ kind: "Manual", title: "a", fileName: "a.pdf" }, { kind: "Manual", title: "b", fileName: "b.pdf" }], p)).toEqual(["2904602-M-1.pdf", "2904602-M-2.pdf"]);
  });
});

describe("layout overlay", () => {
  it("imports a BOM unit, shows tags and flags missing / short lines", () => {
    const bom = groupNode("", { tags: ["RACK.01"], children: [groupNode("HW", { children: [partNode(fw, 2, { tags: ["FW.01", "FW.02"] }), partNode(mcb, 4)] })] });
    const lay = importUnit(bom, "rack");
    const fwLine = lay.children[0].children[0];
    expect(fwLine.links).toEqual([bom.children[0].children[0].id]);
    lay.rack!.slots = [{ id: "s", nodeId: fwLine.id, inst: 1, u: 40, h: 1, face: "front", fullDepth: false }];
    let ov = computeOverlay(lay, bom, ctx);
    expect(ov.tags(fwLine.id, 1)).toEqual(["-FW.02"]);
    expect(ov.status.get(fwLine.id)).toBe("short");
    lay.rack!.slots.push({ id: "t", nodeId: fwLine.id, inst: 0, u: 41, h: 1, face: "front", fullDepth: false });
    ov = computeOverlay(lay, bom, ctx);
    expect(ov.status.get(fwLine.id)).toBe("ok");
    // the BOM drops the firewalls → the layout line turns red
    const bom2 = { ...bom, children: [{ ...bom.children[0], children: [bom.children[0].children[1]] }] };
    ov = computeOverlay(lay, bom2, ctx);
    expect(ov.status.get(fwLine.id)).toBe("missing");
    // a BOM line added later shows as not in the layout
    const bom3 = { ...bom, children: [{ ...bom.children[0], children: [...bom.children[0].children, partNode(fw, 1)] }] };
    expect(computeOverlay(lay, bom3, ctx).notInLayout.length).toBe(1);
    let n = 0;
    walk([lay], () => n++);
    expect(n).toBe(4);
    // BOM re-imported (new ids): lines still resolve by master part, and tags still show
    const re = cloneNode(bom);
    ov = computeOverlay(lay, re, ctx);
    expect(ov.status.get(fwLine.id)).toBe("ok");
    expect(ov.tags(fwLine.id, 0)).toEqual(["-FW.01"]);
    // Parts & BOM "Mech" column: placed per BOM line
    expect(placedByBom([{ kind: "rack", unit: lay, ref: null, display: "both" }], bom).get(bom.children[0].children[0].id)).toBe(2);
  });
});

import { DEFAULT_PN_FORMAT, DEFAULT_ASM_DESC, asmDescOf, renderPn, ruleFor, ruleTargetOf, templateToPython } from "../src/index.js";
describe("project part numbers", () => {
  const base = { ...emptyPart(), manufacturer: "PHOENIX CONTACT", partNumber: "2907595", sku: "CB TM1 2C16 P", configCode1: "", configCode2: "", configCode3: "" };
  it("renders templates per subcategory", () => {
    expect(renderPn(ruleFor(DEFAULT_PN_FORMAT, "Fuse"), base, "Fuse").text).toBe("2907595");
    expect(renderPn(ruleFor(DEFAULT_PN_FORMAT, "MCB"), base, "MCB").text).toBe("2907595 (CB TM1 2C16 P)");
    expect(renderPn(ruleFor(DEFAULT_PN_FORMAT, "MCB"), { ...base, sku: "" }, "MCB").text).toBe("2907595");
    expect(renderPn(ruleFor(DEFAULT_PN_FORMAT, "Sensor"), { ...base, partNumber: "MBUS_WTH", configCode1: "RH", configCode3: "LCD" }, "Sensor").text).toBe("MBUS_WTH\nRH\nLCD");
    expect(renderPn(ruleFor(DEFAULT_PN_FORMAT, "Switch"), base, "Switch").text).toBe("2907595");
    const f = { rules: [...DEFAULT_PN_FORMAT.rules, { subcategory: "MCCB", manufacturer: "Siemens", series: "3VA", mode: "template" as const, expr: "3VA {General.PartNumber}" }, { subcategory: "MCCB", manufacturer: "Siemens", mode: "template" as const, expr: "SIE {General.PartNumber}" }] };
    expect(ruleFor(f, "MCCB", "SIEMENS", "3va")?.expr).toBe("3VA {General.PartNumber}");
    expect(ruleFor(f, "MCCB", "Siemens", "FXD")?.expr).toBe("SIE {General.PartNumber}");
    expect(ruleFor(f, "MCCB", "ABB", "Tmax")?.subcategory).toBe("*");
    // Python criteria beats every other scope, only when true.
    const g = { rules: [...DEFAULT_PN_FORMAT.rules, { subcategory: "*", when: 'Spec["poles"] == 3', mode: "python" as const, expr: 'f"{pn}-3P"' }] };
    const b3 = { ...base, custom: { poles: 3 } };
    expect(renderPn(ruleFor(g, ruleTargetOf(b3, "MCB")), b3, "MCB").text).toBe("2907595-3P");
    expect(renderPn(ruleFor(g, ruleTargetOf(base, "MCB")), base, "MCB").text).toBe("2907595 (CB TM1 2C16 P)");
    // Legacy templates convert to equivalent Python.
    for (const [tpl, p] of [["{General.PartNumber} ({SKU})", base], ["{General.PartNumber} ({SKU})", { ...base, sku: "" }], ["{General.PartNumber} /nl {General.ConfigCode1} /nl {General.ConfigCode2} /nl {General.ConfigCode3}", { ...base, configCode1: "RH", configCode3: "LCD" }]] as const) {
      const legacy = renderPn({ subcategory: "*", mode: "template", expr: tpl }, p, "").text;
      expect(renderPn({ subcategory: "*", mode: "python", expr: templateToPython(tpl) }, p, "").text).toBe(legacy);
    }
    // Manufacturer aliases: mfr_alias in rules, {mfra} in file names; description left/right.
    const ctx = { aliases: { "phoenix contact": "PXC" } };
    expect(asmDescOf(DEFAULT_ASM_DESC, base, "MCB", ctx)).toEqual({ left: "PXC\n2907595", right: "" });
    expect(docFileName(DEFAULT_NAMING, { kind: "Datasheet", title: "x", fileName: "a.pdf", suffix: "rev b" }, { manufacturer: "Phoenix Contact", partNumber: "2907595", mfrAlias: "PXC" })).toBe("PHOENIX_CONTACT_2907595_DS_REV_B.pdf");
    expect(renderPn({ subcategory: "MCB", mode: "template", expr: "{General.PartNumber} {Spec.tripCurve}{Spec.ratedCurrent}A" }, { ...base, custom: { tripCurve: "C", ratedCurrent: 16 } }).text).toBe("2907595 C16A");
  });
  it("runs Python expressions and code", () => {
    expect(renderPn({ subcategory: "*", mode: "python", expr: 'f"{pn} ({sku})" if sku else pn' }, base).text).toBe("2907595 (CB TM1 2C16 P)");
    expect(renderPn({ subcategory: "*", mode: "python", expr: 'parts = [pn, Spec.poles + "P"]\nreturn "-".join(parts)' }, { ...base, custom: { poles: "2" } }).text).toBe("2907595-2P");
    const bad = renderPn({ subcategory: "*", mode: "python", expr: "pn +" }, base);
    expect(bad.text).toBe("2907595");
    expect(bad.error).toBeTruthy();
  });
});

describe("device tag pin", () => {
  it("lists BOM lines of the same part and shows the pinned tag", () => {
    const fw = { ...emptyPart(), id: "fw", manufacturer: "FORTINET", partNumber: "FG-201G", description: "", mech: { ...emptyPart().mech, mount: "rack" as const, rackUnits: 1 } } as Part;
    const c = bomCtx([fw]);
    const a = partNode(fw, 1, { tags: ["FW.01"] });
    const b = partNode(fw, 1, { tags: ["FW.02"] });
    const bom = groupNode("", { tags: ["RACK.01"], children: [groupNode("A", { children: [a] }), groupNode("B", { children: [b] })] });
    const lay = importUnit(bom, "rack");
    const line = lay.children[0].children[0];
    const ov = computeOverlay(lay, bom, c);
    expect(ov.choices(line.id).map((x) => x.tags[0])).toEqual(["FW.01", "FW.02"]);
    expect(ov.tags(line.id, 0)).toEqual(["-FW.01"]);
    expect(ov.tags(line.id, 0, { id: b.id, inst: 0 })).toEqual(["-FW.02"]);
  });
});

describe("device IDs from Mechanical Design", () => {
  it("joins BOM prefixes and numbers, suggests numbers, finds duplicates", async () => {
    const { deviceTag, nextNumbers, deviceIds, tagsByBom, tagPrefixOf } = await import("../src/index.js");
    expect(deviceTag("SRV.", "01")).toBe("SRV.01");
    expect(deviceTag("SRV", ".01A")).toBe("SRV.01A");
    expect(deviceTag("", "01")).toBe("01");
    expect(nextNumbers(["01", "02"], 2)).toEqual(["03", "04", "03A", "03B"]);
    expect(nextNumbers(["01A"], 1)).toEqual(["02", "01B", "01C"]);
    expect(tagPrefixOf({ ...partNode(mcb, 1), noPrefix: true }, { ...mcb, tagPrefix: "MCB." })).toBe("");
    const unit = groupNode("", { tags: ["RACK.01"], rack: { totalU: 42, depthMm: null, cabinetNodeId: null, slots: [
      { id: "a", nodeId: "x", inst: 0, u: 1, h: 1, face: "front", fullDepth: false, dev: { bomId: "b1", num: "02" } },
      { id: "b", nodeId: "x", inst: 1, u: 2, h: 1, face: "front", fullDepth: false, dev: { bomId: "b1", num: "01" } },
    ] } });
    const fneUnit = groupNode("", { fne: { items: [{ id: "c", nodeId: "y", inst: 0, x: 0, y: 0, dev: { bomId: "b1", num: "01" } }] } as never });
    const e = deviceIds([{ name: "RACK", doc: { kind: "rack", unit, ref: null, display: "both" } }, { name: "FNE", doc: { kind: "fne", unit: fneUnit, ref: null, display: "both" } }], () => "SRV.");
    const r = tagsByBom(e);
    expect(r.tags.get("b1")).toEqual(["SRV.01", "SRV.02"]);
    expect([...r.dupes]).toEqual(["SRV.01"]);
  });
});

describe("device IDs per linked item", () => {
  it("keeps one device ID per link, with an optional prefix override", async () => {
    const { deviceIds, linkCounts } = await import("../src/index.js");
    const unit = groupNode("", { tags: ["RACK.01"], rack: { totalU: 42, depthMm: null, cabinetNodeId: null, slots: [
      { id: "a", nodeId: "g", inst: 0, u: 1, h: 2, face: "front", fullDepth: false, devs: [{ bomId: "p1", num: "01" }, { bomId: "p2", num: "01", prefix: "PS" }] },
    ] } });
    unit.children = [groupNode("ASM", { links: ["grp", "p1"] }), groupNode("COPY", { links: ["grp"] })];
    unit.rack!.slots[0].nodeId = unit.children[0].id;
    const e = deviceIds([{ name: "R", doc: { kind: "rack", unit, ref: null, display: "both" } }], (id) => (id === "p1" ? "MCB." : "XX."));
    expect(e.map((x) => x.tag)).toEqual(["MCB.01", "PS.01"]);
    expect(linkCounts([{ kind: "rack", unit, ref: null, display: "both" }]).get("grp")).toBe(1);
  });
});

describe("naming: prefix / suffix are never lost", () => {
  it("adds them when the pattern has no placeholder, and project-level before / after", () => {
    const std = { ...DEFAULT_NAMING, rules: [{ kind: "Datasheet", code: "DS", pattern: "{mfr}_{PN}_{code}" }] };
    const p = { manufacturer: "Phoenix Contact", partNumber: "2904602" };
    expect(docFileName(std, { kind: "Datasheet", title: "x", fileName: "a.pdf", prefix: "SUB-12", suffix: "rev b" }, p)).toBe("SUB_12_PHOENIX_CONTACT_2904602_DS_REV_B.pdf");
    expect(docFileName(std, { kind: "Datasheet", title: "x", fileName: "a.pdf" }, p, { before: "LIB", after: "A2.1" })).toBe("LIB_PHOENIX_CONTACT_2904602_DS_A2.1.pdf");
  });
});

describe("output sort order", () => {
  it("sorts by a python key, tuples element-wise, item numbers naturally", async () => {
    const { sortRows } = await import("../src/index.js");
    const rows = [
      { pn: "B", mfr: "Z", items: ["A10"], total: 1 },
      { pn: "A", mfr: "Z", items: ["A2"], total: 5 },
      { pn: "C", mfr: "Y", items: ["A2.1"], total: 2 },
    ];
    const to = (r: (typeof rows)[number]) => ({ part: null, sub: "", partNumber: r.pn, manufacturer: r.mfr, items: r.items, units: [], total: r.total });
    expect(sortRows(rows, { key: "(mfr, pn)", descending: false }, to).rows.map((r) => r.pn)).toEqual(["C", "A", "B"]);
    expect(sortRows(rows, { key: "item", descending: false }, to).rows.map((r) => r.pn)).toEqual(["A", "C", "B"]);
    expect(sortRows(rows, { key: "total", descending: true }, to).rows.map((r) => r.pn)).toEqual(["A", "C", "B"]);
    expect(sortRows(rows, { key: "nope", descending: false }, to).error).toBeTruthy();
  });
});

import { docFileName as dfn, DEFAULT_NAMING as DN } from "../src/naming";
describe("naming {year}", () => {
  const std = { ...DN, rules: DN.rules.map((r) => (r.kind === "Datasheet" ? { ...r, pattern: "{mfr}_{pn}_{code}_{year}" } : r)) };
  it("puts the year published, and leaves no separator when it is missing", () => {
    expect(dfn(std, { kind: "Datasheet", title: "x", fileName: "a.pdf", year: 2023 }, { manufacturer: "Phoenix Contact", partNumber: "2904602" })).toBe("PHOENIX_CONTACT_2904602_DS_2023.pdf");
    expect(dfn(std, { kind: "Datasheet", title: "x", fileName: "a.pdf" }, { manufacturer: "Phoenix Contact", partNumber: "2904602" })).toBe("PHOENIX_CONTACT_2904602_DS.pdf");
  });
});
