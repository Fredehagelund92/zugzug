import { describe, it, expect } from "bun:test";
import { normalizeKey } from "./cluster-values.ts";

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
