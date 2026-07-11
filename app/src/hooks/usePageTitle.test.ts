import { describe, it, expect } from "vitest";
import { formatPageTitle } from "./usePageTitle";

describe("formatPageTitle", () => {
  it("suffixes the app name", () => {
    expect(formatPageTitle("Review")).toBe("Review · Zug Zug");
  });
  it("trims whitespace", () => {
    expect(formatPageTitle("  Tables ")).toBe("Tables · Zug Zug");
  });
});
