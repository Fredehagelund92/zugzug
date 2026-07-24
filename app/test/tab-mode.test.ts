import { describe, test, expect, beforeEach } from "vitest";
import { readStoredMode, writeStoredMode, foldUrlMode, TAB_MODE_KEY } from "../src/lib/tab-mode";

beforeEach(() => {
  localStorage.clear();
});

describe("tab-mode storage", () => {
  test("default mode is 'records' when nothing stored", () => {
    expect(readStoredMode("a", ["records", "match", "sources"])).toBe("records");
  });
  test("write-through round-trips", () => {
    writeStoredMode("a", "match");
    expect(localStorage.getItem(TAB_MODE_KEY("a"))).toBe("match");
    expect(readStoredMode("a", ["records", "match", "sources"])).toBe("match");
  });
  test("stored mode that's no longer valid falls back to 'records'", () => {
    writeStoredMode("a", "sources");
    expect(readStoredMode("a", ["records", "match"])).toBe("records");
  });
});

describe("foldUrlMode", () => {
  test("URL ?mode= wins over localStorage when valid", () => {
    writeStoredMode("a", "records");
    const url = new URLSearchParams("mode=match");
    expect(foldUrlMode(url, "a", ["records", "match", "sources"])).toBe("match");
  });
  test("URL ?mode= invalid → falls back to localStorage", () => {
    writeStoredMode("a", "match");
    const url = new URLSearchParams("mode=garbage");
    expect(foldUrlMode(url, "a", ["records", "match"])).toBe("match");
  });
  test("URL ?mode= not present → falls back to localStorage", () => {
    writeStoredMode("a", "sources");
    expect(foldUrlMode(new URLSearchParams(""), "a", ["records", "match", "sources"])).toBe(
      "sources",
    );
  });
});
