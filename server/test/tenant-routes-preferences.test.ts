process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";

const T_IDS = ["troute_a", "troute_b"];
const U_IDS = ["u_route_member"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function setupUserWithMembership(opts: {
  userId: string;
  tenants: { id: string; label: string; role: "admin" | "editor" | "viewer" }[];
}): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, role)
     VALUES ($1, $1, 'XX', $2, 'editor')
     ON CONFLICT (id) DO NOTHING`,
    [opts.userId, `${opts.userId}@example.com`],
  );
  for (const t of opts.tenants) {
    await provisionTenant({ id: t.id, label: t.label }).catch(() => {});
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT DO NOTHING`,
      [t.id, opts.userId, t.role],
    );
  }
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(opts.userId);
  return `zz_sid=${sessionId}`;
}

test("GET /api/t/:slug/preferences returns the tenant's preferences", async () => {
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "troute_a", label: "A", role: "admin" }],
  });
  const { TenantRepo } = await import("../src/tenant-repo.ts");
  await new TenantRepo("troute_a", "admin").setPreferences({
    publishThreshold: 77,
    suggestThreshold: 55,
    scanSchedule: "15m",
  });

  const { handle } = await import("../src/server.ts");
  const req = new Request("http://localhost/api/t/troute_a/preferences", {
    headers: { cookie },
  });
  const res = await handle(req, () => {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as { publishThreshold: number; scanSchedule: string };
  expect(body.publishThreshold).toBe(77);
  expect(body.scanSchedule).toBe("15m");
});

test("GET /api/t/:slug/preferences for a workspace the user does not belong to → 403", async () => {
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "troute_a", label: "A", role: "admin" }],
  });
  await provisionTenant({ id: "troute_b", label: "B" }).catch(() => {});

  const { handle } = await import("../src/server.ts");
  const req = new Request("http://localhost/api/t/troute_b/preferences", {
    headers: { cookie },
  });
  const res = await handle(req, () => {});
  expect(res.status).toBe(403);
});

test("GET /api/t/no_such_workspace/preferences → 404", async () => {
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "troute_a", label: "A", role: "admin" }],
  });
  const { handle } = await import("../src/server.ts");
  const req = new Request("http://localhost/api/t/no_such_workspace/preferences", {
    headers: { cookie },
  });
  const res = await handle(req, () => {});
  expect(res.status).toBe(404);
});

test("legacy /api/preferences still works under default tenant", async () => {
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "default", label: "Default", role: "admin" }],
  });

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/preferences", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
});

test("PUT /api/t/:slug/preferences as viewer → 403", async () => {
  const cookie = await setupUserWithMembership({
    userId: "u_route_member",
    tenants: [{ id: "troute_a", label: "A", role: "viewer" }],
  });
  const { handle } = await import("../src/server.ts");
  const req = new Request("http://localhost/api/t/troute_a/preferences", {
    method: "PUT",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ publishThreshold: 1, suggestThreshold: 1, scanSchedule: null }),
  });
  const res = await handle(req, () => {});
  expect(res.status).toBe(403);
});
