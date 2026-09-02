// DATABASE_URL is forced by test/preload-env.ts (bunfig [test].preload).
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgGet, pgRun } from "../src/pg.ts";
import * as repo from "../src/repo.ts";
import { makeMember, makeWorkspace, req } from "./factories/index.ts";

const U = "u_grid_safety";
const T = "default";

beforeEach(async () => {
  await resetDb();
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ($1, 'Grid Tester', 'GT', 'grid@example.com')`,
    [U],
  );
});

/* ── Formula columns reference other columns by LABEL ─────────────────────── */

test("renaming a column a formula references is refused, and the formula keeps working", async () => {
  const refTableId = await repo.addRefTable("Widget", [], {}, U, T);
  await repo.addField(refTableId, "Price", "number", undefined, { silent: true }, U, T);
  await repo.addField(
    refTableId,
    "With VAT",
    "formula",
    undefined,
    { silent: true, formula: { expr: "Price * 1.2", resultType: "number" } },
    U,
    T,
  );
  await repo.addRecordOne(refTableId, "Bolt", undefined, U, T);
  await repo.setFieldValue(refTableId, "bolt", "price", "100", U, T);

  let thrown: { code?: string; status?: number; message?: string } = {};
  try {
    await repo.renameColumn(refTableId, "price", "Cost", U, T);
  } catch (e) {
    thrown = e as typeof thrown;
  }
  expect(thrown.code).toBe("VALIDATION_FAILED");
  expect(thrown.message).toContain("With VAT");

  const refTable = await repo.getRefTable(refTableId, T);
  expect(refTable?.fields.find((f) => f.field === "price")?.label).toBe("Price");
  const row = refTable?.record.find((r) => r.key === "bolt");
  expect(row?.fields?.with_vat).toBe("120");
  expect(row?.formulaErrors).toBeUndefined();
});

test("deleting a column a formula references is refused", async () => {
  const refTableId = await repo.addRefTable("Widget2", [], {}, U, T);
  await repo.addField(refTableId, "Price", "number", undefined, { silent: true }, U, T);
  await repo.addField(
    refTableId,
    "With VAT",
    "formula",
    undefined,
    { silent: true, formula: { expr: "Price * 1.2", resultType: "number" } },
    U,
    T,
  );

  let thrown: { code?: string; message?: string } = {};
  try {
    await repo.deleteColumn(refTableId, "price", U, T);
  } catch (e) {
    thrown = e as typeof thrown;
  }
  expect(thrown.code).toBe("VALIDATION_FAILED");
  expect(thrown.message).toContain("With VAT");
  const refTable = await repo.getRefTable(refTableId, T);
  expect(refTable?.fields.some((f) => f.field === "price")).toBe(true);
});

test("a rename with no formula depending on it still goes through", async () => {
  const refTableId = await repo.addRefTable("Widget3", [], {}, U, T);
  await repo.addField(refTableId, "Price", "number", undefined, { silent: true }, U, T);
  await repo.renameColumn(refTableId, "price", "Cost", U, T);
  const refTable = await repo.getRefTable(refTableId, T);
  expect(refTable?.fields.find((f) => f.field === "price")?.label).toBe("Cost");
});

/* ── Deleting a table takes its dependents with it ────────────────────────── */

test("deleting a table drops the linked columns on other tables that point at it", async () => {
  const targetId = await repo.addRefTable("Region", [], {}, U, T);
  await repo.addRecordOne(targetId, "EMEA", undefined, U, T);
  const holderId = await repo.addRefTable("Office", [], {}, U, T);
  const added = await repo.addField(
    holderId,
    "Region",
    "linked",
    undefined,
    { silent: true, referencedRefTableId: targetId },
    U,
    T,
  );
  expect(added?.field).toBe("region");
  await repo.addRecordOne(holderId, "Oslo", undefined, U, T);

  await repo.deleteRefTable(targetId, U, T);

  // No orphan field row is left to accept whatever gets typed into it.
  const orphan = await pgGet<{ field: string }>(
    `SELECT field FROM "zugzug_app"."reference_table_field"
      WHERE tenant_id = $1 AND type = 'linked'
        AND field_config::jsonb ->> 'targetRefTableId' = $2`,
    [T, targetId],
  );
  expect(orphan).toBeFalsy();
  const refTable = await repo.getRefTable(holderId, T);
  expect(refTable?.fields.some((f) => f.field === "region")).toBe(false);
});

/* ── Unparseable date cell values are a refusal, not a 500 ────────────────── */

test("pasting text that isn't a date into a date column is a 4xx, not a crash", async () => {
  const refTableId = await repo.addRefTable("Contract", [], {}, U, T);
  await repo.addField(refTableId, "Signed", "date", undefined, { silent: true }, U, T);
  await repo.addRecordOne(refTableId, "Acme", undefined, U, T);
  await repo.setFieldValue(refTableId, "acme", "signed", "2026-01-31", U, T);

  let thrown: { code?: string; status?: number } = {};
  try {
    await repo.setFieldValue(refTableId, "acme", "signed", "hello", U, T);
  } catch (e) {
    thrown = e as typeof thrown;
  }
  expect(thrown.code).toBe("VALIDATION_FAILED");
  expect(thrown.status).toBeGreaterThanOrEqual(400);
  expect(thrown.status).toBeLessThan(500);

  // The refusal left the stored value alone.
  const refTable = await repo.getRefTable(refTableId, T);
  expect(refTable?.record.find((r) => r.key === "acme")?.fields?.signed).toBe("2026-01-31");
});

/* ── The single-table read carries the publish summary ────────────────────── */

test("GET /tables/:id keeps the publish summary after a cell edit", async () => {
  const ws = await makeWorkspace("gridsafe", "Grid Safe");
  const { cookie } = await makeMember("u_grid_http", ws, "admin");
  const refTableId = await repo.addRefTable("Country", [], {}, "u_grid_http", ws);
  await repo.addField(refTableId, "Region", "text", undefined, { silent: true }, "u_grid_http", ws);
  await repo.addRecordOne(refTableId, "Norway", undefined, "u_grid_http", ws);
  await repo.commit(refTableId, "u_grid_http", ws);

  await repo.setFieldValue(refTableId, "norway", "region", "Europe", "u_grid_http", ws);

  const res = await req("GET", `/api/t/${ws}/tables/${refTableId}`, cookie);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { publish?: { version: number } };
  expect(body.publish).toBeDefined();
  expect(body.publish?.version).toBe(1);
});
