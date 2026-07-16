import { describe, it, expect } from "vitest";
import { pendingClusters, siblingSuggestion } from "./cluster-selection";
import type { Cluster, ClusterMember } from "./use-dim-clusters";
import type { CandidateRecord } from "./cluster-candidates";

const RECORDS: CandidateRecord[] = [
  { key: "us", label: "United States" },
  { key: "de", label: "Germany" },
];

function member(raw: string, rows: number, isMapped = false, mappedLabel: string | null = null): ClusterMember {
  return { raw, rows, isMapped, mappedLabel, occurrences: [] };
}
function cluster(key: string, members: ClusterMember[]): Cluster {
  return {
    key,
    rep: members[0].raw,
    members,
    rows: members.reduce((s, m) => s + m.rows, 0),
    mappedCount: members.filter((m) => m.isMapped).length,
  };
}

describe("pendingClusters", () => {
  it("keeps clusters with at least one unmapped member, drops fully-mapped ones", () => {
    const partly = cluster("usa", [member("USA", 100), member("U.S.A.", 50, true, "United States")]);
    const done = cluster("ger", [member("Germany", 30, true, "Germany")]);
    const out = pendingClusters([partly, done]);
    expect(out.map((c) => c.key)).toEqual(["usa"]);
  });

  it("preserves input order (worst-first is already applied upstream)", () => {
    const a = cluster("a", [member("a", 10)]);
    const b = cluster("b", [member("b", 5)]);
    expect(pendingClusters([a, b]).map((c) => c.key)).toEqual(["a", "b"]);
  });
});

describe("siblingSuggestion", () => {
  it("returns the record a mapped sibling was mapped to", () => {
    const c = cluster("usa", [member("USA", 100), member("U.S.A.", 50, true, "United States")]);
    expect(siblingSuggestion(c, RECORDS)).toEqual({ key: "us", label: "United States" });
  });

  it("uses the highest-rows mapped sibling when several are mapped", () => {
    const c = cluster("x", [
      member("a", 100, true, "Germany"),
      member("b", 200, true, "United States"),
    ]);
    // "b" has the most rows (200), so its record (United States) wins, regardless of order.
    expect(siblingSuggestion(c, RECORDS)).toEqual({ key: "us", label: "United States" });
  });

  it("returns null when no member is mapped", () => {
    const c = cluster("usa", [member("USA", 100), member("U.S.A.", 50)]);
    expect(siblingSuggestion(c, RECORDS)).toBeNull();
  });

  it("returns null when the mapped label matches no known record", () => {
    const c = cluster("usa", [member("USA", 100, true, "Atlantis")]);
    expect(siblingSuggestion(c, RECORDS)).toBeNull();
  });
});
