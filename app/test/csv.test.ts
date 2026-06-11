import { describe, test, expect } from "vitest";
import { parseCsv, mapCsvHeaders, prepareImport } from "../src/lib/csv";
import type { FieldDef } from "../src/data";

const FIELDS: FieldDef[] = [
  { field: "region", label: "Region", type: "select" },
  { field: "tier", label: "Tier", type: "number" },
];
const OPTS = { keyCol: "country_code", dimension: "Country", fields: FIELDS };

describe("parseCsv", () => {
  test("plain cells, CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("quoted cells with commas, escaped quotes, newlines", () => {
    expect(parseCsv('a,"x, y","he said ""hi""","line\nbreak"')).toEqual([
      ["a", "x, y", 'he said "hi"', "line\nbreak"],
    ]);
  });

  test("skips fully empty lines", () => {
    expect(parseCsv("a,b\n\n1,2\n,\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("mapCsvHeaders", () => {
  test("round-trips this app's export headers (key,label,field labels)", () => {
    const m = mapCsvHeaders(["key", "label", "Region", "Tier"], OPTS);
    expect(m.keyIdx).toBe(0);
    expect(m.labelIdx).toBe(1);
    expect(m.fieldIdx).toEqual({ region: 2, tier: 3 });
    expect(m.ignored).toEqual([]);
  });

  test("matches keyCol name, dimension name, field ids, case-insensitive", () => {
    const m = mapCsvHeaders(["COUNTRY_CODE", "country", "region"], OPTS);
    expect(m.keyIdx).toBe(0);
    expect(m.labelIdx).toBe(1);
    expect(m.fieldIdx).toEqual({ region: 2 });
  });

  test("unknown headers are ignored and reported", () => {
    const m = mapCsvHeaders(["key", "label", "Bogus"], OPTS);
    expect(m.ignored).toEqual(["Bogus"]);
  });
});

describe("prepareImport", () => {
  test("builds rows with trimmed values, empty cells become null fields", () => {
    const { rows } = prepareImport('key,label,Region\nUS,United States, EMEA \nDK,Denmark,\n', OPTS);
    expect(rows).toEqual([
      { key: "US", label: "United States", fields: { region: "EMEA" } },
      { key: "DK", label: "Denmark", fields: { region: null } },
    ]);
  });

  test("throws without label or key column", () => {
    expect(() => prepareImport("Bogus,Stuff\n1,2", OPTS)).toThrow(/No "label" or "key"/);
  });

  test("throws on header-only file", () => {
    expect(() => prepareImport("key,label", OPTS)).toThrow(/at least one data row/);
  });
});
