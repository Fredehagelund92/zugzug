process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";

const T_IDS = ["mem_acme", "mem_globex"];
const U_IDS = ["u_mem_alice"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
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

async function makeUser(id: string, email: string, isSuperAdmin = false): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, is_super_admin)
     VALUES ($1, $1, 'XX', $2, $3)`,
    [id, email, isSuperAdmin],
  );
}

async function login(userId: string, isSuperAdmin: boolean): Promise<string> {
  await makeUser(userId, `${userId}@example.com`, isSuperAdmin);
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

describe("GET /api/me/memberships", () => {
  test("returns memberships for the current user, with isSuperAdmin flag", async () => {
    const a = await provisionTenant({ id: "mem_acme", label: "Acme" });
    const b = await provisionTenant({ id: "mem_globex", label: "Globex" });
    const cookie = await login("u_mem_alice", false);

    // Add alice to both tenants
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
       VALUES ($1, 'u_mem_alice', 'admin', now()), ($2, 'u_mem_alice', 'editor', now())`,
      [a.id, b.id],
    );

    const { handle } = await import("../src/server.ts");
    const res = await handle(
      new Request("http://localhost/api/me/memberships", { headers: { cookie } }),
      () => {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      isSuperAdmin: boolean;
      memberships: { slug: string; label: string; role: string }[];
    };
    expect(body.isSuperAdmin).toBe(false);
    expect(body.memberships.map((m) => m.slug).sort()).toEqual(["mem_acme", "mem_globex"]);
    expect(body.memberships[0]).toMatchObject({
      slug: expect.any(String),
      label: expect.any(String),
      role: expect.any(String),
    });
  });

  test("isSuperAdmin is true when user is super-admin", async () => {
    const cookie = await login("u_mem_alice", true);
    const { handle } = await import("../src/server.ts");
    const res = await handle(
      new Request("http://localhost/api/me/memberships", { headers: { cookie } }),
      () => {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isSuperAdmin: boolean; memberships: unknown[] };
    expect(body.isSuperAdmin).toBe(true);
    // super-admins see ALL tenants (including the default workspace)
    expect(body.memberships.length).toBeGreaterThanOrEqual(1);
  });

  test("401 when not signed in", async () => {
    const { handle } = await import("../src/server.ts");
    const res = await handle(
      new Request("http://localhost/api/me/memberships"),
      () => {},
    );
    expect(res.status).toBe(401);
  });
});
