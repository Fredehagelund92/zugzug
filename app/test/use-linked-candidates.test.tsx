import { describe, test, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLinkedCandidates } from "../src/lib/use-linked-candidates";
import type { FieldDef, MappingRefTable } from "../src/data";

const mkDim = (id: string, record: Array<{ key: string; label: string }>): MappingRefTable => ({
  id,
  refTable: id.toUpperCase(),
  dimTable: `zugzug.dim_${id}`,
  mapTable: `zugzug.map_${id}`,
  keyCol: `${id}_code`,
  rows: 0,
  record: record.map((c) => ({ ...c, version: 1 })),
  values: [],
  fields: [],
});

const linkedField: FieldDef = {
  field: "country_fk",
  label: "Country",
  type: "linked",
  referencedRefTableId: "country",
};

describe("useLinkedCandidates", () => {
  test("resolves candidates for referenced refTables", () => {
    const country = mkDim("country", [{ key: "US", label: "United States" }]);
    const { result } = renderHook(() => useLinkedCandidates([linkedField], [country]));
    expect(result.current.get("country")?.candidates).toEqual([
      { key: "US", label: "United States" },
    ]);
  });

  test("identity is STABLE when allDims array is new but referenced refTables are unchanged", () => {
    const country = mkDim("country", [{ key: "US", label: "United States" }]);
    const channel = mkDim("channel", [{ key: "seo", label: "SEO" }]);
    const { result, rerender } = renderHook(
      ({ refTables }) => useLinkedCandidates([linkedField], refTables),
      { initialProps: { refTables: [country, channel] } },
    );
    const first = result.current;
    rerender({ refTables: [country, { ...channel }] }); // new array + unrelated refTable replaced
    expect(result.current).toBe(first);
  });

  test("identity CHANGES when a referenced refTable object is replaced", () => {
    const country = mkDim("country", [{ key: "US", label: "United States" }]);
    const { result, rerender } = renderHook(
      ({ refTables }) => useLinkedCandidates([linkedField], refTables),
      { initialProps: { refTables: [country] } },
    );
    const first = result.current;
    rerender({ refTables: [mkDim("country", [{ key: "US", label: "USA" }])] });
    expect(result.current).not.toBe(first);
    expect(result.current.get("country")!.candidates[0]!.label).toBe("USA");
  });

  test("no linked fields → stable empty map", () => {
    const refTable = mkDim("country", []);
    const { result, rerender } = renderHook(({ refTables }) => useLinkedCandidates([], refTables), {
      initialProps: { refTables: [refTable] },
    });
    const first = result.current;
    rerender({ refTables: [{ ...refTable }] });
    expect(result.current).toBe(first);
    expect(result.current.size).toBe(0);
  });
});
