import { describe, it, expect } from "vitest";
import { foldLabel, buildCandidates, type CandidateRecord } from "./cluster-candidates";

const RECORDS: CandidateRecord[] = [
  { key: "us", label: "United States" },
  { key: "gb", label: "United Kingdom" },
  { key: "de", label: "Germany" },
  { key: "fr", label: "France" },
];

describe("foldLabel", () => {
  it("folds case, punctuation, and diacritics", () => {
    expect(foldLabel("United States")).toBe("unitedstates");
    expect(foldLabel("Déjà")).toBe("deja");
    expect(foldLabel("U.S.A.")).toBe("usa");
  });
});

describe("buildCandidates", () => {
  it("with no query, puts the exact fold-match of rep first and marks it closest", () => {
    const out = buildCandidates(RECORDS, "", "united states", 3);
    expect(out[0]).toEqual({ kind: "record", key: "us", label: "United States", closest: true });
    // remaining records fill up to `limit`, none marked closest
    expect(out.filter((c) => c.kind === "record" && c.closest)).toHaveLength(1);
    // a create row is always last
    expect(out[out.length - 1]).toEqual({ kind: "create", label: "united states" });
  });

  it("with no fold-match, returns records (none closest) then a create row for rep", () => {
    const out = buildCandidates(RECORDS, "", "Grande-Bretagne", 2);
    expect(out.some((c) => c.kind === "record" && c.closest)).toBe(false);
    expect(out.filter((c) => c.kind === "record")).toHaveLength(2);
    expect(out[out.length - 1]).toEqual({ kind: "create", label: "Grande-Bretagne" });
  });

  it("with a query, filters records by label/key (case-insensitive) then a create row for the query", () => {
    const out = buildCandidates(RECORDS, "united", "USA", 10);
    const recs = out.filter((c) => c.kind === "record") as Extract<typeof out[number], { kind: "record" }>[];
    expect(recs.map((r) => r.key)).toEqual(["us", "gb"]);
    expect(out[out.length - 1]).toEqual({ kind: "create", label: "united" });
  });
});
