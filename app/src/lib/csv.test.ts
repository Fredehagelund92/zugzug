import { describe, it, expect } from "vitest";
import { applyColumnMap, fieldMismatch, type ColumnTarget } from "./csv";

describe("applyColumnMap", () => {
  const headers = ["ID", "Name", "Region"];
  const rows = [["us", "United States", "NA"]];
  it("maps chosen columns to key/label/field", () => {
    const map: ColumnTarget[] = [
      { kind: "key" },
      { kind: "label" },
      { kind: "field", fieldId: "region" },
    ];
    expect(applyColumnMap(headers, rows, map)).toEqual([
      { key: "us", label: "United States", fields: { region: "NA" } },
    ]);
  });
  it("ignores ignored columns and derives key from label when unmapped", () => {
    const map: ColumnTarget[] = [{ kind: "ignore" }, { kind: "label" }, { kind: "ignore" }];
    const out = applyColumnMap(headers, rows, map);
    expect(out[0].key).toBe("united_states");
    expect(out[0].fields).toEqual({});
  });
});

describe("fieldMismatch", () => {
  it("number with non-numeric string returns 'empty'", () => {
    expect(fieldMismatch("number", "abc")).toBe("empty");
  });
  it("number with 'Infinity' returns 'empty' (matches server Number.isFinite check)", () => {
    expect(fieldMismatch("number", "Infinity")).toBe("empty");
  });
  it("invalid date string returns 'blocking'", () => {
    expect(fieldMismatch("date", "not-a-date")).toBe("blocking");
  });
  it("valid date string returns null", () => {
    expect(fieldMismatch("date", "2024-01-15")).toBeNull();
  });
  it("valid number returns null", () => {
    expect(fieldMismatch("number", "42")).toBeNull();
  });
  it("empty string returns null for any type", () => {
    expect(fieldMismatch("number", "")).toBeNull();
    expect(fieldMismatch("date", "  ")).toBeNull();
  });
});
