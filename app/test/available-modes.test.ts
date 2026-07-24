import { describe, test, expect } from "vitest";
import { availableModes } from "../src/lib/available-modes";
import type { MappingRefTable } from "../src/data";
import type { SourceInfo } from "../src/store";

const refTable = (id: string): MappingRefTable =>
  ({
    id,
    refTable: id,
    dimTable: `dim_${id}`,
    mapTable: `map_${id}`,
    keyCol: `${id}_id`,
    rows: 0,
    record: [],
    values: [],
  }) as MappingRefTable;
const src = (refTableId: string): SourceInfo =>
  ({ table: "t", column: "c", refTableId, values: 0, unmapped: 0, rows: 0 }) as SourceInfo;

describe("availableModes", () => {
  test("static reference table (no wiring) → records only", () => {
    expect(availableModes(refTable("a"), [])).toEqual(["records"]);
  });
  test("sourced + mapped table → records, match, sources", () => {
    expect(availableModes(refTable("a"), [src("a")])).toEqual(["records", "match", "sources"]);
  });
  test("wiring on a different refTable does not unlock match for this one", () => {
    expect(availableModes(refTable("a"), [src("b")])).toEqual(["records"]);
  });
  test("multiple wired sources for the same refTable still yield one match + one sources entry", () => {
    expect(availableModes(refTable("a"), [src("a"), src("a")])).toEqual([
      "records",
      "match",
      "sources",
    ]);
  });
});
