import { describe, it, expect } from "bun:test";
import { requireAdmin, type TenantAuthContext } from "./auth.ts";

function ctx(role: "admin" | "editor" | "viewer", isSuperAdmin = false): TenantAuthContext {
  return { tenantId: "t1", role, isSuperAdmin };
}

describe("requireAdmin", () => {
  it("admin role passes", () => {
    expect(requireAdmin(ctx("admin"))).toEqual({ ok: true, elevated: false });
  });
  it("super-admin viewer passes with elevated flag", () => {
    expect(requireAdmin(ctx("viewer", true))).toEqual({ ok: true, elevated: true });
  });
  it("super-admin admin passes with elevated=false (already admin)", () => {
    expect(requireAdmin(ctx("admin", true))).toEqual({ ok: true, elevated: false });
  });
  it("non-admin non-super-admin fails", () => {
    expect(requireAdmin(ctx("editor"))).toEqual({ ok: false });
    expect(requireAdmin(ctx("viewer"))).toEqual({ ok: false });
  });
});
