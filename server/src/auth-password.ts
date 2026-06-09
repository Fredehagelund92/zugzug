/* auth-password.ts — Local email + password auth handlers.
   Active when env.authMode === "password" (i.e. OIDC_ISSUER_URL is unset).
   Uses Bun.password.hash/verify (argon2id default). */

import { env, pg } from "./env.ts";
import { pgRun, pgAll, pgGet } from "./pg.ts";
import { issueSession } from "./auth.ts";

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

  // First user becomes admin (and is added to allowlist).
  // Subsequent users must already be on the allowlist.
  const [{ n: userCount }] = await pgAll<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${pg("users")}`,
  );
  if (userCount === 0) {
    await pgRun(
      `INSERT INTO ${pg("allowed_emails")} (email, added_by, added_at)
       VALUES ($1, 'bootstrap', current_timestamp)
       ON CONFLICT (email) DO NOTHING`,
      [email],
    );
  } else {
    const allowed = await pgGet(`SELECT email FROM ${pg("allowed_emails")} WHERE email = $1`, [
      email,
    ]);
    if (!allowed) return jsonError(403, "not_allowed");
  }

  // Check email isn't already used (by either auth provider)
  const existing = await pgGet(`SELECT id FROM ${pg("users")} WHERE email = $1`, [email]);
  if (existing) return jsonError(409, "email_taken");

  // NOTE: userCount===0 is race-vulnerable under concurrent first-signups — both
  // could see count=0 and both become admin. Acceptable for v0.2; no lock added.
  const role = userCount === 0 ? "admin" : "editor";

  const hash = await Bun.password.hash(password); // argon2id default
  const userId = `u_${crypto.randomUUID().replace(/-/g, "")}`;
  await pgRun(
    `INSERT INTO ${pg("users")} (id, name, email, initials, password_hash, auth_provider, role)
     VALUES ($1, $2, $3, $4, $5, 'password', $6)`,
    [userId, name, email, initialsOf(name), hash, role],
  );

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
