import { describe, expect, test } from "vitest";
import { can, type Action } from "../src/lib/permissions";
import type { TenantContextValue } from "../src/lib/tenant-context";

function t(role: "admin" | "editor" | "viewer", isSuperAdmin = false): TenantContextValue {
  return { id: "t1", slug: "acme", label: "Acme", role, isSuperAdmin };
}

const MATRIX: Record<Action, Record<"viewer" | "editor" | "admin", boolean>> = {
  "account.profile.edit":   { viewer: true,  editor: true,  admin: true },
  "settings.general.view":  { viewer: true,  editor: true,  admin: true },
  "settings.general.edit":  { viewer: false, editor: false, admin: true },
  "settings.members.view":  { viewer: true,  editor: true,  admin: true },
  "settings.members.edit":  { viewer: false, editor: false, admin: true },
  "settings.tokens.view":   { viewer: false, editor: true,  admin: true },
  "settings.tokens.edit":   { viewer: false, editor: false, admin: true },
  "settings.scans.view":    { viewer: true,  editor: true,  admin: true },
  "settings.scans.edit":    { viewer: false, editor: true,  admin: true },
  "settings.matching.view": { viewer: true,  editor: true,  admin: true },
  "settings.matching.edit": { viewer: false, editor: true,  admin: true },
  "settings.warehouse.view":{ viewer: true,  editor: true,  admin: true },
  "settings.audit.view":    { viewer: true,  editor: true,  admin: true },
  "settings.danger.leave":  { viewer: true,  editor: true,  admin: true },
  "settings.danger.delete": { viewer: false, editor: false, admin: true },
  "admin.view":             { viewer: false, editor: false, admin: false },
};

describe("can()", () => {
  for (const [action, byRole] of Object.entries(MATRIX) as [Action, Record<string, boolean>][]) {
    for (const role of ["viewer", "editor", "admin"] as const) {
      test(`${role} → ${action} = ${byRole[role]}`, () => {
        expect(can(t(role), action)).toBe(byRole[role]);
      });
    }
  }

  test("super-admin can do admin.view regardless of workspace role", () => {
    expect(can(t("viewer", true), "admin.view")).toBe(true);
    expect(can(t("editor", true), "admin.view")).toBe(true);
  });

  // Per 2026-06-13 spec Section A.1: super-admin gets every workspace +
  // account affordance regardless of workspace role.
  test("super-admin entering as viewer is elevated for settings edits via tenant context", () => {
    expect(can(t("viewer", true), "settings.tokens.edit")).toBe(true);
  });
});
