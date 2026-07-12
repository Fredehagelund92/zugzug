import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { requireAdmin, type TenantAuthContext } from "./auth.ts";
import { handleSignup } from "./auth-password.ts";
import { pgRun, pgGet } from "./pg.ts";

function ctx(role: "admin" | "editor" | "viewer", isSuperAdmin = false): TenantAuthContext {
  return { tenantId: "t1", role, isSuperAdmin };
}

// ── first-admin race fix ──────────────────────────────────────────────────────

const A_EMAIL = "race-a@zugzug.test";
const B_EMAIL = "race-b@zugzug.test";

async function signup(email: string): Promise<string> {
  const req = new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "test-password-ok", name: "Test User" }),
  });
  const res = await handleSignup(req);
  if (!res.ok) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function roleOf(userId: string): Promise<string | null> {
  const row = await pgGet<{ role: string }>(
    `SELECT role FROM "zugzug_app"."tenant_member" WHERE tenant_id = 'default' AND user_id = $1`,
    [userId],
  );
  return row?.role ?? null;
}

describe("first-admin role assignment", () => {
  beforeAll(async () => {
    // Ensure the 'default' tenant row exists (normally created by bootstrap).
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
       VALUES ('default', 'default', 'Default', now()) ON CONFLICT DO NOTHING`,
    );
    // Clear any leftover rows from a previous run.
    await pgRun(
      `DELETE FROM "zugzug_app"."users" WHERE email IN ($1, $2)`,
      [A_EMAIL, B_EMAIL],
    ).catch(() => {});
    // Invite user B so the second signup passes the invitation gate.
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant_invite"
         (tenant_id, email, role, invited_by, invited_at)
       VALUES ('default', $1, 'editor', 'system', now())
       ON CONFLICT DO NOTHING`,
      [B_EMAIL],
    );
  });

  afterAll(async () => {
    for (const email of [A_EMAIL, B_EMAIL]) {
      const row = await pgGet<{ id: string }>(
        `SELECT id FROM "zugzug_app"."users" WHERE email = $1`,
        [email],
      );
      if (!row) continue;
      await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [row.id]).catch(() => {});
      await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE user_id = $1`, [row.id]).catch(() => {});
    }
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE email IN ($1, $2)`, [A_EMAIL, B_EMAIL]).catch(() => {});
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE email = $1`, [B_EMAIL]).catch(() => {});
  });

  it("only the first signup becomes admin", async () => {
    const a = await signup(A_EMAIL);
    const b = await signup(B_EMAIL);
    expect(await roleOf(a)).toBe("admin");
    expect(await roleOf(b)).toBe("editor");
  });
});

// ── requireAdmin ──────────────────────────────────────────────────────────────

describe("requireAdmin", () => {
  it("admin role passes", () => {
    expect(requireAdmin(ctx("admin"))).toEqual({ ok: true, elevated: false });
  });
  it("super-admin viewer passes with elevated flag", () => {
    expect(requireAdmin(ctx("viewer", true))).toEqual({ ok: true, elevated: true });
  });
  it("super-admin admin passes with elevated=false (already admin)", () => {
    expect(requireAdmin(ctx("admin", true))).toEqual({ ok: true, elevated: false });
  });
  it("non-admin non-super-admin fails", () => {
    expect(requireAdmin(ctx("editor"))).toEqual({ ok: false });
    expect(requireAdmin(ctx("viewer"))).toEqual({ ok: false });
  });
  it("elevation flag matches expected actor_super_admin tag", () => {
    const elevated = requireAdmin(ctx("viewer", true));
    expect(elevated.ok && elevated.elevated).toBe(true);
    const native = requireAdmin(ctx("admin", false));
    expect(native.ok && !native.elevated).toBe(true);
  });
});
