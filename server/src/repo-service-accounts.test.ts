import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun, pgGet } from "./pg.ts";
import {
  createServiceAccount,
  listServiceAccounts,
  revokeServiceAccount,
} from "./repo-service-accounts.ts";

const T = "test_sa_repo";
const U = "u_test_sa_repo";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'SA Repo Test', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'SA Repo Tester', 'sar@example.test', 'SR', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("createServiceAccount", () => {
  it("returns a zzsa_ token value and persists the row with correct fields", async () => {
    const r = await createServiceAccount({
      tenantId: T,
      name: "dbt prod",
      createdBy: U,
    });
    expect(r.id.startsWith("sa_")).toBe(true);
    expect(r.value.startsWith("zzsa_")).toBe(true);
    expect(r.value.length).toBeGreaterThan(40);

    const row = await pgGet<{
      tenant_id: string;
      name: string;
      token_prefix: string;
      scopes: string[];
      revoked_at: Date | null;
      expires_at: Date | null;
    }>(
      `SELECT tenant_id, name, token_prefix, scopes, revoked_at, expires_at
         FROM "zugzug_app"."service_account" WHERE id = $1`,
      [r.id],
    );
    expect(row).not.toBeNull();
    expect(row!.tenant_id).toBe(T);
    expect(row!.name).toBe("dbt prod");
    expect(row!.token_prefix).toBe(r.value.slice(0, 12));
    expect(row!.scopes).toEqual(["read"]);
    expect(row!.revoked_at).toBeNull();
    expect(row!.expires_at).toBeNull();
  });

  it("expiresAt is persisted when provided", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);
    const r = await createServiceAccount({
      tenantId: T,
      name: "1-year",
      createdBy: U,
      expiresAt: future,
    });
    const row = await pgGet<{ expires_at: Date | null }>(
      `SELECT expires_at FROM "zugzug_app"."service_account" WHERE id = $1`,
      [r.id],
    );
    expect(row!.expires_at).not.toBeNull();
    expect(Math.abs(row!.expires_at!.getTime() - future.getTime())).toBeLessThan(1000);
  });
});

describe("listServiceAccounts", () => {
  it("returns non-revoked SAs in tenant, with sa_id + prefix + scopes + createdBy", async () => {
    const a = await createServiceAccount({ tenantId: T, name: "list_a", createdBy: U });
    const b = await createServiceAccount({ tenantId: T, name: "list_b", createdBy: U });
    const list = await listServiceAccounts(T);
    const ids = list.map((sa) => sa.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    const aRow = list.find((sa) => sa.id === a.id)!;
    expect(aRow.tokenPrefix).toBe(a.value.slice(0, 12));
    expect(aRow.scopes).toEqual(["read"]);
    expect(aRow.createdBy).toBe(U);
    expect(aRow.revokedAt).toBeNull();
  });

  it("does NOT return revoked rows", async () => {
    const r = await createServiceAccount({ tenantId: T, name: "to_revoke", createdBy: U });
    await revokeServiceAccount(T, r.id);
    const list = await listServiceAccounts(T);
    expect(list.find((sa) => sa.id === r.id)).toBeUndefined();
  });

  it("is scoped to tenant — no leakage", async () => {
    const tt = "test_sa_repo_other";
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
       VALUES ($1, $1, 'Other', 'default', now()) ON CONFLICT DO NOTHING`,
      [tt],
    );
    const r = await createServiceAccount({ tenantId: tt, name: "other_tenant", createdBy: U });
    const list = await listServiceAccounts(T);
    expect(list.find((sa) => sa.id === r.id)).toBeUndefined();
    await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [tt]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [tt]);
  });
});

describe("revokeServiceAccount", () => {
  it("sets revoked_at on matching row, returns true", async () => {
    const r = await createServiceAccount({ tenantId: T, name: "revoke_target", createdBy: U });
    const ok = await revokeServiceAccount(T, r.id);
    expect(ok).toBe(true);
    const row = await pgGet<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM "zugzug_app"."service_account" WHERE id = $1`,
      [r.id],
    );
    expect(row!.revoked_at).not.toBeNull();
  });

  it("returns false for wrong-tenant id", async () => {
    const r = await createServiceAccount({ tenantId: T, name: "for_other_tenant", createdBy: U });
    const ok = await revokeServiceAccount("other_tenant", r.id);
    expect(ok).toBe(false);
    const row = await pgGet<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM "zugzug_app"."service_account" WHERE id = $1`,
      [r.id],
    );
    expect(row!.revoked_at).toBeNull();
  });
});
