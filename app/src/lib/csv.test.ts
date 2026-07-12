import { describe, it, expect } from "vitest";
import { applyColumnMap, type ColumnTarget } from "./csv";

describe("applyColumnMap", () => {
  const headers = ["ID", "Name", "Region"];
  const rows = [["us", "United States", "NA"]];
  it("maps chosen columns to key/label/field", () => {
    const map: ColumnTarget[] = [{ kind: "key" }, { kind: "label" }, { kind: "field", fieldId: "region" }];
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
