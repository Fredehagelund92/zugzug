/* auth-password.ts — Local email + password auth handlers.
   Active when env.authMode === "password" (i.e. OIDC_ISSUER_URL is unset).
   Uses Bun.password.hash/verify (argon2id default). */

import { env, pg } from "./env.ts";
import { pgRun, pgGet, pgTx } from "./pg.ts";
import { issueSession, countRealLoginUsers } from "./auth.ts";
import { acceptInvitesFor } from "./tenant.ts";
import { log } from "./log.ts";

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 12;

interface SignupBody {
  email: string;
  password: string;
  name: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function initialsOf(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "??"
  );
}

/** POST /api/auth/signup — body: {email, password, name} */
export async function handleSignup(req: Request): Promise<Response> {
  let body: SignupBody;
  try {
    body = (await req.json()) as SignupBody;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim();

  if (!EMAIL_RX.test(email)) return jsonError(400, "invalid_email");
  if (password.length < MIN_PASSWORD_LENGTH) {
    return jsonError(400, "password_too_short", { minLength: MIN_PASSWORD_LENGTH });
  }
  if (!name) return jsonError(400, "name_required");
  if (env.allowedDomain && email.split("@")[1] !== env.allowedDomain) {
    return jsonError(400, "domain_not_allowed", { allowedDomain: env.allowedDomain });
  }

  // Check email isn't already used (by either auth provider) — fast pre-check
  // outside the lock so we can return 409 without acquiring the advisory lock.
  const existing = await pgGet(`SELECT id FROM ${pg("users")} WHERE email = $1`, [email]);
  if (existing) return jsonError(409, "email_taken");

  const hash = await Bun.password.hash(password); // argon2id default
  const userId = `u_${crypto.randomUUID().replace(/-/g, "")}`;

  // Serialize the first-admin decision: advisory lock prevents two concurrent
  // first-signups from both seeing count=0 and both becoming admin.
  const signupResult = await pgTx(async (tx) => {
    await tx.run(`SELECT pg_advisory_xact_lock(hashtext('zz:first-admin'))`);
    const userCount = await countRealLoginUsers(tx);

    // First user becomes admin and is seeded into the default tenant.
    // Subsequent users must already have a tenant_member or tenant_invite row.
    if (userCount > 0) {
      const allowed = await tx.get<{ ok: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM ${pg("tenant_member")} tm
             JOIN ${pg("users")} u ON u.id = tm.user_id
            WHERE u.email = $1
           UNION ALL
           SELECT 1 FROM ${pg("tenant_invite")} WHERE lower(email) = lower($1)
         ) AS ok`,
        [email],
      );
      if (!allowed?.ok) return { denied: true } as const;
    }

    const role = userCount === 0 ? "admin" : "editor";

    await tx.run(
      `INSERT INTO ${pg("users")} (id, name, email, initials, password_hash, auth_provider)
       VALUES ($1, $2, $3, $4, $5, 'password')`,
      [userId, name, email, initialsOf(name), hash],
    );

    // Seed default-tenant membership (first user = admin, rest = editor).
    await tx.run(
      `INSERT INTO ${pg("tenant_member")} (tenant_id, user_id, role, created_at)
       VALUES ('default', $1, $2, now())
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [userId, role],
    );

    return { denied: false } as const;
  });

  if (signupResult.denied) return jsonError(403, "not_allowed");

  try {
    await acceptInvitesFor(userId, email);
  } catch (e) {
    log({ level: "error", msg: "accept-invites-failed", userId, err: String(e) });
  }

  const { cookie } = await issueSession(userId);
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ id: userId, name, email }), { status: 200, headers });
}

/** POST /api/auth/login — body: {email, password} */
export async function handleLogin(req: Request): Promise<Response> {
  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  const password = String(body.password ?? "");

  // Generic error message — don't reveal whether email exists.
  const genericFail = jsonError(401, "invalid_credentials");

  if (!EMAIL_RX.test(email) || password.length === 0) return genericFail;

  const user = await pgGet<{
    id: string;
    name: string;
    email: string;
    password_hash: string | null;
    auth_provider: string;
  }>(`SELECT id, name, email, password_hash, auth_provider FROM ${pg("users")} WHERE email = $1`, [
    email,
  ]);
  if (!user || user.auth_provider !== "password" || !user.password_hash) return genericFail;

  const ok = await Bun.password.verify(password, user.password_hash);
  if (!ok) return genericFail;

  try {
    await acceptInvitesFor(user.id, email);
  } catch (e) {
    log({ level: "error", msg: "accept-invites-failed", userId: user.id, err: String(e) });
  }

  const { cookie } = await issueSession(user.id);
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ id: user.id, name: user.name, email: user.email }), {
    status: 200,
    headers,
  });
}

/** POST /api/auth/change-password — body: {currentPassword, newPassword}; authenticated. */
export async function handleChangePassword(req: Request, userId: string): Promise<Response> {
  let body: ChangePasswordBody;
  try {
    body = (await req.json()) as ChangePasswordBody;
  } catch {
    return jsonError(400, "invalid_json");
  }
  const current = String(body.currentPassword ?? "");
  const next = String(body.newPassword ?? "");

  if (next.length < MIN_PASSWORD_LENGTH) {
    return jsonError(400, "password_too_short", { minLength: MIN_PASSWORD_LENGTH });
  }

  const user = await pgGet<{ password_hash: string | null; auth_provider: string }>(
    `SELECT password_hash, auth_provider FROM ${pg("users")} WHERE id = $1`,
    [userId],
  );
  if (!user || user.auth_provider !== "password" || !user.password_hash) {
    return jsonError(400, "not_password_user");
  }
  const ok = await Bun.password.verify(current, user.password_hash);
  if (!ok) return jsonError(401, "wrong_current_password");

  const newHash = await Bun.password.hash(next);
  await pgRun(`UPDATE ${pg("users")} SET password_hash = $1 WHERE id = $2`, [newHash, userId]);

  return new Response(null, { status: 204 });
}
