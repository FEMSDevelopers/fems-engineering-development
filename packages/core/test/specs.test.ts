import { describe, expect, it } from "vitest";
import { DEFAULT_SUBCATEGORIES, EXTRA_SUBCATEGORIES, SPEC_TEMPLATES, fillSpecs, mergeSpecFields, specSummary, specText, suggestSpecs } from "../src/index.js";

const T = SPEC_TEMPLATES;
describe("spec templates", () => {
  it("covers every default subcategory, with unique keys and certificate fields for electrical devices", () => {
    for (const [, name] of [...DEFAULT_SUBCATEGORIES, ...EXTRA_SUBCATEGORIES]) {
      expect(T[name], name).toBeDefined();
      const keys = T[name].map((f) => f.key);
      expect(new Set(keys).size, name).toBe(keys.length);
    }
    for (const n of ["MCB", "RCBO", "Fuse", "24VDC Power Supply", "Terminal Block", "Surge Protection Device"]) expect(T[n].some((f) => f.type === "certs")).toBe(true);
    expect(T.MCB.find((f) => f.key === "protection")!.options).toContain("UL 1077 supplementary protector");
    expect(T["24VDC Power Supply"].map((f) => f.key)).toEqual(expect.arrayContaining(["inputPhases", "inputRangeAc", "inputType", "outputRange", "outputType", "outputCurrent", "efficiency"]));
  });
  it("merges a template into existing fields without overwriting", () => {
    const m = mergeSpecFields([{ key: "poles", label: "My poles", type: "text" }], T.MCB);
    expect(m[0].label).toBe("My poles");
    expect(m.length).toBe(T.MCB.length);
  });
});

describe("suggestions from descriptions", () => {
  it("reads breakers, RCBOs and fuses", () => {
    expect(suggestSpecs(T.MCB, "CIRCUIT BREAKER, MINIATURE, 2 POLE, C CURVE, 16A, 120(277)VAC, 10KA")).toMatchObject({ poles: "2", tripCurve: "C", ratedCurrent: 16, ratedVoltageAc: 277, interrupting: 10 });
    expect(suggestSpecs(T.RCBO, "RESIDUAL CURRENT BREAKER (RCBO), 10 KA, 1P+N, TYPE A, 30 mA, C-CHAR, IN: 16 A, UN AC: 230 V")).toMatchObject({ poles: "1+N", rcdType: "A", residual: "30", tripCurve: "C", ratedCurrent: 16, ratedVoltageAc: 230, interrupting: 10 });
    expect(suggestSpecs(T.Fuse, "FUSE 20A, CLASS CC. ATMR SERIES, FAST ACTING")).toMatchObject({ ratedCurrent: 20, fuseClass: "CC", speed: "Fast-acting" });
  });
  it("reads power supplies and redundancy modules", () => {
    expect(suggestSpecs(T["24VDC Power Supply"], "QUINT SERIES 100-240VAC. 50/ 60 HZ. OUTPUT 24-28 VDC 480W. OPER. TEMP. -25C TO 70C")).toMatchObject({
      inputRangeAc: [100, 240], inputType: "AC", outputRange: [24, 28], outputVoltage: 24, outputType: "DC", outputPower: 480, tempOper: [-25, 70],
    });
    expect(suggestSpecs(T["24VDC Redundancy Module"], "REDUNDANCY MODULE, ACTIVE, AUTO CURRENT BALANCING, 24VDC, 2X 20A IN, 2X20A OUT")).toMatchObject({ technology: "Active (MOSFET)", inputs: 2, inputCurrent: 20, outputCurrent: 40, loadBalancing: true });
  });
  it("reads network and cabling parts without guessing what is not written", () => {
    expect(suggestSpecs(T["SFP Transceiver"], "1GE SFP LX TRANSCEIVER MODULE, -40C TO 85C, SMF, 10KM DUPLEX LC")).toMatchObject({ rate: "1 Gbps", standard: "1000BASE-LX", fiber: "Single-mode (SMF)", reach: 10, tempOper: [-40, 85] });
    expect(suggestSpecs(T["Patch Cable"], "1FT CAT6 GIGABIT SNAGLESS MOLDED PATCH CABLE, RJ45 M/M, BLUE")).toMatchObject({ medium: "Copper Cat6", length: 0.3 });
    expect(suggestSpecs(T["Network Switch"], "FORTISWITCHRUGGED-112F-POE LAYER 2 RUGGEDIZED SWITCH WITH 8 X GE RJ45 PORTS").poe).toBeUndefined();
    expect(suggestSpecs(T.MCB, "SPARE PARTS KIT")).toEqual({});
  });
  it("fills only empty values and formats them", () => {
    const r = fillSpecs({ custom: { tripCurve: "D" }, description: "CIRCUIT BREAKER, 1 POLE, C CURVE, 6A", partNumber: "x" }, T.MCB);
    expect(r.custom.tripCurve).toBe("D");
    expect(r.filled).toEqual(expect.arrayContaining(["poles", "ratedCurrent"]));
    expect(specText(T["24VDC Power Supply"].find((f) => f.key === "inputRangeAc")!, [100, 240])).toBe("100–240 VAC");
    expect(specSummary({ custom: r.custom }, T.MCB)).toBe("1 · D · 6 A");
  });
});
