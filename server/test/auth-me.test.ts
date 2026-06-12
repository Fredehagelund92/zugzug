process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
delete process.env.OIDC_ISSUER_URL;
process.env.ALLOWED_DOMAIN = "";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { handleMe, issueSession } from "../src/auth.ts";
import { handleSignup } from "../src/auth-password.ts";

beforeEach(async () => {
  await resetDb();
});

test("GET /api/auth/me — returns user identity for authenticated user", async () => {
  const signup = await handleSignup(
    new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "me@example.com", password: "longenoughpw12", name: "Me" }),
    }),
  );
  const { id } = (await signup.json()) as { id: string };
  const { cookie } = await issueSession(id);
  const sidCookie = cookie.split(";")[0]; // "zz_sid=..."

  const res = await handleMe(
    new Request("http://localhost/api/auth/me", {
      headers: { cookie: sidCookie },
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    id: string;
    name: string;
    email: string;
    initials: string;
  };
  expect(body.id).toBe(id);
  // role is no longer part of SessionUser (PR5); it lives on tenant_member rows
  expect("role" in body).toBe(false);
});

test("GET /api/auth/me — 401 when not authenticated", async () => {
  const res = await handleMe(new Request("http://localhost/api/auth/me"));
  expect(res.status).toBe(401);
});
