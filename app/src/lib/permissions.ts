import type { TenantContextValue } from "./tenant-context";

export type Action =
  | "account.profile.edit"
  | "settings.general.view"
  | "settings.general.edit"
  | "settings.members.view"
  | "settings.members.edit"
  | "settings.tokens.view"
  | "settings.tokens.edit"
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
  | "admin.view";

export function can(t: TenantContextValue, action: Action): boolean {
  // Super-admin gets every workspace + account affordance. The /admin shell
  // is still gated by isSuperAdmin via the "admin.view" action below — we
  // reach this branch only for non-admin actions.
  if (t.isSuperAdmin && action !== "admin.view") return true;

  switch (action) {
    case "account.profile.edit":
    case "settings.danger.leave":
      return true;

    case "settings.general.view":
    case "settings.members.view":
    case "settings.scans.view":
    case "settings.matching.view":
    case "settings.warehouse.view":
    case "settings.audit.view":
      return true;

    case "settings.tokens.view":
      return t.role === "editor" || t.role === "admin";

    case "settings.scans.edit":
    case "settings.matching.edit":
      return t.role === "editor" || t.role === "admin";

    case "settings.general.edit":
    case "settings.members.edit":
    case "settings.tokens.edit":
    case "settings.danger.delete":
      return t.role === "admin";

    case "integrations.pull_api.view":
    case "integrations.webhooks.view":
      return true;

    case "integrations.webhooks.delivery_payload_view":
    case "integrations.service_accounts.view":
      return t.role === "editor" || t.role === "admin";

    case "integrations.webhooks.edit":
    case "integrations.service_accounts.edit":
      return t.role === "admin";

    case "admin.view":
      return t.isSuperAdmin;
  }
}
