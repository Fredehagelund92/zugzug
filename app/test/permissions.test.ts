import { describe, expect, test } from "vitest";
import { can, type Action } from "../src/lib/permissions";
import type { TenantContextValue } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";

function t(role: "admin" | "editor" | "viewer", isSuperAdmin = false): TenantContextValue {
  return tenantFixture(role, { isSuperAdmin });
}

/* The client half of the role→route matrix in server/test/rbac-http.test.ts,
 * expressed against the capability payload each role is served:
 *   viewer  []
 *   editor  curate, commit, manage_tables
 *   admin   + manage_workspace, manage_integrations
 * Preferences (thresholds, scan schedule) are a workspace setting — PUT
 * /api/preferences requires manage_workspace, so an editor gets a read-only
 * page rather than controls that 403. Creating tables and running scans are
 * editor capabilities. */
const MATRIX: Record<Action, Record<"viewer" | "editor" | "admin", boolean>> = {
  "account.profile.edit": { viewer: true, editor: true, admin: true },
  "settings.general.view": { viewer: true, editor: true, admin: true },
  "settings.general.edit": { viewer: false, editor: false, admin: true },
  "settings.members.view": { viewer: true, editor: true, admin: true },
  "settings.members.edit": { viewer: false, editor: false, admin: true },
  "settings.scans.view": { viewer: true, editor: true, admin: true },
  "settings.scans.edit": { viewer: false, editor: false, admin: true },
  "settings.matching.view": { viewer: true, editor: true, admin: true },
  "settings.matching.edit": { viewer: false, editor: false, admin: true },
  "settings.warehouse.view": { viewer: true, editor: true, admin: true },
  "settings.audit.view": { viewer: true, editor: true, admin: true },
  "settings.danger.leave": { viewer: true, editor: true, admin: true },
  "settings.danger.delete": { viewer: false, editor: false, admin: true },
  "integrations.pull_api.view": { viewer: true, editor: true, admin: true },
  "integrations.webhooks.view": { viewer: false, editor: true, admin: true },
  "integrations.webhooks.delivery_payload_view": { viewer: false, editor: true, admin: true },
  "integrations.webhooks.edit": { viewer: false, editor: false, admin: true },
  "integrations.service_accounts.view": { viewer: false, editor: false, admin: true },
  "integrations.service_accounts.edit": { viewer: false, editor: false, admin: true },
  "admin.view": { viewer: false, editor: false, admin: false },
  "table.create": { viewer: false, editor: true, admin: true },
  "table.scan": { viewer: false, editor: true, admin: true },
  "table.rollback": { viewer: false, editor: false, admin: true },
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
    expect(can(t("viewer", true), "settings.general.edit")).toBe(true);
  });

  // The point of the rewrite: can() reads the served capability list, it does
  // not re-derive anything from the role name.
  test("capabilities decide, not the role label", () => {
    const demoted: TenantContextValue = tenantFixture("admin", { capabilities: ["curate"] });
    expect(can(demoted, "settings.general.edit")).toBe(false);
    expect(can(demoted, "table.create")).toBe(false);
    expect(can(demoted, "integrations.webhooks.view")).toBe(true);

    const promoted: TenantContextValue = tenantFixture("viewer", {
      capabilities: ["curate", "commit", "manage_tables"],
    });
    expect(can(promoted, "table.create")).toBe(true);
    expect(can(promoted, "table.scan")).toBe(true);
    expect(can(promoted, "settings.matching.edit")).toBe(false);
  });
});
