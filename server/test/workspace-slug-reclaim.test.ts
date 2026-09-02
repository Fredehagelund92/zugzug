process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant, updateTenantSlug } from "../src/tenant.ts";
import { lookupAliasedSlug, recordSlugAlias } from "../src/slug-alias.ts";
import { handleV1Route } from "../src/v1-routes.ts";

const T_A = "tsr_first";
const T_B = "tsr_second";
const U = "u_tsr_member";
const OLD_SLUG = "tsr_alpha";
const NEW_SLUG = "tsr_beta";
const OTHER_SLUG = "tsr_gamma";

async function cleanup(): Promise<void> {
  for (const slug of [OLD_SLUG, NEW_SLUG, OTHER_SLUG]) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_slug_alias" WHERE old_slug = $1`, [slug]);
  }
  for (const t of [T_A, T_B]) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [U]);
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]);
}
beforeEach(cleanup);
afterAll(cleanup);

/** Signs `U` in as a member of `tenantId`, and nothing else. */
async function loginAs(tenantId: string): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ($1, $1, 'TS', $2) ON CONFLICT (id) DO NOTHING`,
    [U, `${U}@example.com`],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, 'editor', now()) ON CONFLICT DO NOTHING`,
    [tenantId, U],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(U);
  return `zz_sid=${sessionId}`;
}

function pullApi(slug: string, cookie?: string): Request {
  return new Request(`http://test/api/t/${slug}/v1/tables`, {
    headers: cookie ? { cookie } : {},
  });
}

async function resolveAlias(slug: string, cookie: string): Promise<Response> {
  const { handle } = await import("../src/server.ts");
  return handle(
    new Request(`http://localhost/api/me/slug-alias/${slug}`, { headers: { cookie } }),
    () => {},
  );
}

test("Pull API: a renamed-away address redirects while nothing else owns it", async () => {
  await provisionTenant({ id: T_A, slug: OLD_SLUG, label: "First" });
  await updateTenantSlug(OLD_SLUG, NEW_SLUG);

  const res = await handleV1Route(pullApi(OLD_SLUG));
  expect(res!.status).toBe(301);
  expect(res!.headers.get("location")).toBe(`/api/t/${NEW_SLUG}/v1/tables`);
});

test("Pull API: the workspace that reclaims the address is served, not redirected", async () => {
  await provisionTenant({ id: T_A, slug: OLD_SLUG, label: "First" });
  await updateTenantSlug(OLD_SLUG, NEW_SLUG);
  // Workspace B legitimately claims the freed address.
  await provisionTenant({ id: T_B, slug: OLD_SLUG, label: "Second" });

  // Claiming the address drops the alias…
  expect(await lookupAliasedSlug(OLD_SLUG)).toBeNull();

  // …and even with a stale alias row back on it, the live workspace wins. The
  // caller is a member of B only, so a redirect to A could not answer 200.
  await recordSlugAlias(OLD_SLUG, T_A);
  const cookie = await loginAs(T_B);
  const res = await handleV1Route(pullApi(OLD_SLUG, cookie));
  expect(res!.status).toBe(200);
});

test("Renaming onto an address another workspace was renamed away from clears that alias", async () => {
  await provisionTenant({ id: T_A, slug: OLD_SLUG, label: "First" });
  await updateTenantSlug(OLD_SLUG, NEW_SLUG);
  await provisionTenant({ id: T_B, slug: OTHER_SLUG, label: "Second" });

  await updateTenantSlug(OTHER_SLUG, OLD_SLUG);
  expect(await lookupAliasedSlug(OLD_SLUG)).toBeNull();
});

test("GET /api/me/slug-alias/:slug resolves an old address for a member", async () => {
  await provisionTenant({ id: T_A, slug: OLD_SLUG, label: "First" });
  const cookie = await loginAs(T_A);
  await updateTenantSlug(OLD_SLUG, NEW_SLUG);

  const res = await resolveAlias(OLD_SLUG, cookie);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { slug: string }).slug).toBe(NEW_SLUG);
});

test("GET /api/me/slug-alias/:slug is 404 for someone who isn't a member", async () => {
  await provisionTenant({ id: T_A, slug: OLD_SLUG, label: "First" });
  await updateTenantSlug(OLD_SLUG, NEW_SLUG);
  await provisionTenant({ id: T_B, slug: OTHER_SLUG, label: "Second" });
  const cookie = await loginAs(T_B);

  expect((await resolveAlias(OLD_SLUG, cookie)).status).toBe(404);
});
