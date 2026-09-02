import type { TenantContextValue } from "./tenant-context";

/** Capabilities the server resolves for the caller and serves on
 *  GET /api/me/memberships. Mirrors `Operation` in server/src/auth.ts — that
 *  file is the source of truth; nothing here re-derives permissions from the
 *  role name, so a control is enabled exactly when the server will accept it.
 *
 *    curate               — draft and edit records and mappings
 *    commit               — publish drafts
 *    manage_tables        — create/delete tables, field operations, wire
 *                           sources, run scans
 *    manage_workspace     — preferences, members, rename/delete, rollback
 *    manage_integrations  — webhooks and service accounts
 */
export type Capability =
  | "curate"
  | "commit"
  | "manage_tables"
  | "manage_workspace"
  | "manage_integrations";

export type Action =
  | "account.profile.edit"
  | "settings.general.view"
  | "settings.general.edit"
  | "settings.members.view"
  | "settings.members.edit"
  | "settings.scans.view"
  | "settings.scans.edit"
  | "settings.matching.view"
  | "settings.matching.edit"
  | "settings.warehouse.view"
  | "settings.audit.view"
  | "settings.danger.leave"
  | "settings.danger.delete"
  | "integrations.pull_api.view"
  | "integrations.webhooks.view"
  | "integrations.webhooks.delivery_payload_view"
  | "integrations.webhooks.edit"
  | "integrations.service_accounts.view"
  | "integrations.service_accounts.edit"
  | "admin.view"
  | "table.create"
  | "table.scan"
  | "table.rollback";

/** What each affordance needs: a capability, "always" (available to anyone who
 *  can see the workspace) or "super_admin" (the deployment-wide /admin shell). */
const REQUIRES: Record<Action, Capability | "always" | "super_admin"> = {
  "account.profile.edit": "always",
  "settings.danger.leave": "always",

  "settings.general.view": "always",
  "settings.members.view": "always",
  "settings.scans.view": "always",
  "settings.matching.view": "always",
  "settings.warehouse.view": "always",
  "settings.audit.view": "always",

  // Workspace settings — thresholds, scan schedule, four-eyes, auto-publish,
  // members and the danger zone all sit behind PUT /preferences and the
  // requireAdmin routes.
  "settings.general.edit": "manage_workspace",
  "settings.members.edit": "manage_workspace",
  "settings.scans.edit": "manage_workspace",
  "settings.matching.edit": "manage_workspace",
  "settings.danger.delete": "manage_workspace",
  "table.rollback": "manage_workspace",

  "table.create": "manage_tables",
  "table.scan": "manage_tables",

  "integrations.pull_api.view": "always",
  // The webhooks surface is editor+ on the server (GET /v1/webhooks returns
  // editor_required for a viewer), and delivery payloads are unredacted only
  // for the same audience.
  "integrations.webhooks.view": "curate",
  "integrations.webhooks.delivery_payload_view": "curate",
  "integrations.webhooks.edit": "manage_integrations",
  // Service-account values are credentials — admin-only to read as well.
  "integrations.service_accounts.view": "manage_integrations",
  "integrations.service_accounts.edit": "manage_integrations",

  "admin.view": "super_admin",
};

export function can(t: TenantContextValue, action: Action): boolean {
  // Super-admin gets every workspace + account affordance (it bypasses the
  // per-tenant gates server-side too). The /admin shell is still gated by
  // isSuperAdmin via the "admin.view" action below.
  if (t.isSuperAdmin && action !== "admin.view") return true;

  const required = REQUIRES[action];
  if (required === "always") return true;
  if (required === "super_admin") return t.isSuperAdmin;
  return t.capabilities.includes(required);
}
