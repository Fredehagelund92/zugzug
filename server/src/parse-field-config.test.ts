import { describe, it, expect } from "bun:test";
import { parseFieldConfig } from "./repo-shared.ts";

describe("parseFieldConfig validation", () => {
  it("reads a validation object with unique + range", () => {
    const raw = JSON.stringify({ required: true, validation: { unique: true, min: 0, max: 100 } });
    const cfg = parseFieldConfig("number", raw);
    expect(cfg.required).toBe(true);
    expect(cfg.validation).toEqual({ unique: true, min: 0, max: 100 });
  });

  it("omits validation when absent", () => {
    expect(parseFieldConfig("text", JSON.stringify({})).validation).toBeUndefined();
  });

  it("drops non-object validation and coerces bad bounds to undefined key", () => {
    const cfg = parseFieldConfig(
      "text",
      JSON.stringify({ validation: { unique: "yes", min: "aa" } }),
    );
    // unique must be a real boolean; string min for text (length) is invalid → dropped
    expect(cfg.validation).toEqual({}); // present but empty when the object exists yet holds no valid keys
  });

  it("floors a fractional text-length bound to a non-negative integer", () => {
    const cfg = parseFieldConfig("text", JSON.stringify({ validation: { min: 3.5 } }));
    expect(cfg.validation?.min).toBe(3);
  });

  it("clamps a negative text-length bound to 0", () => {
    const cfg = parseFieldConfig("text", JSON.stringify({ validation: { min: -2 } }));
    expect(cfg.validation?.min).toBe(0);
  });

  it("does not floor numeric bounds for number type", () => {
    const cfg = parseFieldConfig("number", JSON.stringify({ validation: { min: 1.5 } }));
    expect(cfg.validation?.min).toBe(1.5);
  });
});

describe("parseFieldConfig formula", () => {
  it("reads expr + resultType for a formula field", () => {
    const raw = JSON.stringify({ expr: 'IF(amount > 0, "yes", "no")', resultType: "text" });
    const cfg = parseFieldConfig("formula", raw);
    expect(cfg.formula).toEqual({ expr: 'IF(amount > 0, "yes", "no")', resultType: "text" });
  });

  it("defaults resultType to text when missing or invalid", () => {
    expect(parseFieldConfig("formula", JSON.stringify({ expr: "1" })).formula?.resultType).toBe(
      "text",
    );
    expect(
      parseFieldConfig("formula", JSON.stringify({ expr: "1", resultType: "bogus" })).formula
        ?.resultType,
    ).toBe("text");
  });

  it("keeps numberFormat only for a number result", () => {
    const raw = JSON.stringify({
      expr: "amount * 2",
      resultType: "number",
      numberFormat: { format: "decimal", precision: 2 },
    });
    const cfg = parseFieldConfig("formula", raw);
    expect(cfg.formula?.resultType).toBe("number");
    expect(cfg.formula?.numberFormat).toEqual({ format: "decimal", precision: 2 });
  });

  it("omits formula when expr is empty or missing", () => {
    expect(parseFieldConfig("formula", JSON.stringify({ expr: "  " })).formula).toBeUndefined();
    expect(parseFieldConfig("formula", JSON.stringify({})).formula).toBeUndefined();
  });

  it("does not attach formula config to non-formula types", () => {
    expect(parseFieldConfig("text", JSON.stringify({ expr: "1" })).formula).toBeUndefined();
  });
});
