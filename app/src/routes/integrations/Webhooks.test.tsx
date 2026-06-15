import { describe, it, expect } from "vitest";
import { computeDuplicateUrlSet } from "./Webhooks";

describe("duplicate URL detection", () => {
  it("is symmetric — both rows flagged when two share a URL", () => {
    const set = computeDuplicateUrlSet([
      { id: "a", url: "https://x" },
      { id: "b", url: "https://x" },
      { id: "c", url: "https://y" },
    ]);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(false);
  });

  it("normalises trailing slash and case for host", () => {
    const set = computeDuplicateUrlSet([
      { id: "a", url: "https://X.com/zz" },
      { id: "b", url: "https://x.com/zz/" },
    ]);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
  });
});
