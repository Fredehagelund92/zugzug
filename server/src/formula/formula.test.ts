import { describe, it, expect } from "bun:test";
import { parseFormula, collectFieldRefs, FormulaSyntaxError } from "./parse.ts";
import { runFormula, isFormulaError } from "./index.ts";

/* Convenience: evaluate an expression against a row keyed by field label.
   Fields not present in the row are treated as blank (null). */
function ev(expr: string, row: Record<string, unknown> = {}) {
  return runFormula(expr, row);
}

describe("parse — syntax", () => {
  it("rejects an empty formula", () => {
    expect(() => parseFormula("")).toThrow(FormulaSyntaxError);
    expect(() => parseFormula("   ")).toThrow(FormulaSyntaxError);
  });

  it("rejects unbalanced parens", () => {
    expect(() => parseFormula("IF(1, 2")).toThrow(FormulaSyntaxError);
    expect(() => parseFormula("(1 + 2")).toThrow(FormulaSyntaxError);
  });

  it("rejects a dangling operator", () => {
    expect(() => parseFormula("1 +")).toThrow(FormulaSyntaxError);
    expect(() => parseFormula("* 2")).toThrow(FormulaSyntaxError);
  });

  it("rejects trailing junk", () => {
    expect(() => parseFormula("1 2")).toThrow(FormulaSyntaxError);
  });

  it("rejects an unterminated string", () => {
    expect(() => parseFormula('"abc')).toThrow(FormulaSyntaxError);
  });
});

describe("collectFieldRefs", () => {
  it("lists referenced field labels, bare and bracketed, de-duplicated", () => {
    const refs = collectFieldRefs(
      parseFormula('IF(amount > 0, CONCAT(region, "-", [Sub Region]), amount)'),
    );
    expect(new Set(refs)).toEqual(new Set(["amount", "region", "Sub Region"]));
  });

  it("does not treat function names or booleans as fields", () => {
    expect(collectFieldRefs(parseFormula("IF(TRUE, 1, 2)"))).toEqual([]);
  });
});

describe("literals & field refs", () => {
  it("evaluates numeric, string, boolean literals", () => {
    expect(ev("42")).toBe(42);
    expect(ev("3.5")).toBe(3.5);
    expect(ev('"hi"')).toBe("hi");
    expect(ev("TRUE")).toBe(true);
    expect(ev("FALSE")).toBe(false);
  });

  it("reads a bare field and a bracketed field", () => {
    expect(ev("amount", { amount: 10 })).toBe(10);
    expect(ev("[Sub Region]", { "Sub Region": "APAC" })).toBe("APAC");
  });

  it("treats a missing/blank field as null", () => {
    expect(ev("amount", {})).toBe(null);
    expect(ev("amount", { amount: null })).toBe(null);
  });
});

describe("arithmetic", () => {
  it("respects precedence and parens", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("-2 + 5")).toBe(3);
    expect(ev("10 / 4")).toBe(2.5);
  });

  it("coerces numeric strings", () => {
    expect(ev("amount * 2", { amount: "21" })).toBe(42);
  });

  it("propagates null (blank) through arithmetic", () => {
    expect(ev("amount + 1", { amount: null })).toBe(null);
  });

  it("errors on division by zero", () => {
    expect(isFormulaError(ev("1 / 0"))).toBe(true);
  });

  it("errors on non-numeric arithmetic", () => {
    expect(isFormulaError(ev('"x" * 2'))).toBe(true);
  });
});

describe("comparisons", () => {
  it("equality works for numbers and strings", () => {
    expect(ev("1 = 1")).toBe(true);
    expect(ev('"US" = "US"')).toBe(true);
    expect(ev('"US" != "CA"')).toBe(true);
    expect(ev("amount = 5", { amount: "5" })).toBe(true); // numeric coercion
  });

  it("ordering is numeric", () => {
    expect(ev("2 > 1")).toBe(true);
    expect(ev("1 >= 1")).toBe(true);
    expect(ev("1 < 0")).toBe(false);
  });

  it("null equality: null=null true, null=x false", () => {
    expect(ev("a = b", { a: null, b: null })).toBe(true);
    expect(ev("a = 1", { a: null })).toBe(false);
    expect(ev("a != 1", { a: null })).toBe(true);
  });
});

describe("functions — logical & IF", () => {
  it("IF returns the right branch", () => {
    expect(ev('IF(amount > 0, "active", "inactive")', { amount: 5 })).toBe("active");
    expect(ev('IF(amount > 0, "active", "inactive")', { amount: 0 })).toBe("inactive");
  });

  it("AND / OR / NOT", () => {
    expect(ev("AND(TRUE, TRUE, FALSE)")).toBe(false);
    expect(ev("OR(FALSE, FALSE, TRUE)")).toBe(true);
    expect(ev("NOT(FALSE)")).toBe(true);
  });

  it("IF condition must be boolean", () => {
    expect(isFormulaError(ev('IF("x", 1, 2)'))).toBe(true);
  });
});

describe("functions — text", () => {
  it("CONCAT joins, coercing values, null → empty", () => {
    expect(ev('CONCAT(region, "-", code)', { region: "EU", code: 3 })).toBe("EU-3");
    expect(ev('CONCAT("a", missing, "b")', {})).toBe("ab");
  });

  it("UPPER / LOWER / TRIM", () => {
    expect(ev('UPPER("aB")')).toBe("AB");
    expect(ev('LOWER("aB")')).toBe("ab");
    expect(ev('TRIM("  x  ")')).toBe("x");
  });
});

describe("functions — null handling & number", () => {
  it("COALESCE returns first non-null", () => {
    expect(ev("COALESCE(a, b, 9)", { a: null, b: null })).toBe(9);
    expect(ev("COALESCE(a, b, 9)", { a: null, b: 2 })).toBe(2);
  });

  it("ISBLANK treats null and empty string as blank", () => {
    expect(ev("ISBLANK(a)", { a: null })).toBe(true);
    expect(ev("ISBLANK(a)", { a: "" })).toBe(true);
    expect(ev("ISBLANK(a)", { a: "x" })).toBe(false);
  });

  it("ROUND and ABS", () => {
    expect(ev("ROUND(3.14159, 2)")).toBe(3.14);
    expect(ev("ROUND(2.5)")).toBe(3);
    expect(ev("ABS(-7)")).toBe(7);
  });
});

describe("functions — arity & unknown", () => {
  it("errors on unknown function at parse or eval", () => {
    const r = ev("BOGUS(1)");
    expect(isFormulaError(r)).toBe(true);
  });

  it("errors on wrong arity", () => {
    expect(isFormulaError(ev("NOT(1, 2)"))).toBe(true);
    expect(isFormulaError(ev("IF(TRUE)"))).toBe(true);
  });
});
