import { describe, expect, it } from "vitest";
import { extractPartData, htmlToText } from "../src/index.js";

describe("OEM page scraping", () => {
  const html = `<html><head><title>QUINT4-PS/1AC/24DC/10 - 2904601 | Phoenix Contact</title>
  <script type="application/ld+json">{"@type":"Product","name":"Power supply unit","description":"Primary-switched power supply, 1-phase, output 24 V DC / 10 A","sku":"2904601","brand":{"name":"Phoenix Contact"}}</script></head>
  <body><table><tr><th>Product family</th><td>QUINT POWER</td></tr><tr><td>Input voltage range</td><td>100 V AC ... 240 V AC</td></tr>
  <tr><td>Dimensions (W x H x D)</td><td>50 x 130 x 125 mm</td></tr><tr><td>Weight</td><td>1.2 kg</td></tr><tr><td>Mounting type</td><td>DIN rail mounting</td></tr>
  <tr><td>Power consumption</td><td>max. 260 W</td></tr></table></body></html>`;
  it("reads general, mechanical and power values", () => {
    const pg = htmlToText(html);
    const hits = extractPartData(pg, { partNumber: "2904601", manufacturer: "", description: "", series: "" });
    const v = Object.fromEntries(hits.map((h) => [`${h.target.kind}.${h.target.key}`, h.value]));
    expect(v["part.series"]).toBe("QUINT POWER");
    expect(v["part.manufacturer"]).toBe("Phoenix Contact");
    expect(v["mech.widthMm"]).toBe(50);
    expect(v["mech.depthMm"]).toBe(125);
    expect(v["mech.weightKg"]).toBe(1.2);
    expect(v["mech.mount"]).toBe("din");
    expect(v["powerIn.kind"]).toBe("AC1");
    expect(v["powerIn.voltage"]).toBe(120);
    expect(v["powerIn.watts"]).toBe(260);
    expect(v["part.sku"]).toBeUndefined();
  });
  it("converts inches", () => {
    const hits = extractPartData({ title: "", text: "Dimensions: 17.3 x 1.73 x 12 in", product: {} }, { partNumber: "X", manufacturer: "", description: "", series: "" });
    expect(hits.find((h) => h.target.key === "widthMm")?.value).toBe(439.4);
  });
});

import { catalogRowText, findCatalogRows } from "../src/index.js";
describe("catalog / flyer rows", () => {
  it("finds the part's row, pairs it with the header and reads the long text", () => {
    const text = [
      "QUINT POWER family",
      "Order No.: Type | Input voltage range | Output current | Width | Weight",
      "2904600: QUINT4-PS/1AC/24DC/5 | 100 V AC ... 240 V AC | 5 A | 32 mm | 0.6 kg",
      "2904601: QUINT4-PS/1AC/24DC/10 | 100 V AC ... 240 V AC | 10 A | 50 mm | 1.2 kg",
      "2904602: QUINT4-PS/1AC/24DC/20 | 100 V AC ... 240 V AC | 20 A | 70 mm | 2.1 kg",
      "Notes: Primary-switched power supply with SFB technology, DIN rail mounting, Class 2 per UL 1310",
    ].join("\n");
    const rows = findCatalogRows(text, "2904601");
    expect(rows.length).toBe(1);
    expect(rows[0].headers?.[0]).toBe("Order No.");
    const pg = catalogRowText(rows[0]);
    const hits = extractPartData(pg, { partNumber: "2904601", manufacturer: "", description: "", series: "" });
    const v = Object.fromEntries(hits.map((h) => [`${h.target.kind}.${h.target.key}`, h.value]));
    expect(v["mech.widthMm"]).toBe(50);
    expect(v["mech.weightKg"]).toBe(1.2);
    expect(v["powerIn.range"]).toContain("100");
  });
  it("uses a long description cell", () => {
    const rows = findCatalogRows("AB-123: Compact 24 V DC power supply, 2.5 A, DIN rail mounting, input 100-240 V AC, width 22.5 mm", "AB123");
    const pg = catalogRowText(rows[0]);
    expect(pg.product.oemDesc).toContain("Compact 24 V DC");
    expect(extractPartData(pg, { partNumber: "AB-123", manufacturer: "", description: "", series: "" }).some((h) => h.target.key === "mount")).toBe(true);
  });
});

import { retarget, scrapeTargets } from "../src/index.js";
describe("OEM desc and retargeting", () => {
  it("sends long text to OEM desc, the type column to Description, and converts retargeted values", () => {
    const text = ["Order No.: Type | Description", "AB-123: PS-24V-2.5A | Compact 24 V DC power supply for control cabinets, 2.5 A output current, DIN rail mounting, wide-range input 100-240 V AC, slim 22.5 mm housing"].join("\n");
    const pg = catalogRowText(findCatalogRows(text, "AB-123")[0]);
    const hits = extractPartData(pg, { partNumber: "AB-123", manufacturer: "", description: "", series: "" });
    const by = Object.fromEntries(hits.map((h) => [`${h.target.kind}.${h.target.key}`, h.value]));
    expect(String(by["part.oemDesc"])).toContain("Compact 24 V DC");
    expect(by["part.description"]).toBe("PS-24V-2.5A");
    const w = retarget({ target: { kind: "part", key: "notes" }, label: "Notes", value: "22.5 mm", from: "" }, { kind: "mech", key: "dinWidthMm" });
    expect(w.value).toBe(22.5);
    expect(w.label).toBe("DIN width (mm)");
    expect(scrapeTargets().some((t) => t.target.key === "oemDesc")).toBe(true);
  });
});
