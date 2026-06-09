process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
delete process.env.OIDC_ISSUER_URL;
process.env.ALLOWED_DOMAIN = "";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { handleSignup } from "../src/auth-password.ts";
import { handleCreateToken, getApiTokenUser } from "../src/auth-api-tokens.ts";
import { getSessionUser, issueSession } from "../src/auth.ts";

beforeEach(async () => {
  await resetDb();
});

async function signupUser(): Promise<string> {
  const res = await handleSignup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "bearer-int@example.com",
        password: "longenoughpw12",
        name: "Bearer User",
      }),
    }),
  );
  const { id } = (await res.json()) as { id: string };
  return id;
}

test("session gate components — bearer token authenticates when no cookie", async () => {
  const userId = await signupUser();
  const tokRes = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "int-test" }),
    }),
    userId,
  );
  const { value } = (await tokRes.json()) as { value: string };

  const req = new Request("http://localhost/api/anywhere", {
    headers: { Authorization: `Bearer ${value}` },
  });
  // Mirror the session gate's order: cookie first, then bearer.
  const cookieUser = await getSessionUser(req);
  expect(cookieUser).toBeNull();
  const bearerUser = await getApiTokenUser(req);
  expect(bearerUser?.id).toBe(userId);
});

test("session gate components — cookie wins when both present", async () => {
  const userId = await signupUser();
  // Create a token for the same user
  const tokRes = await handleCreateToken(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "cookie-wins" }),
    }),
    userId,
  );
  const { value } = (await tokRes.json()) as { value: string };

  // Issue a session cookie for the SAME user
  const { cookie } = await issueSession(userId);
  // Extract the cookie value from "zz_sid=...; Max-Age=...; ..."
  const sidValue = cookie.split(";")[0]; // "zz_sid=..."

  const req = new Request("http://localhost/api/anywhere", {
    headers: {
      Authorization: `Bearer ${value}`,
      cookie: sidValue,
    },
  });
  const cookieUser = await getSessionUser(req);
  expect(cookieUser?.id).toBe(userId);
  // Session gate would NOT call getApiTokenUser since cookieUser is truthy.
  // Confirm the gate's behavior: this test doesn't run the server; it just
  // verifies the precedence assumption (cookie auth succeeds → bearer skipped).
});
