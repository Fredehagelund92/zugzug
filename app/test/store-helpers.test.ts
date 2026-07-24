import { test, expect, describe } from "vitest";
import { slug, dkey } from "../src/store";

// slug: lowercases, replaces runs of non-alphanumerics with "_", strips
// leading/trailing underscores.
describe("slug", () => {
  test("lowercases and replaces whitespace with underscore", () => {
    expect(slug("Acme Corp")).toBe("acme_corp");
  });
  test("trims surrounding whitespace (leading/trailing underscores stripped)", () => {
    expect(slug("  Trailing Space  ")).toBe("trailing_space");
  });
  test("collapses runs of non-alphanumerics into a single underscore", () => {
    expect(slug("Foo & Bar / Baz")).toBe("foo_bar_baz");
  });
  test("all-lowercase input passes through unchanged", () => {
    expect(slug("hello")).toBe("hello");
  });
  test("returns empty string for all-special-char input", () => {
    expect(slug("---")).toBe("");
  });
});

describe("dkey", () => {
  test("is stable for the same inputs", () => {
    expect(dkey("brand", "ACME")).toBe(dkey("brand", "ACME"));
  });
  test("differs for different refTables", () => {
    expect(dkey("brand", "x")).not.toBe(dkey("channel", "x"));
  });
  test("differs for different raw values", () => {
    expect(dkey("brand", "a")).not.toBe(dkey("brand", "b"));
  });
  test("format is refTableId::raw", () => {
    expect(dkey("dim1", "val1")).toBe("dim1::val1");
  });
});
