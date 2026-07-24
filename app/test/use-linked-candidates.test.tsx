import { describe, test, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLinkedCandidates } from "../src/lib/use-linked-candidates";
import type { FieldDef, MappingDimension } from "../src/data";

const mkDim = (id: string, record: Array<{ key: string; label: string }>): MappingDimension => ({
  id,
  dimension: id.toUpperCase(),
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
  referencedDimId: "country",
};

describe("useLinkedCandidates", () => {
  test("resolves candidates for referenced dims", () => {
    const country = mkDim("country", [{ key: "US", label: "United States" }]);
    const { result } = renderHook(() => useLinkedCandidates([linkedField], [country]));
    expect(result.current.get("country")?.candidates).toEqual([
      { key: "US", label: "United States" },
    ]);
  });

  test("identity is STABLE when allDims array is new but referenced dims are unchanged", () => {
    const country = mkDim("country", [{ key: "US", label: "United States" }]);
    const channel = mkDim("channel", [{ key: "seo", label: "SEO" }]);
    const { result, rerender } = renderHook(
      ({ dims }) => useLinkedCandidates([linkedField], dims),
      { initialProps: { dims: [country, channel] } },
    );
    const first = result.current;
    rerender({ dims: [country, { ...channel }] }); // new array + unrelated dim replaced
    expect(result.current).toBe(first);
  });

  test("identity CHANGES when a referenced dim object is replaced", () => {
    const country = mkDim("country", [{ key: "US", label: "United States" }]);
    const { result, rerender } = renderHook(
      ({ dims }) => useLinkedCandidates([linkedField], dims),
      { initialProps: { dims: [country] } },
    );
    const first = result.current;
    rerender({ dims: [mkDim("country", [{ key: "US", label: "USA" }])] });
    expect(result.current).not.toBe(first);
    expect(result.current.get("country")!.candidates[0]!.label).toBe("USA");
  });

  test("no linked fields → stable empty map", () => {
    const dim = mkDim("country", []);
    const { result, rerender } = renderHook(({ dims }) => useLinkedCandidates([], dims), {
      initialProps: { dims: [dim] },
    });
    const first = result.current;
    rerender({ dims: [{ ...dim }] });
    expect(result.current).toBe(first);
    expect(result.current.size).toBe(0);
  });
});
