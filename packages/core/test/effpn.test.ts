import { describe, expect, it } from "vitest";
import { effectivePn } from "../src/index";
describe("effectivePn", () => {
  const p = { partNumber: "6ES7155-6AU01-0BN0", manufacturer: "Siemens", series: "", description: "", category: "", vendor: "", powerIn: null, powerOut: null, custom: { poles: 3 }, sku: "SK-1", configCode1: "Z=A05", configCode2: "", configCode3: "" };
  it("is the part number when not defined, else the Python result", () => {
    expect(effectivePn(p).text).toBe("6ES7155-6AU01-0BN0");
    expect(effectivePn({ ...p, effPnExpr: 'f"{pn}-{config1}"' }).text).toBe("6ES7155-6AU01-0BN0-Z=A05");
    expect(effectivePn({ ...p, effPnExpr: "sku or pn" }).text).toBe("SK-1");
    expect(effectivePn({ ...p, effPnExpr: '"-".join(c for c in [pn, config1, config2, config3] if c)' }).text).toBe("6ES7155-6AU01-0BN0-Z=A05");
    expect(effectivePn({ ...p, effPnExpr: 'pn + ("-3P" if Spec["poles"] == 3 else "")' }).text).toBe("6ES7155-6AU01-0BN0-3P");
  });
  it("falls back to the part number on errors and empty results", () => {
    const e = effectivePn({ ...p, effPnExpr: "pn +" });
    expect(e.text).toBe("6ES7155-6AU01-0BN0");
    expect(e.error).toBeTruthy();
    expect(effectivePn({ ...p, effPnExpr: "config3" }).error).toMatch(/Empty/);
  });
});

import { effectiveDesc, effectivePrice, nextEffVersion } from "../src/index";
describe("effective description / price / versions", () => {
  const p = { partNumber: "X1", manufacturer: "M", series: "", description: "Relay 24V", category: "", vendor: "", powerIn: null, powerOut: null, custom: {}, configCode1: "2CO", price: 10 };
  it("applies the custom description only when switched on", () => {
    expect(effectiveDesc({ ...p, effDescExpr: 'f"{desc}, {config1}"', effApply: true }).text).toBe("Relay 24V, 2CO");
    expect(effectiveDesc({ ...p, effDescExpr: 'f"{desc}, {config1}"', effApply: false }).text).toBe("Relay 24V");
    expect(effectivePrice({ ...p, effPrice: 12.5, effApply: true })).toBe(12.5);
    expect(effectivePrice({ ...p, effPrice: 12.5, effApply: false })).toBe(10);
  });
  it("numbers versions", () => {
    expect(nextEffVersion([], "minor")).toEqual({ major: 1, minor: 1 });
    expect(nextEffVersion([{ major: 1, minor: 1 }, { major: 1, minor: 2 }], "minor")).toEqual({ major: 1, minor: 3 });
    expect(nextEffVersion([{ major: 1, minor: 2 }], "major")).toEqual({ major: 2, minor: 1 });
  });
});
