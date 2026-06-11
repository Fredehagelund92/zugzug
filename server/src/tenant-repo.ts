import { AppError } from "./errors.ts";
import * as repoMeta from "./repo-meta.ts";
import type { Preferences } from "./repo-shared.ts";

export type Role = "admin" | "editor" | "viewer";
export type Operation = "curate" | "commit" | "manage_team" | "manage_adapter";

const ROLE_OPS: Record<Role, Operation[]> = {
  admin: ["curate", "commit", "manage_team", "manage_adapter"],
  editor: ["curate", "commit"],
  viewer: [],
};

/* TenantRepo — request-scoped DB surface.
 *
 * PR2a ships the class with preferences + audit methods. Every method takes the
 * tenant scope from `this.tenantId` and forwards to the underlying repo-*.ts
 * function (which now accepts a `tenantId` parameter — see repo-meta.ts). PR2b
 * expands this to the remaining ~40 repo functions.
 *
 * Mutation methods call `this.assertRole(op)` first. The static permission
 * matrix here mirrors auth.ts.canMutate. */
export class TenantRepo {
  constructor(
    public readonly tenantId: string,
    public readonly role: Role,
    public readonly isSuperAdmin: boolean = false,
  ) {}

  assertRole(op: Operation): void {
    if (this.isSuperAdmin) return; // super-admin bypasses per-tenant role gates
    if (!ROLE_OPS[this.role].includes(op)) {
      throw new AppError("FORBIDDEN", `role '${this.role}' cannot ${op}`, 403);
    }
  }

  // --- preferences -----------------------------------------------------------
  getPreferences(): Promise<Preferences> {
    return repoMeta.getPreferences(this.tenantId);
  }

  setPreferences(p: Preferences): Promise<void> {
    this.assertRole("manage_adapter");
    return repoMeta.setPreferences(p, this.tenantId);
  }

  // --- audit ----------------------------------------------------------------
  listAudit(limit = 30): Promise<import("./repo-shared.ts").AuditEntry[]> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return repoMeta.listAudit(limit, scope);
  }

  appendAudit(
    userId: string,
    action: string,
    detail: string,
    ctx: { tableId?: string; rowKey?: string } = {},
  ): Promise<void> {
    this.assertRole("curate");
    return repoMeta.appendAuditAs(userId, action, detail, { ...ctx, tenantId: this.tenantId });
  }
}
