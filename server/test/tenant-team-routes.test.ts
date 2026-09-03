process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import { AppError } from "../src/errors.ts";

const T_IDS = ["tteam_acme"];
const U_IDS = ["u_tteam_admin", "u_tteam_editor", "u_tteam_other"];

async function cleanup(): Promise<void> {
  for (const t of T_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."preferences" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_slug_alias" WHERE tenant_id = $1`, [t]).catch(
      () => {},
    );
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  for (const u of U_IDS) {
    await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [u]);
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [u]);
  }
}
beforeEach(cleanup);
afterAll(cleanup);

async function setupUser(userId: string): Promise<void> {
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ($1, $1, 'TT', $2)
     ON CONFLICT (id) DO NOTHING`,
    [userId, `${userId}@example.com`],
  );
}

async function loginAs(
  userId: string,
  tenantId: string,
  role: "admin" | "editor" | "viewer",
): Promise<string> {
  await setupUser(userId);
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    [tenantId, userId, role],
  );
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession(userId);
  return `zz_sid=${sessionId}`;
}

async function ensureTenant(id: string): Promise<void> {
  await provisionTenant({ id, label: id }).catch((e) => {
    if (e instanceof AppError && e.code === "ALREADY_EXISTS") return;
    throw e;
  });
}

// Helper to make requests to /api/t/:slug/team/*
async function req(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> {
  const { handle } = await import("../src/server.ts");
  return handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        cookie,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    () => {},
  );
}

test("Admin can list members — GET /api/t/:slug/team/members", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  const res = await req("GET", "/api/t/tteam_acme/team/members", cookie);
  expect(res.status).toBe(200);
  const members = (await res.json()) as { user_id: string; role: string }[];
  expect(Array.isArray(members)).toBe(true);
  // The admin user should be in the list
  expect(members.some((m) => m.user_id === "u_tteam_admin")).toBe(true);
  expect(members.find((m) => m.user_id === "u_tteam_admin")?.role).toBe("admin");
});

test("Editor can also list members — GET /api/t/:slug/team/members", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_editor", "tteam_acme", "editor");

  const res = await req("GET", "/api/t/tteam_acme/team/members", cookie);
  expect(res.status).toBe(200);
  const members = (await res.json()) as { user_id: string }[];
  expect(Array.isArray(members)).toBe(true);
  expect(members.some((m) => m.user_id === "u_tteam_editor")).toBe(true);
});

test("Admin can list invites — initially empty — GET /api/t/:slug/team/invites", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  const res = await req("GET", "/api/t/tteam_acme/team/invites", cookie);
  expect(res.status).toBe(200);
  const invites = (await res.json()) as unknown[];
  expect(Array.isArray(invites)).toBe(true);
  expect(invites).toHaveLength(0);
});

test("Admin can create invite — POST /api/t/:slug/team/invites", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  const res = await req("POST", "/api/t/tteam_acme/team/invites", cookie, {
    email: "newperson@example.com",
    role: "editor",
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
});

test("Invite appears in list after creation", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  await req("POST", "/api/t/tteam_acme/team/invites", cookie, {
    email: "listed@example.com",
    role: "viewer",
  });

  const res = await req("GET", "/api/t/tteam_acme/team/invites", cookie);
  expect(res.status).toBe(200);
  const invites = (await res.json()) as { email: string; role: string }[];
  expect(invites.some((i) => i.email === "listed@example.com")).toBe(true);
  expect(invites.find((i) => i.email === "listed@example.com")?.role).toBe("viewer");
});

test("Admin can revoke invite — DELETE /api/t/:slug/team/invites/:email", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  // Create invite first
  await req("POST", "/api/t/tteam_acme/team/invites", cookie, {
    email: "todelete@example.com",
    role: "editor",
  });

  // Revoke it
  const delRes = await req(
    "DELETE",
    `/api/t/tteam_acme/team/invites/${encodeURIComponent("todelete@example.com")}`,
    cookie,
  );
  expect(delRes.status).toBe(204);

  // Verify it's gone
  const listRes = await req("GET", "/api/t/tteam_acme/team/invites", cookie);
  const invites = (await listRes.json()) as { email: string }[];
  expect(invites.some((i) => i.email === "todelete@example.com")).toBe(false);
});

test("Adding an email that already has an account makes them a member on the spot", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");
  await setupUser("u_tteam_other"); // has an account, not on this team

  const res = await req("POST", "/api/t/tteam_acme/team/invites", cookie, {
    email: "u_tteam_other@example.com",
    role: "editor",
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ ok: true, added: true });

  // They see the workspace on their very next request — no sign-out/sign-in.
  const { issueSession } = await import("../src/auth.ts");
  const { sessionId } = await issueSession("u_tteam_other");
  const memRes = await req("GET", "/api/me/memberships", `zz_sid=${sessionId}`);
  const mem = (await memRes.json()) as { memberships: { slug: string }[] };
  expect(mem.memberships.map((m) => m.slug)).toContain("tteam_acme");

  // …and no pending invite is left dangling on the Members screen.
  const invRes = await req("GET", "/api/t/tteam_acme/team/invites", cookie);
  expect(await invRes.json()).toHaveLength(0);
});

test("Adding an email with no account yet still creates a pending invite", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  const res = await req("POST", "/api/t/tteam_acme/team/invites", cookie, {
    email: "nobody-yet@example.com",
    role: "editor",
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toMatchObject({ ok: true, added: false });

  const invRes = await req("GET", "/api/t/tteam_acme/team/invites", cookie);
  const invites = (await invRes.json()) as { email: string }[];
  expect(invites.some((i) => i.email === "nobody-yet@example.com")).toBe(true);
});

test("An address that isn't an email is rejected — 400", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  const res = await req("POST", "/api/t/tteam_acme/team/invites", cookie, {
    email: "not-an-email",
    role: "editor",
  });
  expect(res.status).toBe(400);
});

test("A pathological address is refused without backtracking — 400", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  // "a@" + "a." * n + "@" makes the email pattern try every dot as the
  // separator before failing. Without the length cap that is quadratic: 32k
  // characters took ~4s on the single-threaded event loop, so an admin (or a
  // stolen admin session) could stall the server with one request.
  const t0 = performance.now();
  const res = await req("POST", "/api/t/tteam_acme/team/invites", cookie, {
    email: `a@${"a.".repeat(40_000)}@`,
    role: "editor",
  });
  expect(res.status).toBe(400);
  expect(performance.now() - t0).toBeLessThan(1000);
});

test("Someone already on the team is rejected — 409", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");
  await loginAs("u_tteam_editor", "tteam_acme", "editor");

  const res = await req("POST", "/api/t/tteam_acme/team/invites", cookie, {
    email: "u_tteam_editor@example.com",
    role: "editor",
  });
  expect(res.status).toBe(409);
});

test("An address already invited is rejected — 409", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  const body = { email: "twice@example.com", role: "editor" };
  expect((await req("POST", "/api/t/tteam_acme/team/invites", cookie, body)).status).toBe(201);
  expect((await req("POST", "/api/t/tteam_acme/team/invites", cookie, body)).status).toBe(409);
});

test("Editor gets 403 on POST /api/t/:slug/team/invites", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_editor", "tteam_acme", "editor");

  const res = await req("POST", "/api/t/tteam_acme/team/invites", cookie, {
    email: "blocked@example.com",
    role: "editor",
  });
  expect(res.status).toBe(403);
});

test("Cannot remove last admin — DELETE /api/t/:slug/team/members/:userId → 409", async () => {
  await ensureTenant("tteam_acme");
  // Only one member: the admin themselves
  const cookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  const res = await req(
    "DELETE",
    `/api/t/tteam_acme/team/members/${encodeURIComponent("u_tteam_admin")}`,
    cookie,
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("last_admin");
});

test("Admin can update member role — PUT /api/t/:slug/team/members/:userId/role", async () => {
  await ensureTenant("tteam_acme");
  const adminCookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");
  // Add a second member (editor)
  await setupUser("u_tteam_other");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    ["tteam_acme", "u_tteam_other", "editor"],
  );

  const res = await req(
    "PUT",
    `/api/t/tteam_acme/team/members/${encodeURIComponent("u_tteam_other")}/role`,
    adminCookie,
    { role: "viewer" },
  );
  expect(res.status).toBe(204);

  // Verify via members list
  const listRes = await req("GET", "/api/t/tteam_acme/team/members", adminCookie);
  const members = (await listRes.json()) as { user_id: string; role: string }[];
  expect(members.find((m) => m.user_id === "u_tteam_other")?.role).toBe("viewer");
});

test("Demoting the last admin is refused — PUT .../role → 409 last_admin", async () => {
  await ensureTenant("tteam_acme");
  const adminCookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");
  // Sole admin; a second member exists but is not an admin.
  await setupUser("u_tteam_other");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    ["tteam_acme", "u_tteam_other", "editor"],
  );

  const res = await req(
    "PUT",
    `/api/t/tteam_acme/team/members/${encodeURIComponent("u_tteam_admin")}/role`,
    adminCookie,
    { role: "editor" },
  );
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("last_admin");

  // Role unchanged.
  const listRes = await req("GET", "/api/t/tteam_acme/team/members", adminCookie);
  const members = (await listRes.json()) as { user_id: string; role: string }[];
  expect(members.find((m) => m.user_id === "u_tteam_admin")?.role).toBe("admin");
});

test("Demoting an admin while a second admin exists succeeds", async () => {
  await ensureTenant("tteam_acme");
  const adminCookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");
  await loginAs("u_tteam_other", "tteam_acme", "admin");

  const res = await req(
    "PUT",
    `/api/t/tteam_acme/team/members/${encodeURIComponent("u_tteam_other")}/role`,
    adminCookie,
    { role: "editor" },
  );
  expect(res.status).toBe(204);

  const listRes = await req("GET", "/api/t/tteam_acme/team/members", adminCookie);
  const members = (await listRes.json()) as { user_id: string; role: string }[];
  expect(members.find((m) => m.user_id === "u_tteam_other")?.role).toBe("editor");
});

test("Editor gets 403 on DELETE /api/t/:slug/team/members/:userId", async () => {
  await ensureTenant("tteam_acme");
  const editorCookie = await loginAs("u_tteam_editor", "tteam_acme", "editor");
  await setupUser("u_tteam_other");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    ["tteam_acme", "u_tteam_other", "viewer"],
  );

  const res = await req(
    "DELETE",
    `/api/t/tteam_acme/team/members/${encodeURIComponent("u_tteam_other")}`,
    editorCookie,
  );
  expect(res.status).toBe(403);
});

test("Editor can list invites — GET /api/t/:slug/team/invites → 200", async () => {
  await ensureTenant("tteam_acme");
  const cookie = await loginAs("u_tteam_editor", "tteam_acme", "editor");

  const res = await req("GET", "/api/t/tteam_acme/team/invites", cookie);
  expect(res.status).toBe(200);
  const invites = (await res.json()) as unknown[];
  expect(Array.isArray(invites)).toBe(true);
});

test("Editor gets 403 on PUT /api/t/:slug/team/members/:userId/role", async () => {
  await ensureTenant("tteam_acme");
  const editorCookie = await loginAs("u_tteam_editor", "tteam_acme", "editor");
  await setupUser("u_tteam_other");
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT DO NOTHING`,
    ["tteam_acme", "u_tteam_other", "viewer"],
  );

  const res = await req(
    "PUT",
    `/api/t/tteam_acme/team/members/${encodeURIComponent("u_tteam_other")}/role`,
    editorCookie,
    { role: "editor" },
  );
  expect(res.status).toBe(403);
});

test("PUT /team/members/:nonexistentId/role → 404", async () => {
  await ensureTenant("tteam_acme");
  const adminCookie = await loginAs("u_tteam_admin", "tteam_acme", "admin");

  const res = await req(
    "PUT",
    `/api/t/tteam_acme/team/members/${encodeURIComponent("u_does_not_exist")}/role`,
    adminCookie,
    { role: "editor" },
  );
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe("not_found");
});
