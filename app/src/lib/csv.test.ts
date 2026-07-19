import { describe, it, expect } from "vitest";
import { applyColumnMap, fieldMismatch, prepareCreateFromCsv, type ColumnTarget } from "./csv";

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

describe("prepareCreateFromCsv", () => {
  it("makes the first column the name and every other column a field (keyed by header)", () => {
    const out = prepareCreateFromCsv("Name,Region,Tier\nAcme Corp,EMEA,gold\nGlobex,AMER,silver");
    expect(out.nameHeader).toBe("Name");
    expect(out.columns).toEqual(["Region", "Tier"]);
    expect(out.recordCount).toBe(2);
    expect(out.rows[0]).toEqual({
      label: "Acme Corp",
      fields: { Region: "EMEA", Tier: "gold" },
    });
  });

  it("prefers a header named name/label/record over the first column", () => {
    const out = prepareCreateFromCsv("id,name,region\n1,Acme,EMEA");
    expect(out.nameHeader).toBe("name");
    expect(out.columns).toEqual(["id", "region"]);
    expect(out.rows[0].label).toBe("Acme");
  });

  it("treats blank cells as null and skips rows with no name", () => {
    const out = prepareCreateFromCsv("Name,Region\nAcme,\n,APAC\nGlobex,AMER");
    expect(out.recordCount).toBe(2);
    expect(out.rows[0].fields.Region).toBeNull();
    expect(out.rows.map((r) => r.label)).toEqual(["Acme", "Globex"]);
  });

  it("rejects a file with no data rows", () => {
    expect(() => prepareCreateFromCsv("Name,Region")).toThrow(/header row and at least one data row/i);
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
