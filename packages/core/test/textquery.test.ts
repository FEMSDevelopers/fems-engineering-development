import { describe, expect, it } from "vitest";
import { compileTextQuery as q } from "../src/textquery.js";

const m = (query: string, text: string) => q(query)!(text);

describe("text query (column filters)", () => {
  it("contains, case-insensitive", () => {
    expect(m("ds", "DS IG QSG")).toBe(true);
    expect(m("MAN", "DS IG")).toBe(false);
  });
  it("OR / AND, with symbols or words", () => {
    expect(m("DS|DOC", "IG DOC")).toBe(true);
    expect(m("DS OR DOC", "IG")).toBe(false);
    expect(m("DS&IG", "DS IG")).toBe(true);
    expect(m("DS AND MAN", "DS IG")).toBe(false);
    expect(m("DS&IG|MAN", "MAN")).toBe(true); // AND binds tighter
  });
  it("wildcards", () => {
    expect(m("A*7552", "APC AP7552")).toBe(true);
    expect(m("AP75?2", "AP7552")).toBe(true);
    expect(m("AP7[0-4]*", "AP7552")).toBe(false);
  });
  it("whole cell, empty cell, negation, literal", () => {
    expect(m("=DS", "DS")).toBe(true);
    expect(m("=DS", "DS IG")).toBe(false);
    expect(m("=", "")).toBe(true);
    expect(m("=", "DS")).toBe(false);
    expect(m("!DS", "IG")).toBe(true);
    expect(m("IG&!DS", "DS IG")).toBe(false);
    expect(m('"a|b"', "x a|b y")).toBe(true);
    expect(m('"a*b"', "aXb")).toBe(false);
  });
  it("a leading dash is text (device tags)", () => {
    expect(m("-PDU", "+RACK.01-PDU.01")).toBe(true);
  });
  it("empty query = no filter", () => {
    expect(q("  ")).toBeNull();
  });
});
