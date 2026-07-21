import { describe, it, expect } from "bun:test";
import { normalizeKey, clusterValues, clusterScanRows, clusterForSeed } from "./cluster-values.ts";
import type { ScanValueRow } from "./repo-dim-scan.ts";

function scanRow(
  raw: string,
  totalRows: number,
  isMapped = false,
  mappedLabel: string | null = null,
): ScanValueRow {
  return {
    raw,
    totalRows,
    isMapped,
    mappedLabel,
    occurrences: [{ table: "orders", column: "ship_country", rows: totalRows }],
  };
}

describe("clusterForSeed", () => {
  it("folds case, punctuation and diacritics into one cluster (matches review)", () => {
    const out = clusterForSeed(["USA", "U.S.A.", "usa"]);
    expect(out).toHaveLength(1);
    expect(out[0].rep).toBe("USA"); // first-seen wins the representative
    expect(out[0].raws).toEqual(["USA", "U.S.A.", "usa"]);
  });

  it("merges accented variants", () => {
    expect(clusterForSeed(["Café", "cafe"])).toHaveLength(1);
  });

  it("keeps genuinely different values separate (US vs USA)", () => {
    expect(clusterForSeed(["US", "USA"]).map((c) => c.rep)).toEqual(["US", "USA"]);
  });

  it("never merges punctuation-only values with each other", () => {
    expect(clusterForSeed(["!!!", "???"])).toHaveLength(2);
  });

  it("preserves first-seen order", () => {
    expect(clusterForSeed(["Zeta", "Alpha", "zeta"]).map((c) => c.rep)).toEqual(["Zeta", "Alpha"]);
  });
});

describe("normalizeKey", () => {
  it("folds case, punctuation, and spacing to one key", () => {
    expect(normalizeKey("USA")).toBe("usa");
    expect(normalizeKey("U.S.A.")).toBe("usa");
    expect(normalizeKey("u s a")).toBe("usa");
  });

  it("strips diacritics", () => {
    expect(normalizeKey("Déjà")).toBe("deja");
    expect(normalizeKey("Grande-Bretagne")).toBe("grandebretagne");
  });

  it("keeps genuinely different values apart (US is not USA)", () => {
    expect(normalizeKey("US")).toBe("us");
    expect(normalizeKey("US")).not.toBe(normalizeKey("USA"));
  });

  it("gives punctuation-only values a unique, non-merging key", () => {
    expect(normalizeKey("!!!")).not.toBe(normalizeKey("???"));
    expect(normalizeKey("!!!")).toContain("!!!");
  });
});

describe("clusterValues", () => {
  it("merges values that fold to the same key and keeps others apart", () => {
    const out = clusterValues([
      { raw: "USA", rows: 6200 },
      { raw: "U.S.A.", rows: 3100 },
      { raw: "u.s.a.", rows: 700 },
      { raw: "US", rows: 2000 },
    ]);
    expect(out).toHaveLength(2);

    const usa = out.find((c) => c.key === "usa");
    expect(usa).toBeDefined();
    expect(usa!.members.map((m) => m.raw)).toEqual(["USA", "U.S.A.", "u.s.a."]);
    expect(usa!.rows).toBe(10000);
    expect(usa!.rep).toBe("USA");

    const us = out.find((c) => c.key === "us");
    expect(us!.rows).toBe(2000);
  });

  it("breaks rep and member ties by raw ascending", () => {
    const out = clusterValues([
      { raw: "usa", rows: 5 },
      { raw: "USA", rows: 5 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].rep).toBe("USA");
    expect(out[0].members.map((m) => m.raw)).toEqual(["USA", "usa"]);
  });

  it("sorts clusters by rows descending (worst-impact first)", () => {
    const out = clusterValues([
      { raw: "small", rows: 10 },
      { raw: "big", rows: 9000 },
    ]);
    expect(out.map((c) => c.rep)).toEqual(["big", "small"]);
  });

  it("returns an empty array for empty input", () => {
    expect(clusterValues([])).toEqual([]);
  });
});

describe("clusterScanRows", () => {
  it("clusters scan rows, summing rows and carrying occurrences + mapped state", () => {
    const out = clusterScanRows([
      scanRow("USA", 6200),
      scanRow("U.S.A.", 3100, true, "United States"),
      scanRow("US", 2000),
    ]);
    expect(out).toHaveLength(2);

    const usa = out.find((c) => c.key === "usa");
    expect(usa).toBeDefined();
    expect(usa!.rows).toBe(9300);
    expect(usa!.rep).toBe("USA");
    expect(usa!.mappedCount).toBe(1);
    expect(usa!.members[0].occurrences[0].column).toBe("ship_country");
  });

  it("orders clusters worst-impact first", () => {
    const out = clusterScanRows([scanRow("rare", 12), scanRow("common", 8800)]);
    expect(out.map((c) => c.rep)).toEqual(["common", "rare"]);
  });

  it("returns an empty array for empty input", () => {
    expect(clusterScanRows([])).toEqual([]);
  });
});
