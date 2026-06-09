// test/dashboard-helpers.test.ts
import { test, expect, describe } from "vitest";
import type { MappingDimension } from "../src/data";
import type { AuditEntry } from "../src/store";
import {
  coveragePct,
  urgencyScore,
  coverageColor,
  lastAuditForDim,
  warehouseSyncStatusByDim,
  applyFilter,
  applySort,
} from "../src/routes/dashboard-helpers";

// ── minimal fixtures ──────────────────────────────────────────────────────────

const cleanDim: MappingDimension = {
  id: "post_type",
  dimension: "Post Type",
  dimTable: "zugzug.dim_post_type",
  mapTable: "zugzug.map_post_type",
  keyCol: "post_type",
  rows: 100,
  canonical: [],
  values: [
    { value: "A", status: "mapped", current: "A", suggestion: null, confidence: 0, sources: [] },
    { value: "B", status: "mapped", current: "B", suggestion: null, confidence: 0, sources: [] },
  ],
};

const dirtyDim: MappingDimension = {
  id: "country",
  dimension: "Country",
  dimTable: "zugzug.dim_country",
  mapTable: "zugzug.map_country",
  keyCol: "country_code",
  rows: 500,
  canonical: [],
  values: [
    { value: "US", status: "mapped", current: "US", suggestion: null, confidence: 0, sources: [] },
    { value: "GB", status: "mapped", current: "GB", suggestion: null, confidence: 0, sources: [] },
    { value: "XX", status: "new", current: null, suggestion: null, confidence: 0, sources: [] },
    { value: "YY", status: "new", current: null, suggestion: null, confidence: 0, sources: [] },
  ],
};

const emptyDim: MappingDimension = {
  id: "empty",
  dimension: "Empty",
  dimTable: "zugzug.dim_empty",
  mapTable: "zugzug.map_empty",
  keyCol: "id",
  rows: 0,
  canonical: [],
  values: [],
};

const auditLog: AuditEntry[] = [
  { id: "1", at: "1h ago", user: { id: "u1", name: "Alice", initials: "AL" }, action: "committed", detail: "3 values in Country" },
  { id: "2", at: "2h ago", user: { id: "u2", name: "Bob", initials: "BO" }, action: "renamed", detail: "TWEET → Tweet in post_type" },
  { id: "3", at: "3h ago", user: { id: "u1", name: "Alice", initials: "AL" }, action: "added", detail: "California to US State" },
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
    const d = { ...dirtyDim, values: [...dirtyDim.values, { value: "ZZ", status: "new" as const, current: null, suggestion: null, confidence: 0, sources: [] }] };
    // 2 mapped / 5 total = 40%
    expect(coveragePct(d)).toBe(40);
  });
});

// ── urgencyScore ──────────────────────────────────────────────────────────────

describe("urgencyScore", () => {
  test("clean dim has urgencyScore 0", () => {
    expect(urgencyScore(cleanDim)).toBe(0);
  });
  test("dim with new values scores higher than clean dim", () => {
    expect(urgencyScore(dirtyDim)).toBeGreaterThan(urgencyScore(cleanDim));
  });
  test("more new values = higher score", () => {
    const oneNew: MappingDimension = { ...dirtyDim, values: [dirtyDim.values[0], dirtyDim.values[2]] };
    expect(urgencyScore(dirtyDim)).toBeGreaterThan(urgencyScore(oneNew));
  });
});

// ── coverageColor ─────────────────────────────────────────────────────────────

describe("coverageColor", () => {
  test("96+ → ok color", () => {
    expect(coverageColor(96)).toBe("var(--ak-ok)");
    expect(coverageColor(100)).toBe("var(--ak-ok)");
  });
  test("80–95 → warn color", () => {
    expect(coverageColor(80)).toBe("var(--ak-warn)");
    expect(coverageColor(95)).toBe("var(--ak-warn)");
  });
  test("below 80 → accent color", () => {
    expect(coverageColor(79)).toBe("var(--accent)");
    expect(coverageColor(0)).toBe("var(--accent)");
  });
});

// ── lastAuditForDim ───────────────────────────────────────────────────────────

describe("lastAuditForDim", () => {
  test("finds entry whose detail contains the dimension name", () => {
    const entry = lastAuditForDim("country", "Country", auditLog);
    expect(entry?.id).toBe("1");
  });
  test("finds entry whose detail contains the dim id (fallback)", () => {
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
  const staged = new Set(["post_type"]);

  test("'all' returns all dims", () => {
    expect(applyFilter([cleanDim, dirtyDim], "all", staged)).toHaveLength(2);
  });
  test("'attention' returns dims with new values", () => {
    const result = applyFilter([cleanDim, dirtyDim], "attention", new Set());
    expect(result.map((d) => d.id)).toEqual(["country"]);
  });
  test("'attention' also includes staged dims", () => {
    const result = applyFilter([cleanDim, dirtyDim], "attention", staged);
    expect(result.map((d) => d.id)).toContain("post_type");
  });
  test("'clean' excludes dims with new values and staged dims", () => {
    const result = applyFilter([cleanDim, dirtyDim], "clean", staged);
    expect(result).toHaveLength(0);
  });
  test("'clean' includes truly clean dims", () => {
    const result = applyFilter([cleanDim, dirtyDim], "clean", new Set());
    expect(result.map((d) => d.id)).toEqual(["post_type"]);
  });
});

// ── applySort ─────────────────────────────────────────────────────────────────

describe("applySort", () => {
  test("'urgency' puts dirty dim first", () => {
    const result = applySort([cleanDim, dirtyDim], "urgency");
    expect(result[0].id).toBe("country");
  });
  test("'coverage' puts worst coverage first", () => {
    const result = applySort([cleanDim, dirtyDim], "coverage");
    expect(result[0].id).toBe("country"); // 50% < 100%
  });
  test("'name' sorts alphabetically", () => {
    const result = applySort([dirtyDim, cleanDim], "name");
    expect(result[0].id).toBe("country"); // "Country" < "Post Type"
  });
  test("'rows' puts highest row count first", () => {
    const result = applySort([cleanDim, dirtyDim], "rows");
    expect(result[0].id).toBe("country"); // 500 > 100
  });
  test("does not mutate the input array", () => {
    const input = [cleanDim, dirtyDim];
    applySort(input, "urgency");
    expect(input[0].id).toBe("post_type");
  });
});

describe("warehouseSyncStatusByDim", () => {
  test("latest event per dim wins", () => {
    const audits: AuditEntry[] = [
      // newest first
      { id: "1", at: "now", user: { id: "u", name: "U", initials: "U" }, action: "Warehouse sync failed", detail: "1 → zugzug.map_country: timeout" },
      { id: "2", at: "1m", user: { id: "u", name: "U", initials: "U" }, action: "Warehouse synced", detail: "5 → zugzug.map_partner" },
      { id: "3", at: "2m", user: { id: "u", name: "U", initials: "U" }, action: "Warehouse synced", detail: "3 → zugzug.map_country" },
    ];
    const dims = [
      { id: "country", mapTable: "zugzug.map_country" },
      { id: "partner", mapTable: "zugzug.map_partner" },
      { id: "channel", mapTable: "zugzug.map_channel" }, // no events
    ];
    expect(warehouseSyncStatusByDim(audits, dims)).toEqual({
      country: "failed",
      partner: "synced",
      channel: "unknown",
    });
  });

  test("no warehouse events leaves all dims unknown", () => {
    const audits: AuditEntry[] = [
      { id: "1", at: "now", user: { id: "u", name: "U", initials: "U" }, action: "Committed", detail: "1 value → zugzug.map_country" },
    ];
    const dims = [{ id: "country", mapTable: "zugzug.map_country" }];
    expect(warehouseSyncStatusByDim(audits, dims)).toEqual({
      country: "unknown",
    });
  });
});
