import { describe, expect, it } from "vitest";
import { can, type Action } from "./permissions";
import type { TenantContextValue } from "./tenant-context";
import { tenantFixture } from "../../test/tenant-fixture";

function ctx(role: "admin" | "editor" | "viewer", isSuperAdmin = false): TenantContextValue {
  return tenantFixture(role, { isSuperAdmin });
}

const EDIT_ACTIONS: Action[] = [
  "settings.general.edit",
  "settings.members.edit",
  "settings.scans.edit",
  "settings.matching.edit",
  "settings.danger.delete",
  "integrations.webhooks.edit",
  "integrations.service_accounts.edit",
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

describe("table capabilities", () => {
  it("editor and admin can create tables and run scans; viewer cannot", () => {
    for (const a of ["table.create", "table.scan"] as Action[]) {
      expect(can(ctx("viewer"), a)).toBe(false);
      expect(can(ctx("editor"), a)).toBe(true);
      expect(can(ctx("admin"), a)).toBe(true);
    }
  });

  it("rollback stays admin-only", () => {
    expect(can(ctx("editor"), "table.rollback")).toBe(false);
    expect(can(ctx("admin"), "table.rollback")).toBe(true);
  });
});

describe("integrations actions (§9 matrix)", () => {
  const viewer = ctx("viewer");
  const editor = ctx("editor");
  const admin = ctx("admin");

  it("everyone sees the Pull API docs page", () => {
    expect(can(viewer, "integrations.pull_api.view")).toBe(true);
    expect(can(editor, "integrations.pull_api.view")).toBe(true);
    expect(can(admin, "integrations.pull_api.view")).toBe(true);
  });

  // GET /v1/webhooks answers a viewer with 403 editor_required — showing them
  // the page only bought them a permanent skeleton.
  it("editor and admin see the webhooks list; viewer does not", () => {
    expect(can(viewer, "integrations.webhooks.view")).toBe(false);
    expect(can(editor, "integrations.webhooks.view")).toBe(true);
    expect(can(admin, "integrations.webhooks.view")).toBe(true);
  });

  it("viewer cannot see delivery payloads; editor and admin can", () => {
    expect(can(viewer, "integrations.webhooks.delivery_payload_view")).toBe(false);
    expect(can(editor, "integrations.webhooks.delivery_payload_view")).toBe(true);
    expect(can(admin, "integrations.webhooks.delivery_payload_view")).toBe(true);
  });

  it("only admin can edit webhooks", () => {
    expect(can(viewer, "integrations.webhooks.edit")).toBe(false);
    expect(can(editor, "integrations.webhooks.edit")).toBe(false);
    expect(can(admin, "integrations.webhooks.edit")).toBe(true);
  });

  // Service-account values are credentials: /v1/service-accounts is admin-only
  // for reads as well as writes.
  it("only admin can see or edit service accounts", () => {
    expect(can(viewer, "integrations.service_accounts.view")).toBe(false);
    expect(can(editor, "integrations.service_accounts.view")).toBe(false);
    expect(can(admin, "integrations.service_accounts.view")).toBe(true);
    expect(can(viewer, "integrations.service_accounts.edit")).toBe(false);
    expect(can(editor, "integrations.service_accounts.edit")).toBe(false);
    expect(can(admin, "integrations.service_accounts.edit")).toBe(true);
  });
});
