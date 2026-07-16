import { describe, it, expect } from "bun:test";
import { normalizeKey, clusterValues } from "./cluster-values.ts";

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
