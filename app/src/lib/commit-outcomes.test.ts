import { describe, it, expect } from "vitest";
import { summarizeOutcomes, type CommitOutcome } from "./commit-outcomes";

const ok = (refTable: string, n: number): CommitOutcome => ({
  refTableId: refTable,
  refTableName: refTable,
  committed: n,
  rowsRecovered: n * 10,
  error: null,
});
const bad = (refTable: string, err: string): CommitOutcome => ({
  refTableId: refTable,
  refTableName: refTable,
  committed: 0,
  rowsRecovered: 0,
  error: err,
});

describe("summarizeOutcomes", () => {
  it("all success", () => {
    const s = summarizeOutcomes([ok("country", 3), ok("channel", 2)]);
    expect(s.ok).toBe(true);
    expect(s.committed).toBe(5);
    expect(s.failed).toHaveLength(0);
    expect(s.message).toBe("✓ 5 changes published · 50 rows recovered");
  });
  it("partial failure names the failed tables", () => {
    const s = summarizeOutcomes([ok("country", 3), bad("channel", "timeout")]);
    expect(s.ok).toBe(false);
    expect(s.committed).toBe(3);
    expect(s.failed).toHaveLength(1);
    expect(s.message).toBe(
      "Published 3 changes, but channel failed (timeout) — its drafts weren't published.",
    );
  });
  it("singulars", () => {
    expect(summarizeOutcomes([{ ...ok("a", 1), rowsRecovered: 1 }]).message).toBe(
      "✓ 1 change published · 1 row recovered",
    );
  });
  it("multiple failures use 'their'", () => {
    const s = summarizeOutcomes([
      ok("country", 3),
      bad("channel", "timeout"),
      bad("region", "timeout"),
    ]);
    expect(s.ok).toBe(false);
    expect(s.failed).toHaveLength(2);
    expect(s.message).toContain("their drafts weren't published.");
  });
});
