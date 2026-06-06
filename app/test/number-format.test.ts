import { describe, test, expect } from "vitest";
import { formatNumber } from "../src/components/datagrid/cells/NumberCell";

describe("formatNumber", () => {
  test("undefined format returns raw string", () => {
    expect(formatNumber(42, undefined)).toBe("42");
  });

  test("null/non-finite value returns em dash regardless of format", () => {
    expect(formatNumber(null, undefined)).toBe("—");
    expect(formatNumber(null, { format: "integer" })).toBe("—");
    expect(formatNumber("abc", { format: "decimal", precision: 2 })).toBe("—");
  });

  test("integer format: thousands separator, no decimals", () => {
    expect(formatNumber(42, { format: "integer" })).toBe("42");
    expect(formatNumber(1234567, { format: "integer" })).toBe("1,234,567");
    expect(formatNumber(-42, { format: "integer" })).toBe("-42");
  });

  test("decimal format: fixed precision with thousands separator", () => {
    expect(formatNumber(42, { format: "decimal", precision: 2 })).toBe("42.00");
    expect(formatNumber(1234.5, { format: "decimal", precision: 1 })).toBe("1,234.5");
    expect(formatNumber(3.14159, { format: "decimal", precision: 3 })).toBe("3.142");
  });

  test("percent format: normalized storage (0.42 → 42%)", () => {
    expect(formatNumber(0.42, { format: "percent", precision: 0 })).toBe("42%");
    expect(formatNumber(0.425, { format: "percent", precision: 1 })).toBe("42.5%");
    expect(formatNumber(1, { format: "percent", precision: 0 })).toBe("100%");
  });

  test("currency prefix: symbol before digits", () => {
    expect(
      formatNumber(42, { format: "currency", symbol: "$", position: "prefix", precision: 2 }),
    ).toBe("$42.00");
    expect(
      formatNumber(1234.5, { format: "currency", symbol: "USD ", position: "prefix", precision: 2 }),
    ).toBe("USD 1,234.50");
  });

  test("currency suffix: digit then space then symbol", () => {
    expect(
      formatNumber(42, { format: "currency", symbol: "kr", position: "suffix", precision: 2 }),
    ).toBe("42.00 kr");
  });

  test("currency: negative numbers — minus sign always leftmost", () => {
    expect(
      formatNumber(-42, { format: "currency", symbol: "$", position: "prefix", precision: 2 }),
    ).toBe("-$42.00");
    expect(
      formatNumber(-42, { format: "currency", symbol: "kr", position: "suffix", precision: 2 }),
    ).toBe("-42.00 kr");
  });
});
