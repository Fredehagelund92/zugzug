// test/dashboard-helpers.test.ts
import { test, expect, describe } from "vitest";
import type { MappingRefTable } from "../src/data";
import type { AuditEntry } from "../src/store";
import {
  coveragePct,
  urgencyScore,
  lastAuditForDim,
  warehouseSyncStatusByDim,
  applyFilter,
  applySort,
  formatTimeAgo,
} from "../src/routes/dashboard-helpers";

// ── minimal fixtures ──────────────────────────────────────────────────────────

const cleanDim: MappingRefTable = {
  id: "post_type",
  refTable: "Post Type",
  dimTable: "zugzug.dim_post_type",
  mapTable: "zugzug.map_post_type",
  keyCol: "post_type",
  rows: 100,
  record: [],
  counts: {
    newCount: 0,
    mappedCount: 2,
    totalDistinct: 2,
    unmappedRowsTotal: 0,
    mappedRowsTotal: 100,
    scannedAt: null,
  },
};

const dirtyDim: MappingRefTable = {
  id: "country",
  refTable: "Country",
  dimTable: "zugzug.dim_country",
  mapTable: "zugzug.map_country",
  keyCol: "country_code",
  rows: 500,
  record: [],
  counts: {
    newCount: 2,
    mappedCount: 2,
    totalDistinct: 4,
    unmappedRowsTotal: 500,
    mappedRowsTotal: 500,
    scannedAt: null,
  },
};

const emptyDim: MappingRefTable = {
  id: "empty",
  refTable: "Empty",
  dimTable: "zugzug.dim_empty",
  mapTable: "zugzug.map_empty",
  keyCol: "id",
  rows: 0,
  record: [],
  counts: {
    newCount: 0,
    mappedCount: 0,
    totalDistinct: 0,
    unmappedRowsTotal: 0,
    mappedRowsTotal: 0,
    scannedAt: null,
  },
};

const auditLog: AuditEntry[] = [
  {
    id: "1",
    at: "1h ago",
    user: { id: "u1", name: "Alice", initials: "AL" },
    action: "committed",
    detail: "3 values in Country",
  },
  {
    id: "2",
    at: "2h ago",
    user: { id: "u2", name: "Bob", initials: "BO" },
    action: "renamed",
    detail: "TWEET → Tweet in post_type",
  },
  {
    id: "3",
    at: "3h ago",
    user: { id: "u1", name: "Alice", initials: "AL" },
    action: "added",
    detail: "California to US State",
  },
];

// ── coveragePct ───────────────────────────────────────────────────────────────

describe("coveragePct", () => {
  test("returns 100 for empty values array", () => {
    expect(coveragePct(emptyDim)).toBe(100);
  });
  test("returns 100 when all values are mapped", () => {
    expect(coveragePct(cleanDim)).toBe(100);
  });
  test("returns 50 when half are mapped", () => {
    expect(coveragePct(dirtyDim)).toBe(50);
  });
  test("rounds down", () => {
    // 2 mapped / 5 total = 40%
    const d = { ...dirtyDim, counts: { ...dirtyDim.counts, newCount: 3, totalDistinct: 5 } };
    expect(coveragePct(d)).toBe(40);
  });
});

// ── urgencyScore ──────────────────────────────────────────────────────────────

describe("urgencyScore", () => {
  test("clean refTable has urgencyScore 0", () => {
    expect(urgencyScore(cleanDim)).toBe(0);
  });
  test("refTable with new values scores higher than clean refTable", () => {
    expect(urgencyScore(dirtyDim)).toBeGreaterThan(urgencyScore(cleanDim));
  });
  test("more new values = higher score", () => {
    const oneNew: MappingRefTable = { ...dirtyDim, counts: { ...dirtyDim.counts, newCount: 1 } };
    expect(urgencyScore(dirtyDim)).toBeGreaterThan(urgencyScore(oneNew));
  });
  test("staged clean refTable scores above clean unstaged refTable", () => {
    expect(urgencyScore(cleanDim, true)).toBeGreaterThan(urgencyScore(cleanDim, false));
  });
  test("any refTable with one new value outranks a staged-only refTable", () => {
    const oneNew: MappingRefTable = { ...dirtyDim, counts: { ...dirtyDim.counts, newCount: 1 } };
    expect(urgencyScore(oneNew, false)).toBeGreaterThan(urgencyScore(cleanDim, true));
  });
});

// ── lastAuditForDim ───────────────────────────────────────────────────────────

describe("lastAuditForDim", () => {
  test("finds entry whose detail contains the refTable name", () => {
    const entry = lastAuditForDim("country", "Country", auditLog);
    expect(entry?.id).toBe("1");
  });
  test("finds entry whose detail contains the refTable id (fallback)", () => {
    const entry = lastAuditForDim("post_type", "Sprout Post Type", auditLog);
    expect(entry?.id).toBe("2");
  });
  test("returns null when no entry matches", () => {
    expect(lastAuditForDim("verticals", "Vertical", auditLog)).toBeNull();
  });
  test("is case-insensitive", () => {
    expect(lastAuditForDim("COUNTRY", "COUNTRY", auditLog)).not.toBeNull();
  });
});

// ── applyFilter ───────────────────────────────────────────────────────────────

describe("applyFilter", () => {
  test("'all' returns all refTables", () => {
    expect(applyFilter([cleanDim, dirtyDim], "all")).toHaveLength(2);
  });
  test("'attention' returns refTables with new values", () => {
    const result = applyFilter([cleanDim, dirtyDim], "attention");
    expect(result.map((d) => d.id)).toEqual(["country"]);
  });
  test("'attention' includes refTables with pending publish (toPublishCount > 0)", () => {
    const withPublish = {
      ...cleanDim,
      publish: {
        version: 1,
        publishedAt: null,
        publishedByName: null,
        pendingDrafts: 1,
        changedRecords: 0,
      },
    };
    const result = applyFilter([withPublish, dirtyDim], "attention");
    expect(result.map((d) => d.id)).toContain("post_type");
  });
  test("'clean' excludes refTables with new values", () => {
    const result = applyFilter([cleanDim, dirtyDim], "clean");
    expect(result.map((d) => d.id)).toEqual(["post_type"]);
  });
  test("'clean' excludes refTables with pending publish", () => {
    const withPublish = {
      ...cleanDim,
      publish: {
        version: 1,
        publishedAt: null,
        publishedByName: null,
        pendingDrafts: 1,
        changedRecords: 0,
      },
    };
    const result = applyFilter([withPublish, dirtyDim], "clean");
    expect(result).toHaveLength(0);
  });
  test("'clean' includes truly clean refTables", () => {
    const result = applyFilter([cleanDim, dirtyDim], "clean");
    expect(result.map((d) => d.id)).toEqual(["post_type"]);
  });
});

// ── applySort ─────────────────────────────────────────────────────────────────

describe("applySort", () => {
  test("'review' desc puts refTable with most in-review first", () => {
    const result = applySort([cleanDim, dirtyDim], "review", "desc");
    expect(result[0].id).toBe("country");
  });
  test("'coverage' asc puts worst coverage first", () => {
    const result = applySort([cleanDim, dirtyDim], "coverage", "asc");
    expect(result[0].id).toBe("country"); // 50% < 100%
  });
  test("'name' asc sorts alphabetically", () => {
    const result = applySort([dirtyDim, cleanDim], "name", "asc");
    expect(result[0].id).toBe("country"); // "Country" < "Post Type"
  });
  test("'records' desc puts highest record count first", () => {
    const result = applySort([cleanDim, dirtyDim], "records", "desc");
    // cleanDim has record=[], dirtyDim has record=[] too → tie; order preserved
    expect(result).toHaveLength(2);
  });
  test("does not mutate the input array", () => {
    const input = [cleanDim, dirtyDim];
    applySort(input, "review", "desc");
    expect(input[0].id).toBe("post_type");
  });
});

describe("warehouseSyncStatusByDim", () => {
  test("latest event per refTable wins", () => {
    const audits: AuditEntry[] = [
      // newest first
      {
        id: "1",
        at: "now",
        user: { id: "u", name: "U", initials: "U" },
        action: "Warehouse sync failed",
        detail: "1 → zugzug.map_country: timeout",
      },
      {
        id: "2",
        at: "1m",
        user: { id: "u", name: "U", initials: "U" },
        action: "Warehouse synced",
        detail: "5 → zugzug.map_partner",
      },
      {
        id: "3",
        at: "2m",
        user: { id: "u", name: "U", initials: "U" },
        action: "Warehouse synced",
        detail: "3 → zugzug.map_country",
      },
    ];
    const refTables = [
      { id: "country", mapTable: "zugzug.map_country" },
      { id: "partner", mapTable: "zugzug.map_partner" },
      { id: "channel", mapTable: "zugzug.map_channel" }, // no events
    ];
    expect(warehouseSyncStatusByDim(audits, refTables)).toEqual({
      country: "failed",
      partner: "synced",
      channel: "unknown",
    });
  });

  test("no warehouse events leaves all refTables unknown", () => {
    const audits: AuditEntry[] = [
      {
        id: "1",
        at: "now",
        user: { id: "u", name: "U", initials: "U" },
        action: "Committed",
        detail: "1 value → zugzug.map_country",
      },
    ];
    const refTables = [{ id: "country", mapTable: "zugzug.map_country" }];
    expect(warehouseSyncStatusByDim(audits, refTables)).toEqual({
      country: "unknown",
    });
  });
});

describe("formatTimeAgo", () => {
  test("passes non-ISO strings through unchanged (e.g. already-formatted)", () => {
    expect(formatTimeAgo("1m ago")).toBe("1m ago");
    expect(formatTimeAgo("just now")).toBe("just now");
  });
  test("renders an old ISO timestamp as a friendly date, never raw ISO", () => {
    const out = formatTimeAgo("2020-03-05T12:00:00.000Z");
    // No ISO artifacts (the "T" separator, the "Z" zone, or the HH:MM colons),
    // regardless of the runtime locale.
    expect(out).not.toContain("T");
    expect(out).not.toContain("Z");
    expect(out).not.toContain(":");
    expect(out).not.toContain("2020-03-05");
  });
});
