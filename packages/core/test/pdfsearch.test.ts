import { describe, expect, it } from "vitest";
import { compilePdfSearch, searchSpans } from "../src/pdfsearch.js";

const find = (q: string, text: string, o: Partial<{ mode: "text" | "regex"; matchCase: boolean; wholeWord: boolean }> = {}) => {
  const re = compilePdfSearch(q, { mode: "text", matchCase: false, wholeWord: false, ...o });
  if (!re || "error" in re) return re;
  return searchSpans(re, text).map(([a, b]) => text.slice(a, b));
};

describe("pdf search", () => {
  it("text, case, wildcards, alternatives", () => {
    expect(find("volt", "Rated Voltage 230 V")).toEqual(["Volt"]);
    expect(find("volt", "Rated Voltage", { matchCase: true })).toEqual([]);
    expect(find("2?0 V", "230 V or 240 V")).toEqual(["230 V", "240 V"]);
    expect(find("UL*489", "per UL 489 and UL489")).toEqual(["UL 489", "UL489"]);
    expect(find("IP20|IP65", "IP20 front, IP65 rear")).toEqual(["IP20", "IP65"]);
    expect(find('"a|b"', "x a|b")).toEqual(["a|b"]);
  });
  it("whole word", () => {
    expect(find("IP2", "IP20 IP2", { wholeWord: true })).toEqual(["IP2"]);
  });
  it("python regex", () => {
    expect(find("(?P<v>\\d+) ?V\\b", "230 V, 24V", { mode: "regex" })).toEqual(["230 V", "24V"]);
    expect(find("(?i)curve [bcd]\\b", "Tripping CURVE C", { mode: "regex", matchCase: true })).toEqual(["CURVE C"]);
    expect(find("(\\w)(?P=x)", "aa", { mode: "regex" })).toHaveProperty("error");
    expect(find("a*", "bbb", { mode: "regex" })).toHaveProperty("error");
  });
});
