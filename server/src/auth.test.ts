import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { requireAdmin, countRealLoginUsers, type TenantAuthContext } from "./auth.ts";
import { handleSignup } from "./auth-password.ts";
import { pgRun, pgGet, pgTx } from "./pg.ts";

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
    // The first-admin gate keys off the GLOBAL users count (handleSignup:
    // userCount === 0 -> admin), so this test's precondition is an empty users
    // table. The suite shares one Postgres DB and bun runs files in a
    // filesystem order that differs macOS vs Linux (CI), so an earlier file may
    // leave a user behind — clear the whole table, not just A/B. There are no
    // FKs into users, and every test file provisions its own users.
    await pgRun(`DELETE FROM "zugzug_app"."users"`).catch(() => {});
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
      await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [row.id]).catch(
        () => {},
      );
      await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE user_id = $1`, [row.id]).catch(
        () => {},
      );
    }
    await pgRun(`DELETE FROM "zugzug_app"."users" WHERE email IN ($1, $2)`, [
      A_EMAIL,
      B_EMAIL,
    ]).catch(() => {});
    await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE email = $1`, [B_EMAIL]).catch(
      () => {},
    );
  });

  it("only the first signup becomes admin", async () => {
    const a = await signup(A_EMAIL);
    const b = await signup(B_EMAIL);
    expect(await roleOf(a)).toBe("admin");
    expect(await roleOf(b)).toBe("editor");
  });

  it("seeded placeholder (null password_hash) does not block the first real signup from becoming admin", async () => {
    const PLACEHOLDER_EMAIL = "placeholder-test@zugzug.test";

    // Start from a clean state: only the seeded placeholder, no real login accounts.
    await pgRun(`DELETE FROM "zugzug_app"."users"`).catch(() => {});
    // Simulate a bootstrap-seeded placeholder user (no password, no login).
    await pgRun(
      `INSERT INTO "zugzug_app"."users" (id, name, initials, auth_provider)
       VALUES ('u_system', 'Auto-match', 'AM', 'password')`,
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."tenant_invite"
         (tenant_id, email, role, invited_by, invited_at)
       VALUES ('default', $1, 'editor', 'system', now())
       ON CONFLICT DO NOTHING`,
      [PLACEHOLDER_EMAIL],
    );

    let placeholderUserId: string | undefined;
    try {
      const id = await signup(PLACEHOLDER_EMAIL);
      placeholderUserId = id;
      expect(await roleOf(id)).toBe("admin");
    } finally {
      // Clean up placeholder user and the real signup.
      await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = 'u_system'`).catch(() => {});
      await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE user_id = 'u_system'`).catch(
        () => {},
      );
      await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = 'u_system'`).catch(() => {});
      await pgRun(`DELETE FROM "zugzug_app"."tenant_invite" WHERE email = $1`, [
        PLACEHOLDER_EMAIL,
      ]).catch(() => {});
      if (placeholderUserId) {
        await pgRun(`DELETE FROM "zugzug_app"."sessions" WHERE user_id = $1`, [
          placeholderUserId,
        ]).catch(() => {});
        await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE user_id = $1`, [
          placeholderUserId,
        ]).catch(() => {});
        await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [placeholderUserId]).catch(
          () => {},
        );
      }
    }
  });
});

// ── shared first-admin predicate ──────────────────────────────────────────────
// countRealLoginUsers is the single source of truth for "how many real accounts
// exist" in the first-admin election. Seeded placeholders (u_system, demo team —
// null password_hash, auth_provider='password') must not count, or they'd block
// the first real signup (password OR OIDC) from becoming admin.
describe("countRealLoginUsers (shared first-admin predicate)", () => {
  beforeEach(async () => {
    await pgRun(`DELETE FROM "zugzug_app"."users"`).catch(() => {});
  });
  afterAll(async () => {
    await pgRun(`DELETE FROM "zugzug_app"."users"`).catch(() => {});
  });

  it("excludes seeded placeholders (null password_hash, auth_provider='password')", async () => {
    await pgRun(
      `INSERT INTO "zugzug_app"."users" (id, name, initials, auth_provider) VALUES
         ('u_system', 'Auto-match', 'AM', 'password'),
         ('u_ada', 'Ada Berg', 'AB', 'password')`,
    );
    const n = await pgTx((tx) => countRealLoginUsers(tx));
    expect(n).toBe(0);
  });

  it("counts real password and OIDC accounts, not placeholders", async () => {
    await pgRun(
      `INSERT INTO "zugzug_app"."users" (id, name, initials, auth_provider) VALUES
         ('u_system', 'Auto-match', 'AM', 'password')`,
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."users" (id, name, initials, auth_provider, password_hash)
       VALUES ('u_pw', 'PW User', 'PW', 'password', '$argon2id$fake')`,
    );
    await pgRun(
      `INSERT INTO "zugzug_app"."users" (id, name, initials, auth_provider, google_sub)
       VALUES ('u_oidc', 'OIDC User', 'OU', 'oidc', 'sub-123')`,
    );
    const n = await pgTx((tx) => countRealLoginUsers(tx));
    expect(n).toBe(2); // u_pw + u_oidc; u_system excluded
  });
});

// ── cross-path first-admin invariants ─────────────────────────────────────────
// A source-text assertion is a smell in general; here it is the honest cheap
// guard for cross-file invariants that no integration test can reach without
// an OIDC issuer.
describe("cross-path first-admin election", () => {
  it("password and OIDC first-admin paths share one advisory lock key", async () => {
    const pw = await Bun.file("src/auth-password.ts").text();
    const oidc = await Bun.file("src/auth-oidc.ts").text();
    const key = "hashtext('zz:first-admin')";
    expect(pw).toContain(key);
    expect(oidc).toContain(key);
  });

  it("both paths elect first-admin via the shared countRealLoginUsers helper (no divergent inline count)", async () => {
    const pw = await Bun.file("src/auth-password.ts").text();
    const oidc = await Bun.file("src/auth-oidc.ts").text();
    expect(pw).toContain("countRealLoginUsers");
    expect(oidc).toContain("countRealLoginUsers");
    // Neither may keep an unfiltered users count for the election.
    expect(pw).not.toContain("count(*)::int AS n FROM");
    expect(oidc).not.toContain("count(*)::int AS n FROM");
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
