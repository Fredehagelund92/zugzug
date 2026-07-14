import { describe, test, expect } from "vitest";
import { isRowTouchedHint } from "../src/lib/use-presence";

describe("isRowTouchedHint", () => {
  test("accepts a valid hint and rejects malformed / non-row_touched strings", () => {
    expect(isRowTouchedHint({ type: "row_touched", rowKey: "k", userId: "u" })).toBe(true);
    expect(isRowTouchedHint({ type: "other", rowKey: "k", userId: "u" })).toBe(false);
    expect(isRowTouchedHint({ rowKey: 1 })).toBe(false);
    expect(isRowTouchedHint(null)).toBe(false);
  });

  test("rejects wrong-typed rowKey/userId", () => {
    expect(isRowTouchedHint({ type: "row_touched", rowKey: 7, userId: "u" })).toBe(false);
    expect(isRowTouchedHint({ type: "row_touched", rowKey: "k", userId: 7 })).toBe(false);
    expect(isRowTouchedHint("row_touched")).toBe(false);
  });
});
