import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { pgRun } from "./pg.ts";
import { authenticateBearer } from "./auth-api-tokens.ts";
import { createServiceAccount } from "./repo-service-accounts.ts";
import { resolveTenantContext } from "./tenant-middleware.ts";

const T = "test_auth_sa";
const U = "u_test_sa";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
     VALUES ($1, $1, 'Auth SA Test', 'default', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'SA Tester', 'sa@example.test', 'ST', false)
     ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("authenticateBearer — service account tokens", () => {
  it("zzsa_ token returns a synthetic user + serviceAccount context", async () => {
    const { value } = await createServiceAccount({ tenantId: T, name: "Fivetran", createdBy: U });
    expect(value.startsWith("zzsa_")).toBe(true);

    const req = new Request("http://test/api/anything", {
      headers: { authorization: `Bearer ${value}` },
    });
    const authed = await authenticateBearer(req);
    expect(authed).not.toBeNull();
    expect(authed!.user.id.startsWith("sa_")).toBe(true);
    expect(authed!.user.email).toBeNull();
    expect(authed!.serviceAccount).toBeDefined();
    expect(authed!.serviceAccount!.tenantId).toBe(T);
    expect(authed!.serviceAccount!.scopes).toEqual(["read"]);
  });

  it("zz_ personal token still authenticates and serviceAccount is undefined", async () => {
    const value = `zz_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const hash = await Bun.password.hash(value);
    const id = `tok_sa_${crypto.randomUUID().replace(/-/g, "")}`;
    await pgRun(
      `INSERT INTO "zugzug_app"."api_tokens"
         (id, user_id, name, token_hash, token_prefix, created_at)
       VALUES ($1, $2, 'personal', $3, $4, now())`,
      [id, U, hash, value.slice(0, 12)],
    );

    const req = new Request("http://test/", {
      headers: { authorization: `Bearer ${value}` },
    });
    const authed = await authenticateBearer(req);
    expect(authed).not.toBeNull();
    expect(authed!.user.id).toBe(U);
    expect(authed!.serviceAccount).toBeUndefined();

    await pgRun(`DELETE FROM "zugzug_app"."api_tokens" WHERE id = $1`, [id]);
  });

  it("revoked zzsa_ token returns null", async () => {
    const { value, id: saId } = await createServiceAccount({
      tenantId: T,
      name: "Revoked",
      createdBy: U,
    });
    await pgRun(`UPDATE "zugzug_app"."service_account" SET revoked_at = now() WHERE id = $1`, [
      saId,
    ]);
    const req = new Request("http://test/", { headers: { authorization: `Bearer ${value}` } });
    expect(await authenticateBearer(req)).toBeNull();
  });

  it("expired zzsa_ token returns null (lazy auto-revoke)", async () => {
    const { value } = await createServiceAccount({
      tenantId: T,
      name: "Expired",
      createdBy: U,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const req = new Request("http://test/", { headers: { authorization: `Bearer ${value}` } });
    expect(await authenticateBearer(req)).toBeNull();
  });
});

describe("resolveTenantContext — service account context", () => {
  it("synthesises role='viewer' when the SA's tenant matches the URL slug", async () => {
    const { value } = await createServiceAccount({ tenantId: T, name: "Resolver", createdBy: U });
    const req = new Request(`http://test/api/t/${T}/v1/dimensions`, {
      headers: { authorization: `Bearer ${value}` },
    });
    const authed = await authenticateBearer(req);
    expect(authed!.serviceAccount).toBeDefined();

    const ctx = await resolveTenantContext({
      pathname: `/api/t/${T}/v1/dimensions`,
      user: authed!.user,
      isSuperAdmin: false,
      serviceAccount: authed!.serviceAccount,
    });
    expect(ctx.tenantId).toBe(T);
    expect(ctx.role).toBe("viewer");
    expect(ctx.isSuperAdmin).toBe(false);
  });

  it("rejects when the SA's tenant does NOT match the URL slug", async () => {
    const tt = "test_sa_mismatch";
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
       VALUES ($1, $1, 'Mismatch', 'default', now()) ON CONFLICT DO NOTHING`,
      [tt],
    );
    const { value } = await createServiceAccount({ tenantId: tt, name: "Wrong", createdBy: U });
    const req = new Request(`http://test/api/t/${T}/v1/dimensions`, {
      headers: { authorization: `Bearer ${value}` },
    });
    const authed = await authenticateBearer(req);

    await expect(
      resolveTenantContext({
        pathname: `/api/t/${T}/v1/dimensions`,
        user: authed!.user,
        isSuperAdmin: false,
        serviceAccount: authed!.serviceAccount,
      }),
    ).rejects.toThrow(/tenant|mismatch/i);

    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [tt]);
    await pgRun(`DELETE FROM "zugzug_app"."service_account" WHERE tenant_id = $1`, [tt]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [tt]);
  });
});
