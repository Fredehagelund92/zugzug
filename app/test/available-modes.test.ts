import { describe, test, expect } from "vitest";
import { availableModes } from "../src/lib/available-modes";
import type { MappingDimension } from "../src/data";
import type { SourceInfo } from "../src/store";

const dim = (id: string): MappingDimension =>
  ({
    id,
    dimension: id,
    dimTable: `dim_${id}`,
    mapTable: `map_${id}`,
    keyCol: `${id}_id`,
    rows: 0,
    canonical: [],
    values: [],
  }) as MappingDimension;
const src = (dimId: string): SourceInfo =>
  ({ table: "t", column: "c", dimId, values: 0, unmapped: 0, rows: 0 }) as SourceInfo;

describe("availableModes", () => {
  test("static reference table (no wiring) → records only", () => {
    expect(availableModes(dim("a"), [])).toEqual(["records"]);
  });
  test("sourced + mapped table → records, match, sources", () => {
    expect(availableModes(dim("a"), [src("a")])).toEqual(["records", "match", "sources"]);
  });
  test("wiring on a different dim does not unlock match for this one", () => {
    expect(availableModes(dim("a"), [src("b")])).toEqual(["records"]);
  });
  test("multiple wired sources for the same dim still yield one match + one sources entry", () => {
    expect(availableModes(dim("a"), [src("a"), src("a")])).toEqual(["records", "match", "sources"]);
  });
});
