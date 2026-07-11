// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgRun } from "../src/pg.ts";
import * as repo from "../src/repo.ts";

const OWNER = "u_owner";
const OUTSIDER = "u_outsider";

beforeEach(async () => {
  await resetDb();
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ($1, 'Mira Patel', 'MP', 'mira@example.com'),
            ($2, 'Ola Nordmann', 'ON', 'ola@example.com')`,
    [OWNER, OUTSIDER],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
     VALUES ('default', $1, 'editor', now())`,
    [OWNER],
  );
});

test("owner can be set to a workspace member and is returned by getDimension", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, OWNER, "default");
  await repo.updateDimensionMeta(dimId, { ownerUserId: OWNER }, OWNER, "default");
  const dim = await repo.getDimension(dimId, "default");
  expect(dim?.ownerUserId).toBe(OWNER);
  expect(dim?.ownerName).toBe("Mira Patel");
});

test("owner set to a non-member is rejected", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, OWNER, "default");
  await expect(
    repo.updateDimensionMeta(dimId, { ownerUserId: OUTSIDER }, OWNER, "default"),
  ).rejects.toThrow(/member/i);
});

test("owner can be cleared with null", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, OWNER, "default");
  await repo.updateDimensionMeta(dimId, { ownerUserId: OWNER }, OWNER, "default");
  await repo.updateDimensionMeta(dimId, { ownerUserId: null }, OWNER, "default");
  const dim = await repo.getDimension(dimId, "default");
  expect(dim?.ownerUserId).toBeNull();
});
