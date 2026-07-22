process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgRun, pgGet, pgAll } from "../src/pg.ts";
import { provisionTenant, listMembershipsForUser } from "../src/tenant.ts";

const T_IDS = ["tinv_a"];
const EMAIL = "newhire@example.com";

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE lower(email) = $1`, [EMAIL]);
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE lower(email) = $1`, [EMAIL]);
}

beforeEach(async () => {
  await resetDb();
  await cleanup();
});

afterAll(cleanup);

test("password signup with a matching pending invite → user becomes a member of the invited tenant", async () => {
  await provisionTenant({ id: "tinv_a", label: "Invite Target" });
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_invite" (tenant_id, email, role, invited_by, invited_at)
     VALUES ('tinv_a', $1, 'editor', 'u_inviter', now())`,
    [EMAIL],
  );

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "passw0rd123!", name: "New Hire" }),
    }),
    () => {},
  );
  expect(res.status).toBeLessThan(400);

  const userRow = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."users" WHERE lower(email) = $1`,
    [EMAIL],
  );
  expect(userRow).not.toBeNull();

  const memberships = await listMembershipsForUser(userRow!.id);
  expect(memberships.map((m) => m.tenant.id)).toContain("tinv_a");
  expect(memberships.find((m) => m.tenant.id === "tinv_a")?.role).toBe("editor");

  // Invite must be consumed.
  const remaining = await pgAll<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."tenant_invite" WHERE lower(email) = $1`,
    [EMAIL],
  );
  expect(remaining[0]?.n).toBe(0);
});

test("viewer invite is honored on signup — role must be viewer, not editor", async () => {
  // The bug: auth-password.ts pre-seeds the invited user as 'editor' into the default
  // workspace (ON CONFLICT DO NOTHING) before acceptInvitesFor runs. The old
  // acceptInvitesFor also used DO NOTHING, so the viewer role was silently discarded.
  // The fix: acceptInvitesFor uses DO UPDATE SET role = EXCLUDED.role.

  const { handle } = await import("../src/server.ts");

  // Step 1: Sign up the first user (admin) so subsequent signups are gated by invite.
  const adminRes = await handle(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "longenoughpw12", name: "Admin" }),
    }),
    () => {},
  );
  expect(adminRes.status).toBe(200);

  // Step 2: Insert a viewer invite for the second user in the default workspace.
  const viewerEmail = "viewer@example.com";
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_invite" (tenant_id, email, role, invited_by, invited_at)
     VALUES ('default', $1, 'viewer', 'u_admin', now())`,
    [viewerEmail],
  );

  // Step 3: Invited viewer signs up.
  const viewerRes = await handle(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: viewerEmail, password: "longenoughpw12", name: "Viewer" }),
    }),
    () => {},
  );
  expect(viewerRes.status).toBe(200);

  // Step 4: Assert the tenant_member row has role 'viewer', not 'editor'.
  const viewerUser = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."users" WHERE lower(email) = $1`,
    [viewerEmail],
  );
  expect(viewerUser).not.toBeNull();

  const memberships = await listMembershipsForUser(viewerUser!.id);
  const defaultMembership = memberships.find((m) => m.tenant.id === "default");
  expect(defaultMembership).not.toBeUndefined();
  expect(defaultMembership?.role).toBe("viewer");

  // Invite must be consumed.
  const remaining = await pgAll<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."tenant_invite" WHERE lower(email) = $1`,
    [viewerEmail],
  );
  expect(remaining[0]?.n).toBe(0);
});

test("password login (existing user, no membership, no invite) does not crash and the user remains memberless", async () => {
  // Create a real password hash for "knownpassword123"
  const hash = await Bun.password.hash("knownpassword123");
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email, auth_provider, password_hash)
     VALUES ('u_existing_memberless', 'X', 'XX', $1, 'password', $2)`,
    [EMAIL, hash],
  );

  const { handle } = await import("../src/server.ts");
  const res = await handle(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "wrong-password" }),
    }),
    () => {},
  );
  // Wrong password → 401; the test asserts no exception. Membership state untouched.
  expect(res.status).toBe(401);

  const memberships = await listMembershipsForUser("u_existing_memberless");
  expect(memberships).toHaveLength(0);
});
