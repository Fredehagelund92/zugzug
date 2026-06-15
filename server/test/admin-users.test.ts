process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";

const U_IDS = ["u_admusers_sa", "u_admusers_reg", "u_admusers_sa2"];

async function cleanup(): Promise<void> {
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function login(userId: string, isSuperAdmin: boolean): Promise<string> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, is_super_admin)
     VALUES ($1, $1, 'XX', $2, $3)`,
    [userId, `${userId}@example.com`, isSuperAdmin],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

test("GET /api/admin/users returns user list for super-admin", async () => {
  const cookie = await login("u_admusers_sa", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/users", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { users: { id: string; isSuperAdmin: boolean }[] };
  expect(Array.isArray(body.users)).toBe(true);
  const self = body.users.find((u) => u.id === "u_admusers_sa");
  expect(self?.isSuperAdmin).toBe(true);
});

test("GET /api/admin/users returns 403 for non-super-admin", async () => {
  const cookie = await login("u_admusers_reg", false);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/users", { headers: { cookie } }),
    () => {},
  );
  expect(res.status).toBe(403);
});

test("PATCH /api/admin/users/:id promotes to super-admin", async () => {
  const cookie = await login("u_admusers_sa", true);
  await login("u_admusers_reg", false);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/users/u_admusers_reg", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ isSuperAdmin: true }),
    }),
    () => {},
  );
  expect(res.status).toBe(204);
});

test("PATCH /api/admin/users/:id returns 409 self_demote", async () => {
  const cookie = await login("u_admusers_sa", true);
  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/admin/users/u_admusers_sa", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ isSuperAdmin: false }),
    }),
    () => {},
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("self_demote");
});
