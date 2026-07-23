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
});

describe("columnBadges", () => {
  it("lists rules present", () => {
    expect(columnBadges({ type: "text", required: true, validation: { unique: true } })).toEqual([
      "REQ",
      "UNIQ",
    ]);
  });
});
