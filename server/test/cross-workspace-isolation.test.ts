process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.AUTH_MODE = "password";
process.env.ALLOWED_DOMAIN = "example.com";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { makeWorkspace, makeMember, makeRefTable, req } from "./factories/index.ts";

beforeEach(resetDb);

// ── Cross-workspace access control ───────────────────────────────────────────

test("non-member of B is forbidden from B's routes", async () => {
  await makeWorkspace("w_iso_a1");
  await makeWorkspace("w_iso_b1");
  const { cookie } = await makeMember("u_iso_a1", "w_iso_a1", "admin"); // member of A only
  const res = await req("GET", "/api/t/w_iso_b1/refTables", cookie);
  expect(res.status).toBe(403);
});

test("non-member of B is forbidden from a write route in B", async () => {
  await makeWorkspace("w_iso_a2");
  await makeWorkspace("w_iso_b2");
  const { cookie } = await makeMember("u_iso_a2", "w_iso_a2", "admin"); // member of A only
  const res = await req("POST", "/api/t/w_iso_b2/refTables", cookie, { name: "X" });
  expect(res.status).toBe(403);
});

// ── Unknown workspace slug ────────────────────────────────────────────────────

test("unknown workspace slug is 404", async () => {
  await makeWorkspace("w_iso_a3");
  const { cookie } = await makeMember("u_iso_a3", "w_iso_a3", "admin");
  const res = await req("GET", "/api/t/nope-nope/refTables", cookie);
  expect(res.status).toBe(404);
});

// ── Data isolation ────────────────────────────────────────────────────────────

test("a table in A is not visible from B, but B sees its own", async () => {
  await makeWorkspace("w_iso_a4");
  await makeWorkspace("w_iso_b4");
  const aDim = await makeRefTable("w_iso_a4", "Vendors");
  const bDim = await makeRefTable("w_iso_b4", "Customers");
  const { cookie: bCookie } = await makeMember("u_iso_b4", "w_iso_b4", "admin"); // member of B
  const list = await req("GET", "/api/t/w_iso_b4/refTables", bCookie);
  expect(list.status).toBe(200);
  const refTables = (await list.json()) as { id: string }[];
  // B sees its OWN table — proves the list is real and workspace-scoped, so the
  // absence of A's table below is a meaningful isolation result (not an empty list).
  expect(refTables.some((d) => d.id === bDim)).toBe(true);
  expect(refTables.some((d) => d.id === aDim)).toBe(false);
  const direct = await req("GET", `/api/t/w_iso_b4/refTables/${aDim}`, bCookie);
  expect(direct.status).toBe(404);
});
