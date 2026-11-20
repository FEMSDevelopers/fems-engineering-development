import { describe, expect, it } from "vitest";
import { evalExpr, exprNames, PyDict, PyFloat, pyFormat } from "../src/index.js";

const col = new PyDict((k) => ({ "Register Type": "HR", "a|b}": "odd", Scale: "0.1" } as Record<string, string>)[k]);
const ev = (s: string) => evalExpr(s, { value: "soc", col, result: new PyDict((k) => ({ address: 14, space: "HR" } as Record<string, number | string>)[k]), n: 3 });

describe("python expressions", () => {
  it("strings, f-strings and format specs", () => {
    expect(ev(`f"{col['Register Type']}_{result.address:04d}"`)).toBe("HR_0014");
    expect(ev(`col["Register Type"] + "_" + str(result.address).zfill(4)`)).toBe("HR_0014");
    expect(ev(`col["a|b}"]`)).toBe("odd");
    expect(ev(`f"{col["Register Type"]}_{result.address:04d}_{'x' + "y"}"`)).toBe("HR_0014_xy");
    expect(ev(`f"{{a}}{n}}}"`)).toBe("{a}3}");
    expect(ev(`value.upper()[0:2] + "-" + "x".join(["a", "b"])`)).toBe("SO-axb");
    expect(ev(`f"{n:>4}|{n:<4}|{n:^5}|{3.14159:.2f}|{255:X}|{1234567:,}"`)).toBe("   3|3   |  3  |3.14|FF|1,234,567");
    expect(ev(`f"{{literal}} {value!r}"`)).toBe("{literal} 'soc'");
    expect(ev(`"Rack_01_V".split("_")[1]`)).toBe("01");
    expect(ev(`pad(result.address, 6, " ")`)).toBe("    14");
    expect(ev(`modicon(result.space, result.address)`)).toBe("40015");
  });
  it("numbers, conversions and logic", () => {
    expect(ev(`float(col["Scale"]) * 1000`)).toBe("100.0");
    expect(ev(`int(float(col["Scale"]) * 1000)`)).toBe("100");
    expect(ev(`7 // 2, 7 % 3`.split(",")[0])).toBe("3");
    expect(ev(`-7 // 2`)).toBe("-4");
    expect(ev(`2 ** 10`)).toBe("1024");
    expect(ev(`10 / 4`)).toBe("2.5");
    expect(ev(`round(2.5)`)).toBe("2");
    expect(ev(`round(3.14159, 2)`)).toBe("3.14");
    expect(ev(`int("0x1A", 16)`)).toBe("26");
    expect(ev(`"RW" if "w" in value + "w" and not False else "R"`)).toBe("RW");
    expect(ev(`max(1, 5, 3)`)).toBe("5");
    expect(ev(`None`)).toBe("");
    expect(ev(`1 < n <= 3`)).toBe("True");
    expect(ev(`[None is None, n is not None, value is None]`)).toBe("[True, True, False]");
  });
  it("reports Python-style errors", () => {
    expect(() => ev(`"a" + 1`)).toThrow(/can only concatenate str \(not "int"\) to str/);
    expect(() => ev(`col["Missing"]`)).toThrow(/KeyError: 'Missing'/);
    expect(() => ev(`foo(1)`)).toThrow(/name 'foo' is not defined/);
    expect(() => ev(`int("abc")`)).toThrow(/invalid literal for int\(\) with base 10/);
    expect(() => ev(`f"{3.5:d}"`)).toThrow(/Unknown format code 'd' for object of type 'float'/);
    expect(() => ev(`(1 +`)).toThrow(/incomplete/);
  });
  it("lists the names an expression uses", () => {
    expect([...exprNames(`f"{col['x']}_{result.address}" + unit.desired`)].sort()).toEqual(["col", "result", "unit"]);
    expect(pyFormat(new PyFloat(0.5), ".1%")).toBe("50.0%");
  });
});

import { execCode, parseCode, PyMap, runCode, codeNames } from "../src/index.js";
describe("python code blocks", () => {
  const el = new PyMap([["name", "BMS Rack 3 SOC"], ["id", 7], ["tags", ["a", "b"]], ["meta", new PyMap([["bay", "F12"]])]]);
  it("runs statements, loops, conditionals, dicts and comprehensions", () => {
    const code = `
# build a tag from the element
parts = el["name"].split()          # ['BMS', 'Rack', '3', 'SOC']
rack = 0
for i, p in enumerate(parts):
    if p.isdigit():
        rack = int(p)
        break
else_part = "x"
prefix = {"BMS": "B", "PCS": "P"}.get(parts[0], "?")
total = sum([len(t) for t in el["tags"] if t != "z"])
names = []
k = 0
while k < 3:
    k += 1
    if k == 2:
        continue
    names.append(str(k))
if rack > 5:
    size = "big"
elif rack > 2:
    size = "mid"
else:
    size = "small"
d = {}
d["bay"] = el.meta.bay
return f"{prefix}{rack:02d}_{parts[-1]}_{size}_{total}_{'-'.join(names)}_{d['bay']}"
`;
    expect(runCode(code, { el })).toBe("B03_SOC_mid_2_1-3_F12");
  });
  it("handles return in nested blocks, inline bodies, tuples and print", () => {
    const log: string[] = [];
    expect(runCode(`for x in range(10):\n    if x * x > 20: return x\nreturn -1`, {})).toBe("5");
    expect(runCode(`a, b = 1, 2\nprint("sum", a + b)\nreturn [a, b]`, {}, (s) => log.push(s))).toBe("[1, 2]");
    expect(log).toEqual(["sum 3"]);
    expect(runCode(`return sorted([3, 1, 2], reverse=True)`, {})).toBe("[3, 2, 1]");
    expect(runCode(`m = dict(a=1)\nm.update({"b": 2})\nreturn ",".join(k + "=" + str(v) for k, v in m.items())`, {})).toBe("a=1,b=2");
    expect(runCode(`x = 5`, {})).toBe("");
    expect(runCode(`print("no log")\nreturn 1`, {})).toBe("1");
  });
  it("reports errors with line numbers and stops endless loops", () => {
    expect(() => runCode(`a = 1\nb = a + "x"`, {})).toThrow(/line 2: unsupported operand/);
    expect(() => runCode(`if True\n    pass`, {})).toThrow(/line 1: expected ":"/);
    expect(() => runCode(`while True:\n    pass`, {})).toThrow(/endless loop/);
    expect(() => parseCode(`if x:\nreturn 1`)).toThrow(/expected an indented block/);
    expect(() => runCode(`return el["nope"]`, { el })).toThrow(/KeyError: 'nope'/);
    expect(execCode(`return None`, {})).toBe(null);
    expect([...codeNames(`v = result.address\nreturn f"{unit.desired}"`)]).toEqual(expect.arrayContaining(["result", "unit"]));
    expect(codeNames(`unit = el["u"]\nfor result in [1]:\n    pass\nreturn unit`).has("unit")).toBe(false);
  });
});

describe("python exceptions", () => {
  const el = (id: string) => new PyMap([["deviceId", id]]);
  const user = `
value = el["deviceId"]
sep = "_"
num = None
for fragment in str(value).split(sep):
    fragment = fragment.strip()
    try:
        num = float(fragment)
    except ValueError:
        continue
    num = int(num) if num.is_integer() else num
    break
return num`;
  it("runs the user's try/except loop", () => {
    expect(runCode(user, { el: el("PCS_ 12 _A") })).toBe("12");
    expect(runCode(user, { el: el("rack_3.5_x") })).toBe("3.5");
    expect(runCode(user, { el: el("no_number_here") })).toBe("");
  });
  it("supports except types, tuples, as, bare, else, finally, raise and re-raise", () => {
    const log: string[] = [];
    const code = `
out = []
for x in ["1", "a", None, "0"]:
    try:
        n = 10 // int(x)
    except (ValueError, TypeError) as e:
        out.append("bad:" + type_name)
        continue
    except ZeroDivisionError:
        out.append("zero")
    else:
        out.append(str(n))
    finally:
        print("done", x)
return ",".join(out)`;
    expect(runCode(code.replace("type_name", "str(e)[:7]"), {}, (s) => log.push(s))).toBe("10,bad:invalid,bad:int() a,zero");
    expect(log).toHaveLength(4);
    expect(runCode(`try:\n    raise ValueError("bad value")\nexcept ValueError as e:\n    return "caught " + str(e)`, {})).toBe("caught bad value");
    expect(runCode(`try:\n    {}["k"]\nexcept LookupError:\n    return "lookup"`, {})).toBe("lookup");
    expect(runCode(`try:\n    x = undefined_name\nexcept:\n    return "bare"`, {})).toBe("bare");
    expect(() => runCode(`try:\n    int("x")\nexcept KeyError:\n    pass`, {})).toThrow(/invalid literal/);
    expect(() => runCode(`try:\n    int("x")\nexcept ValueError:\n    raise`, {})).toThrow(/invalid literal/);
    expect(() => runCode(`raise TypeError("nope")`, {})).toThrow(/line 1: TypeError: nope/);
    expect(() => runCode(`try:\n    while True:\n        pass\nexcept:\n    return 1`, {})).toThrow(/endless loop/);
    expect(() => runCode(`try:\n    x = 1`, {})).toThrow(/needs an "except" or "finally"/);
  });
  it("runs else on loops without break, number methods and isinstance", () => {
    expect(runCode(`for i in range(3):\n    if i == 9: break\nelse:\n    return "no break"\nreturn "broke"`, {})).toBe("no break");
    expect(runCode(`n = 0\nwhile n < 5:\n    n += 1\n    if n == 3: break\nelse:\n    return "x"\nreturn n`, {})).toBe("3");
    expect(runCode(`return [(2.0).is_integer(), (2.5).is_integer(), isinstance(3, int), isinstance("a", (int, str)), isinstance(1.5, int)]`, {})).toBe("[True, False, True, True, False]");
  });
});

import { loadLibrary, evalExpr as ev2 } from "../src/index.js";
describe("python functions and libraries", () => {
  const lib = `
SEP = "_"

def first_number(value, sep=None):
    """Split \`value\` and return the first fragment that parses as a number
    (left to right). Returns None if no fragment is numeric."""
    for fragment in str(value).split(sep):
        fragment = fragment.strip()
        try:
            num = float(fragment)
        except ValueError:
            continue
        return int(num) if num.is_integer() else num
    return None

def rack_tag(name: str, prefix="R") -> str:
    n = first_number(name, SEP)
    if n is None:
        raise ValueError("no number in " + name)
    return f"{prefix}{n:02d}"

def fact(n):
    return 1 if n <= 1 else n * fact(n - 1)

def total(*xs, **opts):
    return sum([x * opts.get("k", 1) for x in xs])
`;
  it("loads a library with def, docstrings, type hints, defaults, recursion, *args/**kwargs", () => {
    const L = loadLibrary(lib);
    expect(L.error).toBeNull();
    expect(L.funcs.map((f) => f.sig)).toEqual(["first_number(value, sep=None)", "rack_tag(name: str, prefix=\"R\")", "fact(n)", "total(*xs, **opts)"]);
    expect(L.funcs[0].doc).toMatch(/^Split `value` and return the first fragment/);
    const sc = L.names;
    expect(ev2(`first_number("PCS 12 A")`, sc)).toBe("12");
    expect(ev2(`first_number("rack_3.5_x", "_")`, sc)).toBe("3.5");
    expect(ev2(`first_number("none here")`, sc)).toBe("");
    expect(ev2(`rack_tag("BMS_7_SOC", prefix="RK")`, sc)).toBe("RK07");
    expect(ev2(`fact(5)`, sc)).toBe("120");
    expect(ev2(`total(1, 2, 3, k=10)`, sc)).toBe("60");
    expect(() => ev2(`rack_tag("abc")`, sc)).toThrow(/ValueError: no number in abc/);
    expect(() => ev2(`first_number()`, sc)).toThrow(/missing required argument: 'value'/);
    expect(() => ev2(`fact(500)`, sc)).toThrow(/recursion depth/);
    expect(runCode(`try:\n    return rack_tag("x")\nexcept ValueError as e:\n    return "err: " + str(e)`, sc)).toBe("err: no number in x");
  });
  it("reports library errors and functions defined inside code", () => {
    expect(loadLibrary(`def f(:\n    pass`).error).toMatch(/line 1/);
    expect(loadLibrary(`x = 1 / 0`).error).toMatch(/division by zero/);
    expect(runCode(`def sq(x):\n    return x * x\nreturn [sq(i) for i in range(4)]`, {})).toBe("[0, 1, 4, 9]");
  });
});
