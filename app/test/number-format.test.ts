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
      formatNumber(1234.5, {
        format: "currency",
        symbol: "USD ",
        position: "prefix",
        precision: 2,
      }),
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

describe("compact format", () => {
  test("precision 0: abbreviates to nearest unit", () => {
    expect(formatNumber(45000, { format: "compact", precision: 0 })).toBe("45K");
    expect(formatNumber(1200000, { format: "compact", precision: 0 })).toBe("1M");
    expect(formatNumber(999, { format: "compact", precision: 0 })).toBe("999");
  });
  test("precision 1: one decimal after abbreviation", () => {
    expect(formatNumber(1200000, { format: "compact", precision: 1 })).toBe("1.2M");
  });
  test("negative values", () => {
    expect(formatNumber(-45000, { format: "compact", precision: 0 })).toBe("-45K");
  });
});

describe("duration format", () => {
  test("hm: shows hours and minutes, drops seconds", () => {
    expect(formatNumber(3600 + 23 * 60, { format: "duration", display: "hm" })).toBe("1h 23m");
    expect(formatNumber(45 * 60, { format: "duration", display: "hm" })).toBe("45m");
    expect(formatNumber(30, { format: "duration", display: "hm" })).toBe("< 1m");
  });
  test("hms: zero-padded H:MM:SS", () => {
    expect(formatNumber(3600 + 23 * 60 + 45, { format: "duration", display: "hms" })).toBe(
      "1:23:45",
    );
    expect(formatNumber(90, { format: "duration", display: "hms" })).toBe("0:01:30");
  });
  test("null returns em dash", () => {
    expect(formatNumber(null, { format: "duration", display: "hm" })).toBe("—");
  });
});
