import { describe, expect, it } from "vitest";
import { certLinksFromPdf, certTitle, extractTemps, type PdfPageData } from "../src/index";

// A datasheet approvals grid (positions as pdf.js gives them: y from the bottom), split over two pages.
const H = 842;
const tx = (s: string, x: number, top: number, w = s.length * 3.8) => ({ s, x, y: H - top, w });
const link = (id: string, x: number, top: number, w = 72, h = 9) => ({ url: `https://example.com/search?EntryTypes=Certificate&CertificateId=${id}`, rect: [x, H - top - h, x + w, H - top] });
const pages: PdfPageData[] = [
  {
    h: H,
    items: [tx("Approvals Certificates", 44, 674), tx("Environment", 51, 688), tx("General Product Approval", 220, 688), tx("Environmental Con-", 53, 710), tx("firmations", 70, 719), tx("Miscellaneous", 485, 710), tx("General Product Approval", 51, 776), tx("EMV", 390, 776), tx("Test Certificates", 474, 776), tx("Page 1/2", 45, 822)],
    links: [link("e1", 53, 710), link("e1", 70, 719, 30), link("g1", 236, 709, 38, 30), link("g2", 485, 710), { url: "https://example.com/catalog", rect: [50, 300, 200, 310] }],
  },
  {
    h: H,
    items: [tx("Confirmation", 149, 56), tx("Test Certificates", 51, 122), tx("Maritime application", 136, 122), tx("other", 230, 122), tx("Special Test Certific-", 51, 144), tx("ate", 81, 152), tx("Railway", 51, 210), tx("Dangerous goods", 220, 210), tx("Transport Information", 219, 232)],
    links: [link("p1", 149, 56), link("emv", 405, 55, 38, 30), link("t1", 51, 144, 90), link("t1", 81, 152, 20), link("m1", 152, 143, 38, 30), link("dg", 219, 232, 90)],
  },
];

describe("certLinksFromPdf", () => {
  it("files each linked cell under the heading above its column, across pages", () => {
    const l = certLinksFromPdf(pages);
    expect(l.map((c) => [c.type, c.label || "logo"])).toEqual([
      ["Environment", "Environmental Confirmations"],
      ["General product approval", "logo"],
      ["General product approval", "Miscellaneous"],
      ["General product approval", "Confirmation"],
      ["Other", "logo"],
      ["Test Certificates", "Special Test Certificate"],
      ["Maritime application", "logo"],
      ["Dangerous goods", "Transport Information"],
    ]);
    expect(l.find((c) => c.url.endsWith("emv"))!.heading).toBe("EMV");
    expect(certTitle(l.find((c) => c.url.endsWith("emv"))!)).toBe("EMV · Other certificate (logo)");
    expect(l.some((c) => c.url.endsWith("catalog"))).toBe(false);
  });
  it("uses the defined types (renamed / added ones too)", () => {
    const l = certLinksFromPdf(pages, ["Environment", "General product approval", "EMV", "Other"]);
    expect(l.find((c) => c.url.endsWith("emv"))!.type).toBe("EMV");
  });
});

describe("extractTemps", () => {
  it("reads one-line ranges and heading + minimum / maximum lines (°F converted)", () => {
    expect(extractTemps(["ambient temperature during operation", "● minimum: -25 °C", "● maximum: 55 °C", "ambient temperature during storage", "● minimum: -40 °C", "● maximum: 75 °C"])).toEqual({
      oper: { v: [-25, 55], line: "ambient temperature during operation · ● minimum: -25 °C · ● maximum: 55 °C" },
      storage: { v: [-40, 75], line: "ambient temperature during storage · ● minimum: -40 °C · ● maximum: 75 °C" },
    });
    expect(extractTemps(["Operating temperature: -25 ... +55 °C"]).oper?.v).toEqual([-25, 55]);
    expect(extractTemps(["Storage temperature -40 to 75 °C"]).storage?.v).toEqual([-40, 75]);
    expect(extractTemps(["Ambient temperature (operation): 14 °F to 131 °F"]).oper?.v).toEqual([-10, 55]);
    expect(extractTemps(["Rated voltage 230 V", "maximum: 2.8 W"])).toEqual({ oper: null, storage: null });
  });
});

import { approvalIdOf, certFields } from "../src/certs.js";
describe("certificate fields from a datasheet", () => {
  it("name, title, approval id", () => {
    const f = certFields({ label: "Environmental Confirmations", heading: "Environment", type: "Environment", url: "https://x/search?CertificateId=498" });
    expect(f).toEqual({ certName: "Environmental Confirmations", title: "Environment", approvalId: "" });
    expect(certFields({ label: "", heading: "", type: "Railway", url: "https://x" }, 2).certName).toBe("Railway certificate (logo) 2");
  });
  it("approval ids", () => {
    expect(approvalIdOf("https://productiq.ulprospector.com/en/profile?e=E123456")).toBe("E123456");
    expect(approvalIdOf("https://x.com/c?certNo=CB-12-345")).toBe("CB-12-345");
    expect(approvalIdOf("https://sieportal.siemens.com/search?CertificateTypeId=439&CertificateId=458")).toBe("");
  });
});
