import { describe, it, expect } from "vitest";
import { classifySource, sortByUrgency, summarizeSources } from "./source-status";
import type { SourceInfo } from "../store";

const NOW = new Date("2026-07-16T00:00:00Z").getTime();
const DAY = 86_400_000;

function src(over: Partial<SourceInfo> = {}): SourceInfo {
  return {
    table: "orders",
    column: "ship_country",
    dimension: "Country",
    dimId: "d1",
    present: true,
    rows: 1000,
    values: 10,
    unmapped: 0,
    scanned: true,
    scannedAt: new Date(NOW - DAY).toISOString(), // 1 day ago = fresh
    ...over,
  };
}

describe("classifySource", () => {
  it("broken: scanned but the column no longer exists", () => {
    expect(classifySource(src({ present: false, scanned: true }), NOW).status).toBe("broken");
  });
  it("new: has unmapped values (fresh or stale)", () => {
    expect(classifySource(src({ unmapped: 5 }), NOW).status).toBe("new");
    const staleNew = classifySource(
      src({ unmapped: 5, scannedAt: new Date(NOW - 30 * DAY).toISOString() }),
      NOW,
    );
    expect(staleNew.status).toBe("new");
    expect(staleNew.stale).toBe(true); // drives the "counts may be stale" note
  });
  it("stale (not checked recently): never scanned, or resolved but overdue", () => {
    expect(classifySource(src({ scanned: false, scannedAt: null }), NOW).status).toBe("stale");
    expect(
      classifySource(src({ unmapped: 0, scannedAt: new Date(NOW - 30 * DAY).toISOString() }), NOW)
        .status,
    ).toBe("stale");
  });
  it("healthy: resolved and freshly scanned", () => {
    expect(classifySource(src(), NOW).status).toBe("healthy");
  });
});

describe("sortByUrgency", () => {
  it("orders broken > new > stale > healthy, then by unmapped desc", () => {
    const out = sortByUrgency(
      [
        src({ column: "a", unmapped: 0 }), // healthy
        src({ column: "b", present: false, scanned: true }), // broken
        src({ column: "c", unmapped: 3 }), // new (3)
        src({ column: "d", unmapped: 9 }), // new (9)
        src({ column: "e", scanned: false, scannedAt: null }), // stale
      ],
      NOW,
    );
    expect(out.map((o) => o.source.column)).toEqual(["b", "d", "c", "e", "a"]);
  });
});

describe("summarizeSources", () => {
  it("counts per status and sums new values", () => {
    const s = summarizeSources(
      [
        src({ unmapped: 4 }),
        src({ unmapped: 6 }),
        src({ present: false, scanned: true }),
        src({ unmapped: 0 }),
      ],
      NOW,
    );
    expect(s).toEqual({
      total: 4,
      broken: 1,
      needsMapping: 2,
      notChecked: 0,
      healthy: 1,
      newValuesTotal: 10,
    });
  });
});
