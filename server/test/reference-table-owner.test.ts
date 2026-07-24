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

test("owner can be set to a workspace member and is returned by getRefTable", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, OWNER, "default");
  await repo.updateRefTableMeta(refTableId, { ownerUserId: OWNER }, OWNER, "default");
  const refTable = await repo.getRefTable(refTableId, "default");
  expect(refTable?.ownerUserId).toBe(OWNER);
  expect(refTable?.ownerName).toBe("Mira Patel");
});

test("owner set to a non-member is rejected", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, OWNER, "default");
  await expect(
    repo.updateRefTableMeta(refTableId, { ownerUserId: OUTSIDER }, OWNER, "default"),
  ).rejects.toThrow(/member/i);
});

test("owner can be cleared with null", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, OWNER, "default");
  await repo.updateRefTableMeta(refTableId, { ownerUserId: OWNER }, OWNER, "default");
  await repo.updateRefTableMeta(refTableId, { ownerUserId: null }, OWNER, "default");
  const refTable = await repo.getRefTable(refTableId, "default");
  expect(refTable?.ownerUserId).toBeNull();
});
