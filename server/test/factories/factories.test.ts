process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "../setup.ts";
import { pgGet } from "../../src/pg.ts";
import { makeUser, makeWorkspace, makeMember, req, makeRefTable } from "./index.ts";

beforeEach(resetDb);

test("makeUser inserts a user", async () => {
  await makeUser("u_fac");
  const row = await pgGet(`SELECT id FROM "zugzug_app"."users" WHERE id = $1`, ["u_fac"]);
  expect(row).not.toBeNull();
});

test("makeWorkspace + makeMember let an authed request succeed", async () => {
  await makeWorkspace("w_fac");
  const { cookie } = await makeMember("u_fac", "w_fac", "admin");
  const res = await req("GET", "/api/t/w_fac/team/members", cookie);
  expect(res.status).toBe(200);
});

test("req without a cookie is unauthorized", async () => {
  await makeWorkspace("w_fac");
  const res = await req("GET", "/api/t/w_fac/team/members");
  expect(res.status).toBe(401);
});

test("makeRefTable creates a table visible to the workspace", async () => {
  await makeWorkspace("w_fac");
  const id = await makeRefTable("w_fac", "Vendors");
  expect(typeof id).toBe("string");
  const { cookie } = await makeMember("u_fac", "w_fac", "viewer");
  const res = await req("GET", "/api/t/w_fac/refTables", cookie);
  expect(res.status).toBe(200);
  const refTables = (await res.json()) as { id: string }[];
  expect(refTables.some((d) => d.id === id)).toBe(true);
});
