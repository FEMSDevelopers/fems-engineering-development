import { describe, expect, it } from "vitest";
import { exportFileName, exportStamp, makeLibFile, parseLibFile } from "../src/pylibfile";

describe("function library files", () => {
  it("names exports Jsoneditor_export_YYYYDDMM_HHMMSSssss", () => {
    const d = new Date(2026, 9, 22, 14, 3, 7, 123); // 22 Oct 2026, local time
    expect(exportStamp(d.getTime() + 0.45)).toBe("20262210_1403071234");
    expect(exportFileName(d.getTime())).toBe("Jsoneditor_export_20262210_1403071230.json");
    expect(exportStamp(new Date(2026, 0, 5, 9, 8, 7, 0).getTime())).toBe("20260501_0908070000");
  });
  it("round-trips the export format", () => {
    const f = makeLibFile([{ name: "Tag helpers", version: "1.002", notes: "n", code: "def f(x):\n    return x\n", functions: ["f(x)"], tries: ["f(1)", ""] }]);
    const r = parseLibFile(JSON.stringify(f, null, 2), "Jsoneditor_export_x.json");
    expect(r.error).toBeUndefined();
    expect(r.libraries).toEqual(f.libraries);
  });
  it("accepts plain Python, single objects, arrays, and reports bad input", () => {
    expect(parseLibFile("def a():\r\n    return 1\r\n", "C:\\x\\tag_helpers.py")).toEqual({ libraries: [{ name: "tag_helpers", code: "def a():\n    return 1\n" }] });
    expect(parseLibFile('{"name":"A","code":"def a(): pass"}').libraries[0].name).toBe("A");
    const r = parseLibFile('[{"code":"x=1"},{"name":"no code"}]', "lib.json");
    expect(r.libraries.map((l) => l.name)).toEqual(["lib 1"]);
    expect(r.error).toMatch(/Skipped entry 2/);
    expect(parseLibFile("{oops", "a.json").error).toMatch(/Not valid JSON/);
    expect(parseLibFile('{"libraries":[]}').error).toMatch(/No function library/);
    expect(parseLibFile("  ").error).toMatch(/empty/);
  });
});
