import { describe, test, expect } from "vitest";
import { sanitizePeerCell } from "../src/lib/use-presence";

describe("sanitizePeerCell", () => {
  test("accepts the keyed shape", () => {
    expect(sanitizePeerCell({ rowKey: "acme", field: "label" })).toEqual({
      rowKey: "acme",
      field: "label",
    });
  });
  test("rejects the legacy index shape (older client mid-deploy)", () => {
    expect(sanitizePeerCell({ row: 3, col: 1 })).toBeNull();
  });
  test("rejects null/garbage", () => {
    expect(sanitizePeerCell(null)).toBeNull();
    expect(sanitizePeerCell("x")).toBeNull();
    expect(sanitizePeerCell({ rowKey: 7, field: "label" })).toBeNull();
  });
});
