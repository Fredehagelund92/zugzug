/* reset-password.ts — Admin CLI to rewrite a user's password hash directly.
   Use this when a user has lost their password and you don't have an email
   reset flow (it's deferred to v1.1).

   Usage:
     bun run reset-password <email> <newpassword>

   Constraints:
     - Email must already exist in the users table
     - User must have auth_provider='password' (OIDC users authenticate via SSO)
     - Password must be at least 12 characters

   Exit codes: 0=success, 1=usage error, 2=user not found, 3=oidc user, 4=password too short. */

import { pgGet, pgRun } from "../src/pg.ts";
import { pg } from "../src/env.ts";

const MIN_PASSWORD_LENGTH = 12;

async function main(args: string[]): Promise<number> {
  if (args.length !== 2) {
    console.error("usage: bun run reset-password <email> <newpassword>");
    return 1;
  }
  const [email, password] = args;

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`error: password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    return 4;
  }

  const user = await pgGet<{ id: string; auth_provider: string }>(
    `SELECT id, auth_provider FROM ${pg("users")} WHERE lower(email) = lower($1)`,
    [email],
  );
  if (!user) {
    console.error(`error: no user with email ${email}`);
    return 2;
  }
  if (user.auth_provider !== "password") {
    console.error(
      `error: user has auth_provider='${user.auth_provider}' — they sign in via SSO, not password`,
    );
    return 3;
  }

  const hash = await Bun.password.hash(password);
  await pgRun(`UPDATE ${pg("users")} SET password_hash = $1 WHERE id = $2`, [hash, user.id]);
  console.log(`✓ password reset for ${email} (user id: ${user.id})`);
  return 0;
}

const code = await main(Bun.argv.slice(2));
process.exit(code);
