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
