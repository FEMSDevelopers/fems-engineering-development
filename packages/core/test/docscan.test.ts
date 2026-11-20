import { describe, expect, it } from "vitest";
import { buildCodeIndex, matchDocFile, nameContains, nameResembles, normExts, wildcardToRegExp, DEFAULT_DOC_PREFIXES as P, DEFAULT_DOC_WORDS as WD } from "../src/docscan";

const parts = [
  { id: "a", partNumber: "5SY4110-7" },
  { id: "b", partNumber: "S201-C2" },
  { id: "c", partNumber: "S201-C20" },
  { id: "d", partNumber: "2907595", sku: "QUINT4-PS/1AC/24DC/10" },
  { id: "e", partNumber: "A1" },
];
const ix = buildCodeIndex(parts);
const m = (f: string) => matchDocFile(f, ix, P);

describe("document folder scan", () => {
  it("classifies by the file-name prefix; unknown or no prefix → Other", () => {
    expect(m("DS_5SY4110-7.pdf")).toMatchObject({ partIds: ["a"], prefix: "DS", kind: "Datasheet" });
    expect(m("ig-2907595 rev B.PDF")).toMatchObject({ partIds: ["d"], prefix: "ig", kind: "Installation guide" });
    expect(m("SS 2907595.pdf")).toMatchObject({ kind: "Specification sheet" });
    expect(m("DS5SY4110-7.pdf")).toMatchObject({ prefix: "DS", kind: "Datasheet" });
    expect(m("UM_2907595.pdf")).toMatchObject({ prefix: "UM", kind: "Other" });
    expect(m("2907595.pdf")).toMatchObject({ prefix: "", kind: "Other" });
    expect(m("2907595_DS.pdf")).toMatchObject({ prefix: "", kind: "Other" });
  });
  it("matches part numbers with any separators, never inside a longer code", () => {
    expect(m("DS_5SY4110_7.pdf")?.partIds).toEqual(["a"]);
    expect(m("DS_5sy41107.pdf")?.partIds).toEqual(["a"]);
    expect(m("DS_S201-C20.pdf")?.partIds).toEqual(["c"]);
    expect(m("DS_S201-C2.pdf")?.partIds).toEqual(["b"]);
    expect(m("DS_S201-C2_S201-C20 family.pdf")?.partIds).toEqual(["b", "c"]);
    expect(m("DS_29075950.pdf")).toBeNull();
    expect(m("readme A1.pdf")).toBeNull();
  });
  it("can also search SKUs", () => {
    expect(m("DS_QUINT4-PS_1AC_24DC_10.pdf")).toBeNull();
    expect(matchDocFile("DS_QUINT4-PS_1AC_24DC_10.pdf", buildCodeIndex(parts, true), P)?.partIds).toEqual(["d"]);
  });
  it("normalises extensions", () => {
    expect(normExts("PDF, .docx ;x/y")).toEqual(["pdf", "docx"]);
  });
});

describe("Librillo submittal-sheet names (TYPE_partline_PN)", () => {
  const files = ["RACK01/DS_1.5a_1329608.pdf", "RACK01/DS_2.3a_2.3b_ATMR5_ATMR20.pdf", "RACK01/DS_2.4A_3211797.pdf", "RACK01/DS_A1.1a_SR42UBEIS.pdf",
    "RACK01/DS_A1.1b_FA1238B22T7-97.pdf", "RACK01/DS_A2.10_2488.pdf", "RACK01/DS_A2.8b_AP-LC6-LDSM-B.pdf", "RACK01/DS_B1.2a_2907595.pdf",
    "RACK01/DS_B1.2b_5SU13547KK16.pdf", "RACK01/IG_B1.1a.pdf", "RACK01/SS_A2.1_R650.pdf", "RACK01/DS_B4.2a_P2225H.pdf"];
  const ps = [
    { id: "quint", partNumber: "2907595" }, { id: "atmr5", partNumber: "ATMR5" }, { id: "atmr20", partNumber: "ATMR 20" },
    { id: "rack", partNumber: "SR42UBEIS" }, { id: "fan", partNumber: "FA1238B22T7-97" }, { id: "rcbo", partNumber: "5SU1354-7KK16" },
    { id: "r650", partNumber: "R650" }, { id: "ap", partNumber: "AP-LC6-LDSM-B" }, { id: "2488", partNumber: "2488" }, { id: "mon", partNumber: "P2225H" },
    { id: "x", partNumber: "1329608" }, { id: "y", partNumber: "3211797" },
  ];
  const ix2 = buildCodeIndex(ps);
  const r = (f: string) => matchDocFile(f, ix2, P);
  it("ignores the part line and files by the leading type", () => {
    expect(r(files[0])).toMatchObject({ partIds: ["x"], prefix: "DS", kind: "Datasheet" });
    expect(r(files[1])).toMatchObject({ partIds: ["atmr5", "atmr20"], kind: "Datasheet" });
    expect(r(files[2])?.partIds).toEqual(["y"]);
    expect(r(files[3])?.partIds).toEqual(["rack"]);
    expect(r(files[4])?.partIds).toEqual(["fan"]);
    expect(r(files[5])?.partIds).toEqual(["2488"]);
    expect(r(files[6])?.partIds).toEqual(["ap"]);
    expect(r(files[7])?.partIds).toEqual(["quint"]);
    expect(r(files[8])?.partIds).toEqual(["rcbo"]);
    expect(r(files[9])).toBeNull();
    expect(r(files[10])).toMatchObject({ partIds: ["r650"], kind: "Specification sheet" });
    expect(r(files[11])?.partIds).toEqual(["mon"]);
  });
});

describe("Spec Sheets folder names (part lines, Mfr, PN, Desc, word suffixes)", () => {
  const ps = [{ id: "rack", partNumber: "SR42UB" }, { id: "cap", partNumber: "1206560" }, { id: "fuse", partNumber: "ATMR1" }, { id: "shelf", partNumber: "SHELF-1U-20-FIXED-S" },
    { id: "sce", partNumber: "SCE-24P24" }, { id: "q", partNumber: "1329608" }, { id: "tr", partNumber: "FN-TRAN-LX" }];
  const ix3 = buildCodeIndex(ps);
  it("leaves part lines out of the prefix; unknown → Other unless a word is recognised", () => {
    expect(matchDocFile("A1.1_SR42UB-DataSheet.pdf", ix3, P)).toMatchObject({ partIds: ["rack"], prefix: "", kind: "Other" });
    expect(matchDocFile("A1.1_SR42UB-DataSheet.pdf", ix3, P, WD)).toMatchObject({ kind: "Datasheet", by: "word" });
    expect(matchDocFile("Q1.3a_1329608-SpecSheet.pdf", ix3, P, WD)).toMatchObject({ partIds: ["q"], prefix: "", kind: "Specification sheet" });
    expect(matchDocFile("A1.4_SHELF-1U-20-FIXED-S-SpecSheet.pdf", ix3, P, WD)).toMatchObject({ partIds: ["shelf"], kind: "Specification sheet" });
    expect(matchDocFile("SCE-24P24_cutsheet.pdf", ix3, P, WD)).toMatchObject({ partIds: ["sce"], kind: "Specification sheet" });
    expect(matchDocFile("Phoenix Contact, 1206560, Din Rail End Cap.pdf", ix3, P, WD)).toMatchObject({ partIds: ["cap"], prefix: "Phoenix", kind: "Other", by: "" });
    expect(matchDocFile("Mersen, ATMR1, Class CC Fuse.pdf", ix3, P, WD)).toMatchObject({ partIds: ["fuse"], kind: "Other" });
    expect(matchDocFile("A2.6_FN-TRAN-LX-Fortinet_Transceivers.pdf", ix3, P, WD)).toMatchObject({ partIds: ["tr"], prefix: "", kind: "Other" });
    expect(matchDocFile("DS_A1.1_SR42UB-SpecSheet.pdf", ix3, P, WD)).toMatchObject({ kind: "Datasheet", by: "prefix" });
  });
});

describe("prefix table: contains text with wildcards (glob)", () => {
  it("translates glob syntax", () => {
    expect(nameContains("A1.1_SR42UB-SpecSheet.pdf", "spec*sheet")).toBe(true);
    expect(nameContains("A1.1_SR42UB-Spec_Sheet.pdf", "spec?sheet")).toBe(true);
    expect(nameContains("A1.1_SR42UB-SpecSheet.pdf", "spec?sheet")).toBe(false);
    expect(nameContains("Manual_R2.pdf", "_r[0-9]")).toBe(true);
    expect(nameContains("Manual_RA.pdf", "_r[!0-9]")).toBe(true);
    expect(nameContains("x.docx", "*.docx")).toBe(true);
    expect(nameContains("a+b (1).pdf", "+b (1)")).toBe(true);
    expect(nameContains("star*file.pdf", "star\\*file")).toBe(true);
    expect(nameContains("starXfile.pdf", "star\\*file")).toBe(false);
    expect(wildcardToRegExp("abc", true)?.test("xabc")).toBe(false);
    expect(nameContains("anything", "")).toBe(true);
  });
  const ix4 = buildCodeIndex([{ id: "q", partNumber: "2907595" }, { id: "r", partNumber: "SR42UB" }]);
  const rules = [
    { prefix: "DS", contains: "*IOM*", kind: "Manual" },
    { prefix: "DS", kind: "Datasheet" },
    { prefix: "", contains: "spec*sheet", kind: "Specification sheet" },
    { prefix: "", contains: "*install*", kind: "Installation guide" },
  ];
  it("first row whose prefix and contains both match wins; rows with only contains apply to any prefix", () => {
    expect(matchDocFile("DS_2907595_IOM.pdf", ix4, rules)).toMatchObject({ kind: "Manual", by: "prefix" });
    expect(matchDocFile("DS_2907595.pdf", ix4, rules)).toMatchObject({ kind: "Datasheet", by: "prefix" });
    expect(matchDocFile("A1.1_SR42UB-SpecSheet.pdf", ix4, rules)).toMatchObject({ kind: "Specification sheet", by: "contains", prefix: "" });
    expect(matchDocFile("Phoenix Contact, 2907595, Installation.pdf", ix4, rules)).toMatchObject({ kind: "Installation guide", by: "contains" });
    expect(matchDocFile("UM_2907595.pdf", ix4, rules)).toMatchObject({ kind: "Other", by: "" });
    expect(matchDocFile("DS2907595.pdf", ix4, rules)).toMatchObject({ kind: "Datasheet", prefix: "DS" });
  });
});

describe("nameResembles", () => {
  it("matches the part number or SKU in any punctuation", () => {
    expect(nameResembles("AP7552_3D model.zip", ["AP7552", ""])).toBe(true);
    expect(nameResembles("ap-7552.STEP", ["AP7552"])).toBe(true);
    expect(nameResembles("AP7552.stp", ["AP7552-01"])).toBe(true);
    expect(nameResembles("6EP3436-8SB00.zip", ["6EP3436-8SB00-0AY0"])).toBe(true);
    expect(nameResembles("model.zip", ["XYZ", "6EP3436-8SB00-0AY0"])).toBe(false);
    expect(nameResembles("2907595.stp", ["", "QUINT4-PS/1AC/24DC/10"])).toBe(false);
    expect(nameResembles("QUINT4-PS_1AC_24DC_10.stp", ["2904601", "QUINT4-PS/1AC/24DC/10"])).toBe(true);
    expect(nameResembles("CAD.zip", [null, undefined, ""])).toBe(false);
  });
});
