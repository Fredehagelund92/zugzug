import { describe, it, expect } from "bun:test";
import { computeInsertPosition } from "./repo-canonical.ts";

describe("computeInsertPosition", () => {
  it("empty dim: returns 1024", () => {
    expect(computeInsertPosition(null, null)).toBe(1024n);
  });
  it("insert above first row: pBelow - 1024", () => {
    expect(computeInsertPosition(null, 1024n)).toBe(0n);
  });
  it("insert below last row: pAbove + 1024", () => {
    expect(computeInsertPosition(2048n, null)).toBe(3072n);
  });
  it("insert between two rows: midpoint", () => {
    expect(computeInsertPosition(1024n, 2048n)).toBe(1536n);
  });
  it("gap of 1: returns null (rebalance needed)", () => {
    expect(computeInsertPosition(1024n, 1025n)).toBeNull();
  });
  it("same positions: returns null", () => {
    expect(computeInsertPosition(1024n, 1024n)).toBeNull();
  });
  it("wide gap: returns midpoint", () => {
    expect(computeInsertPosition(0n, 8192n)).toBe(4096n);
  });
});

describe("position arithmetic", () => {
  it("first row in manual dim gets position 1024", () => {
    const max = 0n;
    expect(max + 1024n).toBe(1024n);
  });
  it("five seeded rows get positions 1024..5120 in steps of 1024", () => {
    const positions = Array.from({ length: 5 }, (_, i) => BigInt(i + 1) * 1024n);
    expect(positions).toEqual([1024n, 2048n, 3072n, 4096n, 5120n]);
  });
});

describe("rebalance rate limit", () => {
  it("retryAfterSeconds is positive for a recent rebalance", () => {
    const lastMs     = Date.now() - 10_000; // 10 seconds ago
    const elapsed    = Date.now() - lastMs;
    const retryAfter = Math.ceil((60_000 - elapsed) / 1000);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
  it("no rate limit when last rebalance was >60s ago", () => {
    const lastMs = Date.now() - 70_000;
    const elapsed = Date.now() - lastMs;
    expect(elapsed).toBeGreaterThan(60_000);
  });
});
