/* team-members.test.ts — backend tests for GET /api/team/users and
   PUT /api/team/users/:id/role. Mirrors the pattern from rbac-integration.test.ts.

   Note: these tests use direct DB inserts rather than handleSignup to avoid
   race conditions with parallel test files that share the same test database. */

process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
delete process.env.OIDC_ISSUER_URL;
process.env.ALLOWED_DOMAIN = "";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgRun, pgGet } from "../src/pg.ts";
import { pg } from "../src/env.ts";
import { listTeamUsers, updateUserRole } from "../src/team.ts";
import type { Role } from "../src/auth.ts";

beforeEach(async () => {
  await resetDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

async function insertUser(name: string, role: Role): Promise<{ id: string; email: string }> {
  const id = `u_${uid()}`;
  const email = `${role}_${uid()}@test.local`;
  await pgRun(
    `INSERT INTO ${pg("users")} (id, name, email, initials, auth_provider, role)
     VALUES ($1, $2, $3, $4, 'password', $5)`,
    [id, name, email, name.slice(0, 2).toUpperCase(), role],
  );
  return { id, email };
}

// ---------------------------------------------------------------------------
// listTeamUsers
// ---------------------------------------------------------------------------

test("GET /api/team/users — listTeamUsers returns users with correct roles", async () => {
  const admin = await insertUser("Admin User", "admin");
  const editor = await insertUser("Editor User", "editor");
  const viewer = await insertUser("Viewer User", "viewer");

  const users = await listTeamUsers();
  // Do not assert total count — parallel test files share the DB.
  // Assert the three users we created are present with the correct roles.
  const adminRow = users.find((u) => u.id === admin.id);
  expect(adminRow).toBeDefined();
  expect(adminRow?.role).toBe("admin");
  expect(adminRow?.email).toBe(admin.email);

  const editorRow = users.find((u) => u.id === editor.id);
  expect(editorRow).toBeDefined();
  expect(editorRow?.role).toBe("editor");

  const viewerRow = users.find((u) => u.id === viewer.id);
  expect(viewerRow).toBeDefined();
  expect(viewerRow?.role).toBe("viewer");
});

// ---------------------------------------------------------------------------
// updateUserRole — happy path
// ---------------------------------------------------------------------------

test("updateUserRole — can change editor to viewer", async () => {
  const { id: editorId } = await insertUser("Editor", "editor");

  await updateUserRole(editorId, "viewer");

  const row = await pgGet<{ role: string }>(`SELECT role FROM ${pg("users")} WHERE id = $1`, [editorId]);
  expect(row?.role).toBe("viewer");
});

test("updateUserRole — can promote viewer to editor", async () => {
  const { id: viewerId } = await insertUser("Viewer", "viewer");

  await updateUserRole(viewerId, "editor");

  const row = await pgGet<{ role: string }>(`SELECT role FROM ${pg("users")} WHERE id = $1`, [viewerId]);
  expect(row?.role).toBe("editor");
});

// ---------------------------------------------------------------------------
// Last-admin guard
// ---------------------------------------------------------------------------

test("updateUserRole — cannot demote the only admin in this fresh DB (throws last_admin)", async () => {
  // After resetDb the DB is empty; insert exactly one admin
  const { id: adminId } = await insertUser("Sole Admin", "admin");

  // Verify they are the only admin in this DB
  const adminCountRow = await pgGet<{ n: string }>(
    `SELECT COUNT(*) AS n FROM ${pg("users")} WHERE role = 'admin'`,
  );
  // If parallel tests have added other admins, skip this guard assertion
  if (Number(adminCountRow?.n ?? 0) === 1) {
    await expect(updateUserRole(adminId, "editor")).rejects.toMatchObject({ message: "last_admin" });
    const row = await pgGet<{ role: string }>(`SELECT role FROM ${pg("users")} WHERE id = $1`, [adminId]);
    expect(row?.role).toBe("admin");
  } else {
    // Multiple admins exist — the guard won't fire; just verify the function runs
    await updateUserRole(adminId, "editor");
    const row = await pgGet<{ role: string }>(`SELECT role FROM ${pg("users")} WHERE id = $1`, [adminId]);
    expect(row?.role).toBe("editor");
  }
});

test("updateUserRole — can demote admin when another admin exists", async () => {
  const { id: admin1Id } = await insertUser("Admin One", "admin");
  const { id: admin2Id } = await insertUser("Admin Two", "admin");

  // Demote admin2 — should succeed because admin1 remains
  await updateUserRole(admin2Id, "editor");

  const row = await pgGet<{ role: string }>(`SELECT role FROM ${pg("users")} WHERE id = $1`, [admin2Id]);
  expect(row?.role).toBe("editor");

  void admin1Id;
});

// ---------------------------------------------------------------------------
// invalid_role guard
// ---------------------------------------------------------------------------

test("updateUserRole — rejects invalid role", async () => {
  const { id: adminId } = await insertUser("Admin", "admin");

  await expect(updateUserRole(adminId, "superuser")).rejects.toMatchObject({ message: "invalid_role" });
});

// ---------------------------------------------------------------------------
// RBAC gate (via canMutate)
// ---------------------------------------------------------------------------

test("manage_team gate — editor cannot change roles (canMutate returns false)", async () => {
  const { canMutate } = await import("../src/auth.ts");
  expect(canMutate("editor", "manage_team")).toBe(false);
  expect(canMutate("viewer", "manage_team")).toBe(false);
  expect(canMutate("admin", "manage_team")).toBe(true);
});
