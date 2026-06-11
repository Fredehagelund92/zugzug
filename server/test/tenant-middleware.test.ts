process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { resolveTenantContext, type TenantContext } from "../src/tenant-middleware.ts";
import { AppError } from "../src/errors.ts";
import type { SessionUser } from "../src/auth.ts";

const T_IDS = ["tctx_a"];
const U_IDS = ["u_ctx_member", "u_ctx_outsider", "u_ctx_super"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

function user(id: string): SessionUser {
  return { id, name: id, email: `${id}@x`, initials: "XX", role: "editor" };
}

async function makeUser(id: string, isSuperAdmin = false): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role, is_super_admin)
     VALUES ($1, $1, 'XX', $2, 'editor', $3)`,
    [id, `${id}@x`, isSuperAdmin],
  );
}

test("resolveTenantContext: tenant route + valid member → returns {tenantId, role, isSuperAdmin=false}", async () => {
  await provisionTenant({ id: "tctx_a", label: "A" });
  await makeUser("u_ctx_member");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ('tctx_a', 'u_ctx_member', 'admin', now())`,
  );

  const ctx: TenantContext = await resolveTenantContext({
    pathname: "/api/t/tctx_a/preferences",
    user: user("u_ctx_member"),
  });
  expect(ctx).toEqual({ tenantId: "tctx_a", role: "admin", isSuperAdmin: false });
});

test("resolveTenantContext: tenant route + non-member → AppError 403", async () => {
  await provisionTenant({ id: "tctx_a", label: "A" });
  await makeUser("u_ctx_outsider");

  let thrown: AppError | null = null;
  try {
    await resolveTenantContext({
      pathname: "/api/t/tctx_a/preferences",
      user: user("u_ctx_outsider"),
    });
  } catch (e) {
    if (e instanceof AppError) thrown = e;
  }
  expect(thrown?.code).toBe("FORBIDDEN");
  expect(thrown?.status).toBe(403);
});

test("resolveTenantContext: tenant route + super-admin non-member → bypass, role='admin'", async () => {
  await provisionTenant({ id: "tctx_a", label: "A" });
  await makeUser("u_ctx_super", true);

  const ctx = await resolveTenantContext({
    pathname: "/api/t/tctx_a/preferences",
    user: user("u_ctx_super"),
    isSuperAdmin: true,
  });
  expect(ctx).toEqual({ tenantId: "tctx_a", role: "admin", isSuperAdmin: true });
});

test("resolveTenantContext: unknown slug → AppError 404", async () => {
  await makeUser("u_ctx_member");
  let thrown: AppError | null = null;
  try {
    await resolveTenantContext({
      pathname: "/api/t/no_such_slug/preferences",
      user: user("u_ctx_member"),
    });
  } catch (e) {
    if (e instanceof AppError) thrown = e;
  }
  expect(thrown?.code).toBe("NOT_FOUND");
  expect(thrown?.status).toBe(404);
});

test("resolveTenantContext: legacy /api/preferences path → tenantId='default'", async () => {
  await makeUser("u_ctx_member");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ('default', 'u_ctx_member', 'editor', now())
     ON CONFLICT DO NOTHING`,
  );

  const ctx = await resolveTenantContext({
    pathname: "/api/preferences",
    user: user("u_ctx_member"),
  });
  expect(ctx.tenantId).toBe("default");
  expect(ctx.role).toBe("editor");
});
