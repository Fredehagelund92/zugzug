import { test, expect } from "bun:test";
import { slug, qid, cq, parseOptions, parseNumberFormat, parseFieldConfig } from "./repo-shared.ts";

/* ---- slug ---- */

test("slug lowercases and replaces non-alphanumeric runs with underscores", () => {
  expect(slug("Hello World")).toBe("hello_world");
});

test("slug strips leading and trailing underscores", () => {
  expect(slug("  foo  ")).toBe("foo");
});

test("slug collapses multiple separators into a single underscore", () => {
  expect(slug("foo--bar!!baz")).toBe("foo_bar_baz");
});

test("slug passes through already-clean identifiers unchanged", () => {
  expect(slug("dim_country")).toBe("dim_country");
});

/* ---- qid ---- */

test("qid wraps identifier in double-quotes", () => {
  expect(qid("my_table")).toBe('"my_table"');
});

test("qid escapes internal double-quotes by doubling them", () => {
  expect(qid('say "hello"')).toBe('"say ""hello"""');
});

test("qid handles identifier with no special characters", () => {
  expect(qid("schema")).toBe('"schema"');
});

/* ---- cq ---- */

test("cq quotes a two-part schema.table display string", () => {
  expect(cq("zugzug.dim_country")).toBe('"zugzug"."dim_country"');
});

test("cq quotes a single-part string (no dot)", () => {
  expect(cq("dim_country")).toBe('"dim_country"');
});

test("cq handles three-part catalog.schema.table", () => {
  expect(cq("db.public.users")).toBe('"db"."public"."users"');
});

/* ---- parseOptions ---- */

test("parseOptions parses the new object shape with label and valid palette color", () => {
  const raw = JSON.stringify({ options: [{ label: "Active", color: "mint" }] });
  expect(parseOptions(raw)).toEqual([{ label: "Active", color: "mint" }]);
});

test("parseOptions lifts legacy string items to { label, color: null }", () => {
  const raw = JSON.stringify({ options: ["A", "B"] });
  expect(parseOptions(raw)).toEqual([
    { label: "A", color: null },
    { label: "B", color: null },
  ]);
});

test("parseOptions coerces an invalid palette color to null", () => {
  const raw = JSON.stringify({ options: [{ label: "X", color: "hotpink" }] });
  expect(parseOptions(raw)).toEqual([{ label: "X", color: null }]);
});

test("parseOptions returns undefined for malformed JSON", () => {
  expect(parseOptions("not json")).toBeUndefined();
});

test("parseOptions returns undefined when the wrapper is a bare array (no options key)", () => {
  const raw = JSON.stringify(["A", "B"]);
  expect(parseOptions(raw)).toBeUndefined();
});

test("parseOptions returns undefined when options value is not an array", () => {
  const raw = JSON.stringify({ options: "bad" });
  expect(parseOptions(raw)).toBeUndefined();
});

test("parseOptions accepts a pre-parsed object (not a string)", () => {
  const raw = { options: [{ label: "Yes", color: "rose" }] };
  expect(parseOptions(raw)).toEqual([{ label: "Yes", color: "rose" }]);
});

/* ---- parseNumberFormat ---- */

test("parseNumberFormat parses a valid integer format", () => {
  const raw = JSON.stringify({ numberFormat: { format: "integer" } });
  expect(parseNumberFormat(raw)).toEqual({ format: "integer" });
});

test("parseNumberFormat parses a currency format with all sub-fields", () => {
  const raw = JSON.stringify({
    numberFormat: { format: "currency", symbol: "$", position: "prefix", precision: 2 },
  });
  expect(parseNumberFormat(raw)).toEqual({
    format: "currency",
    symbol: "$",
    position: "prefix",
    precision: 2,
  });
});

test("parseNumberFormat returns undefined for malformed JSON", () => {
  expect(parseNumberFormat("{broken")).toBeUndefined();
});

test("parseNumberFormat returns undefined when format value is unknown", () => {
  const raw = JSON.stringify({ numberFormat: { format: "hex" } });
  expect(parseNumberFormat(raw)).toBeUndefined();
});

test("parseNumberFormat returns undefined when numberFormat key is missing", () => {
  const raw = JSON.stringify({ something: "else" });
  expect(parseNumberFormat(raw)).toBeUndefined();
});

/* ---- parseFieldConfig ---- */

test("parseFieldConfig type=select parses options from JSON string", () => {
  const raw = JSON.stringify({ options: [{ label: "Open", color: "teal" }] });
  const result = parseFieldConfig("select", raw);
  expect(result.options).toEqual([{ label: "Open", color: "teal" }]);
});

test("parseFieldConfig type=number parses numberFormat", () => {
  const raw = JSON.stringify({ numberFormat: { format: "decimal", precision: 2 } });
  const result = parseFieldConfig("number", raw);
  expect(result.numberFormat).toEqual({ format: "decimal", precision: 2 });
});

test("parseFieldConfig type=rating defaults ratingMax to 5 when absent", () => {
  expect(parseFieldConfig("rating", null).ratingMax).toBe(5);
});

test("parseFieldConfig type=rating uses explicit ratingMax when provided", () => {
  const raw = JSON.stringify({ ratingMax: 10 });
  expect(parseFieldConfig("rating", raw).ratingMax).toBe(10);
});

test("parseFieldConfig type=linked defaults displayFields to ['label'] when absent", () => {
  const raw = JSON.stringify({ targetDimId: "dim-abc" });
  const result = parseFieldConfig("linked", raw);
  expect(result.referencedDimId).toBe("dim-abc");
  expect(result.displayFields).toEqual(["label"]);
});

test("parseFieldConfig type=linked uses provided displayFields", () => {
  const raw = JSON.stringify({ targetDimId: "dim-xyz", displayFields: ["name", "code"] });
  const result = parseFieldConfig("linked", raw);
  expect(result.displayFields).toEqual(["name", "code"]);
});

test("parseFieldConfig extracts rules alongside type-specific config", () => {
  const rule = { field: "status", operator: "eq", value: "active", color: "mint" };
  const raw = JSON.stringify({ options: [{ label: "Active", color: null }], rules: [rule] });
  const result = parseFieldConfig("select", raw);
  expect(result.rules).toEqual([rule]);
});

test("parseFieldConfig extracts required flag when true", () => {
  const raw = JSON.stringify({ required: true });
  expect(parseFieldConfig("text", raw).required).toBe(true);
});

test("parseFieldConfig omits required when false", () => {
  const raw = JSON.stringify({ required: false });
  expect(parseFieldConfig("text", raw).required).toBeUndefined();
});

test("parseFieldConfig returns empty object for unknown type with no config", () => {
  expect(parseFieldConfig("text", null)).toEqual({});
});
