// The signup/login email check is reachable with no session. Its regex has two
// trailing groups that both admit ".", so the engine tries every dot in the
// domain as the separator — quadratic. A ~32k-character address costs ~4s of
// Bun's single event loop, so one request stalls the whole server. A length
// bound ahead of the regex is what keeps that cheap.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";

import "./setup.ts";
import { test, expect } from "bun:test";
import { req } from "./factories/index.ts";

const PATHOLOGICAL = "a@" + "a.".repeat(32_000) + "@";

test("signup refuses a pathological address without backtracking", async () => {
  const started = Date.now();
  const r = await req("POST", "/api/auth/signup", undefined, {
    email: PATHOLOGICAL,
    password: "correct horse battery staple",
    name: "x",
  });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("login refuses a pathological address without backtracking", async () => {
  const started = Date.now();
  const r = await req("POST", "/api/auth/login", undefined, {
    email: PATHOLOGICAL,
    password: "x",
  });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(Date.now() - started).toBeLessThan(1000);
});
