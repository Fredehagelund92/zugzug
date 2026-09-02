import { describe, it, expect } from "vitest";
import { valueShapeError, columnBadges } from "./validation";
import type { ColumnConfig } from "./types";

const others = [
  { key: "APAC", value: "APAC" },
  { key: "EMEA", value: "EMEA" },
];

describe("valueShapeError", () => {
  it("flags a number below min", () => {
    const c: ColumnConfig = { type: "number", validation: { min: 0 } };
    expect(valueShapeError(c, -5, "NAMR", [])).toBe("Must be 0 or more.");
  });
  it("flags a number above max", () => {
    const c: ColumnConfig = { type: "number", validation: { max: 100 } };
    expect(valueShapeError(c, 250, "NAMR", [])).toBe("Must be 100 or less.");
  });
  it("flags text shorter than min length", () => {
    const c: ColumnConfig = { type: "text", validation: { min: 3 } };
    expect(valueShapeError(c, "ab", "x", [])).toBe("Must be at least 3 characters.");
  });
  it("flags a duplicate when unique (case-insensitive)", () => {
    const c: ColumnConfig = { type: "text", validation: { unique: true } };
    expect(valueShapeError(c, "apac", "NAMR", others)).toBe("Already used by APAC.");
  });
  it("allows the same row keeping its own value", () => {
    const c: ColumnConfig = { type: "text", validation: { unique: true } };
    expect(valueShapeError(c, "APAC", "APAC", others)).toBeNull();
  });
  it("treats empty as no clash and no range error", () => {
    const c: ColumnConfig = { type: "number", validation: { min: 0, unique: true } };
    expect(valueShapeError(c, "", "NAMR", others)).toBeNull();
  });
  it("rejects non-numeric input in a number column", () => {
    const c: ColumnConfig = { type: "number", validation: {} };
    expect(valueShapeError(c, "abc", "x", [])).toBe("Enter a number.");
  });
  it("rejects text that isn't a date in a date column", () => {
    const c: ColumnConfig = { type: "date", validation: {} };
    expect(valueShapeError(c, "hello", "x", [])).toBe("Enter a date as YYYY-MM-DD.");
  });
  it("accepts a well-formed date", () => {
    const c: ColumnConfig = { type: "date", validation: { min: "2020-01-01" } };
    expect(valueShapeError(c, "2026-01-31", "x", [])).toBeNull();
  });
});

describe("columnBadges", () => {
  it("lists rules present", () => {
    expect(columnBadges({ type: "text", required: true, validation: { unique: true } })).toEqual([
      "REQ",
      "UNIQ",
    ]);
  });
});
