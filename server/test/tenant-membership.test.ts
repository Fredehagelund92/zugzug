process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun, pgGet } from "../src/pg.ts";
import {
  provisionTenant,
  tenantBySlug,
  listMembershipsForUser,
  memberRole,
  acceptInvitesFor,
} from "../src/tenant.ts";

const T_IDS = ["tmem_a", "tmem_b"];
const U_IDS = ["u_member_a", "u_member_b", "u_invitee"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function makeUser(id: string, email: string): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ($1, $1, 'XX', $2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [id, email],
  );
}

test("tenantBySlug returns the tenant row or null", async () => {
  await provisionTenant({ id: "tmem_a", label: "A" });
  const found = await tenantBySlug("tmem_a");
  expect(found?.id).toBe("tmem_a");
  expect(await tenantBySlug("tmem_notthere")).toBeNull();
});

test("listMembershipsForUser returns all tenants the user is a member of, ordered by label", async () => {
  await provisionTenant({ id: "tmem_a", label: "Alpha" });
  await provisionTenant({ id: "tmem_b", label: "Bravo" });
  await makeUser("u_member_a", "a@example.com");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, 'admin', now()), ($3, $2, 'editor', now())`,
    ["tmem_a", "u_member_a", "tmem_b"],
  );

  const memberships = await listMembershipsForUser("u_member_a");
  expect(memberships.map((m) => m.tenant.id)).toEqual(["tmem_a", "tmem_b"]);
  expect(memberships.find((m) => m.tenant.id === "tmem_a")?.role).toBe("admin");
  expect(memberships.find((m) => m.tenant.id === "tmem_b")?.role).toBe("editor");
});

test("memberRole returns the role for an existing membership", async () => {
  await provisionTenant({ id: "tmem_a", label: "A" });
  await makeUser("u_member_a", "a@example.com");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ('tmem_a', 'u_member_a', 'viewer', now())`,
  );
  expect(await memberRole("tmem_a", "u_member_a")).toBe("viewer");
  expect(await memberRole("tmem_a", "u_member_b")).toBeNull();
});

test("acceptInvitesFor converts every pending invite for the email into a tenant_member row and deletes the invites", async () => {
  await provisionTenant({ id: "tmem_a", label: "A" });
  await provisionTenant({ id: "tmem_b", label: "B" });
  await makeUser("u_invitee", "invitee@example.com");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_invite" (tenant_id, email, role, invited_by, invited_at)
     VALUES ('tmem_a', 'invitee@example.com', 'editor', 'u_member_a', now()),
            ('tmem_b', 'invitee@example.com', 'viewer', 'u_member_a', now())`,
  );

  const accepted = await acceptInvitesFor("u_invitee", "invitee@example.com");
  expect(accepted.map((a) => a.tenant_id).sort()).toEqual(["tmem_a", "tmem_b"]);

  const memberships = await listMembershipsForUser("u_invitee");
  expect(memberships.map((m) => `${m.tenant.id}:${m.role}`).sort()).toEqual([
    "tmem_a:editor",
    "tmem_b:viewer",
  ]);
  const remaining = await pgGet<{ n: number }>(
    `SELECT count(*)::int AS n FROM "zugzug_app"."tenant_invite" WHERE lower(email) = $1`,
    ["invitee@example.com"],
  );
  expect(remaining?.n).toBe(0);
});

test("acceptInvitesFor is idempotent — running twice produces the same memberships, no error", async () => {
  await provisionTenant({ id: "tmem_a", label: "A" });
  await makeUser("u_invitee", "invitee@example.com");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_invite" (tenant_id, email, role, invited_by, invited_at)
     VALUES ('tmem_a', 'invitee@example.com', 'editor', 'u_member_a', now())`,
  );
  await acceptInvitesFor("u_invitee", "invitee@example.com");
  await acceptInvitesFor("u_invitee", "invitee@example.com");
  const memberships = await listMembershipsForUser("u_invitee");
  expect(memberships).toHaveLength(1);
});
