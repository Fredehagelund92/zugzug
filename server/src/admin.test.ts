import { describe, it, expect } from "bun:test";
import { validateWarehouseName } from "./admin.ts";

describe("validateWarehouseName", () => {
  it("accepts valid names", () => {
    expect(validateWarehouseName("ws_default")).toEqual({ ok: true });
    expect(validateWarehouseName("sportsbook")).toEqual({ ok: true });
    expect(validateWarehouseName("a1b")).toEqual({ ok: true });
  });
  it("rejects names that don't match the charset", () => {
    expect(validateWarehouseName("1leading_digit")).toEqual({
      ok: false,
      reason: expect.any(String),
    });
    expect(validateWarehouseName("UpperCase")).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateWarehouseName("ab")).toEqual({ ok: false, reason: expect.any(String) }); // too short
    expect(validateWarehouseName("")).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateWarehouseName("has space")).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateWarehouseName("with-hyphen")).toEqual({ ok: false, reason: expect.any(String) });
  });
});
