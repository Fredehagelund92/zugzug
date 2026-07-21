import { describe, it, expect } from "vitest";
import type { MappingDimension } from "../src/data";
import {
  applySort,
  applyFilter,
  toPublishCount,
  type SortKey,
} from "../src/routes/dashboard-helpers";

// Minimal dim factory — only the fields the helpers read.
function dim(p: {
  id: string;
  name: string;
  records: number;
  newCount: number;
  pendingDrafts: number;
  changedRecords: number;
  publishedAt: string | null;
}): MappingDimension {
  return {
    id: p.id,
    dimension: p.name,
    dimTable: `zugzug.dim_${p.id}`,
    mapTable: `zugzug.map_${p.id}`,
    keyCol: "k",
    rows: p.records,
    canonical: Array.from({ length: p.records }, (_, i) => ({
      key: `k${i}`,
      label: `l${i}`,
      version: 1,
    })),
    counts: {
      newCount: p.newCount,
      mappedCount: 0,
      totalDistinct: p.newCount,
      unmappedRowsTotal: 0,
      mappedRowsTotal: 0,
      scannedAt: null,
    },
    publish: {
      version: p.publishedAt ? 3 : 0,
      publishedAt: p.publishedAt,
      publishedByName: null,
      pendingDrafts: p.pendingDrafts,
      changedRecords: p.changedRecords,
    },
  } as MappingDimension;
}

const a = dim({ id: "a", name: "Alpha", records: 10, newCount: 5, pendingDrafts: 1, changedRecords: 1, publishedAt: "2026-07-20T10:00:00Z" });
const b = dim({ id: "b", name: "Bravo", records: 3, newCount: 0, pendingDrafts: 0, changedRecords: 0, publishedAt: "2026-07-21T10:00:00Z" });
const c = dim({ id: "c", name: "Charlie", records: 7, newCount: 2, pendingDrafts: 4, changedRecords: 0, publishedAt: null });
const all = [a, b, c];

const ids = (ds: MappingDimension[]) => ds.map((d) => d.id);

describe("toPublishCount", () => {
  it("sums drafts + edited records", () => {
    expect(toPublishCount(a)).toBe(2);
    expect(toPublishCount(b)).toBe(0);
    expect(toPublishCount(c)).toBe(4);
  });
});

describe("applySort", () => {
  it("review desc puts the most in-review first", () => {
    expect(ids(applySort(all, "review", "desc"))).toEqual(["a", "c", "b"]);
  });
  it("name asc is alphabetical", () => {
    expect(ids(applySort(all, "name", "asc"))).toEqual(["a", "b", "c"]);
  });
  it("toPublish desc ranks by backlog", () => {
    expect(ids(applySort(all, "toPublish", "desc"))).toEqual(["c", "a", "b"]);
  });
  it("published desc is newest-first with never-published (null) last", () => {
    expect(ids(applySort(all, "published", "desc"))).toEqual(["b", "a", "c"]);
  });
  it("published asc keeps never-published (null) last", () => {
    expect(ids(applySort(all, "published", "asc"))).toEqual(["a", "b", "c"]);
  });
  it("never mutates the input array", () => {
    const before = ids(all);
    applySort(all, "records", "desc");
    expect(ids(all)).toEqual(before);
  });
});

describe("applyFilter", () => {
  it("attention = any in-review OR anything to publish", () => {
    expect(ids(applyFilter(all, "attention")).sort()).toEqual(["a", "b", "c"].filter((x) => x !== "b"));
  });
  it("clean = nothing in review AND nothing to publish", () => {
    expect(ids(applyFilter(all, "clean"))).toEqual(["b"]);
  });
});
