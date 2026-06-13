import { describe, expect, it } from "vitest";
import { can, type Action } from "./permissions";
import type { TenantContextValue } from "./tenant-context";

function ctx(role: "admin" | "editor" | "viewer", isSuperAdmin = false): TenantContextValue {
  return { id: "t1", slug: "t1", label: "T1", color: null, role, isSuperAdmin };
}

const EDIT_ACTIONS: Action[] = [
  "settings.general.edit",
  "settings.members.edit",
  "settings.tokens.edit",
  "settings.tokens.view",
  "settings.scans.edit",
  "settings.matching.edit",
  "settings.danger.delete",
];

describe("can()", () => {
  it("super-admin viewer can perform every workspace edit action", () => {
    const t = ctx("viewer", true);
    for (const a of EDIT_ACTIONS) {
      expect(can(t, a), `super-admin should be able to ${a}`).toBe(true);
    }
  });

  it("super-admin editor can perform admin-only edits", () => {
    const t = ctx("editor", true);
    expect(can(t, "settings.general.edit")).toBe(true);
    expect(can(t, "settings.members.edit")).toBe(true);
    expect(can(t, "settings.danger.delete")).toBe(true);
  });

  it("non-super-admin viewer cannot perform edit actions", () => {
    const t = ctx("viewer", false);
    for (const a of EDIT_ACTIONS) {
      expect(can(t, a), `viewer should not be able to ${a}`).toBe(false);
    }
  });

  it("admin role still grants admin actions without super-admin flag", () => {
    const t = ctx("admin", false);
    expect(can(t, "settings.general.edit")).toBe(true);
    expect(can(t, "settings.danger.delete")).toBe(true);
  });

  it("admin.view requires the super-admin flag", () => {
    expect(can(ctx("admin", false), "admin.view")).toBe(false);
    expect(can(ctx("viewer", true), "admin.view")).toBe(true);
  });
});
