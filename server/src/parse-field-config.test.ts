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
});
