// DATABASE_URL is forced by test/preload-env.ts (bunfig [test].preload).
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgAll, pgRun } from "../src/pg.ts";
import * as repo from "../src/repo.ts";

const U = "u_publish";

beforeEach(async () => {
  await resetDb();
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ($1, 'Mira Patel', 'MP', 'mira@example.com')`,
    [U],
  );
});

test("fresh dimension: version 0, nothing published, no pending work", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  const s = await repo.getPublishState(dimId, "default");
  expect(s.version).toBe(0);
  expect(s.publishedAt).toBeNull();
  expect(s.pendingDrafts).toBe(0);
  expect(s.changedKeys).toEqual([]);
});

test("staged draft shows as pending; publish folds it and bumps version", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  await repo.saveDraft(dimId, "Deutschland", "mapped", "Germany", "germany", U, "default");

  let s = await repo.getPublishState(dimId, "default");
  expect(s.pendingDrafts).toBe(1);

  const r = await repo.commit(dimId, U, "default");
  expect(r.committed).toBe(1);

  s = await repo.getPublishState(dimId, "default");
  expect(s.version).toBe(1);
  expect(s.publishedByName).toBe("Mira Patel");
  expect(s.pendingDrafts).toBe(0);
  expect(s.changedKeys).toEqual([]);
});

test("record edit after publish shows as changed; record-only publish bumps version", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  await repo.saveDraft(dimId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(dimId, U, "default");

  await repo.addRecordOne(dimId, "South Sudan", undefined, U, "default");

  let s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual(["south_sudan"]);

  const r = await repo.commit(dimId, U, "default");
  expect(r.committed).toBe(0);

  s = await repo.getPublishState(dimId, "default");
  expect(s.version).toBe(2);
  expect(s.changedKeys).toEqual([]);
});

test("field edit shows as changed; publish clears it", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  const f = await repo.addField(dimId, "Region", "text", undefined, {}, U, "default");
  await repo.saveDraft(dimId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(dimId, U, "default");

  await repo.setFieldValue(dimId, "germany", f!.field, "Europe", U, "default");

  let s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual(["germany"]);

  await repo.commit(dimId, U, "default");
  s = await repo.getPublishState(dimId, "default");
  expect(s.version).toBe(2);
  expect(s.changedKeys).toEqual([]);
});

test("reverting an edit to its published value clears it from changed", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  const f = await repo.addField(dimId, "Region", "text", undefined, {}, U, "default");
  await repo.saveDraft(dimId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(dimId, U, "default");

  // Field edit, then revert to the published value (empty).
  await repo.setFieldValue(dimId, "germany", f!.field, "Europe", U, "default");
  let s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual(["germany"]);
  await repo.setFieldValue(dimId, "germany", f!.field, null, U, "default");
  s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual([]);

  // Rename, then revert to the published label.
  await repo.renameRecord(dimId, "germany", "Deutschland", U, 2, "default");
  s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual(["germany"]);
  await repo.renameRecord(dimId, "germany", "Germany", U, 3, "default");
  s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual([]);

  // Nothing net-changed → publish is a no-op.
  await repo.commit(dimId, U, "default");
  s = await repo.getPublishState(dimId, "default");
  expect(s.version).toBe(1);
});

test("never-published table counts every record, even without version rows", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  await repo.addRecordOne(dimId, "Germany", "germany", U, "default");
  // Bulk path: creates the record without a record_version row.
  await repo.addRecord(dimId, [{ key: "france", label: "France" }], "default");

  const s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual(["france", "germany"]);
});

test("field edit writes an audit entry for the activity feed", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  const f = await repo.addField(dimId, "Region", "text", undefined, {}, U, "default");
  await repo.addRecordOne(dimId, "Germany", "germany", U, "default");

  await repo.setFieldValue(dimId, "germany", f!.field, "Europe", U, "default");

  const rows = await pgAll<{ action: string; detail: string; row_key: string }>(
    `SELECT action, detail, row_key FROM "zugzug_app"."audit_log"
     WHERE table_id = $1 AND row_key = 'germany' AND action = 'Edited record'`,
    [dimId],
  );
  expect(rows.length).toBe(1);
  expect(rows[0]!.detail).toContain(f!.field);
});

test("revert all changes restores the last published version", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  const f = await repo.addField(dimId, "Notes", "text", undefined, {}, U, "default");
  await repo.addRecordOne(dimId, "Alpha", "alpha", U, "default");
  await repo.addRecordOne(dimId, "Beta", "beta", U, "default");
  await repo.commit(dimId, U, "default");

  // Drift: edit a field, add a record, remove a record.
  await repo.setFieldValue(dimId, "alpha", f!.field, "x", U, "default");
  await repo.addRecordOne(dimId, "Gamma", "gamma", U, "default");
  await repo.retireRecord(dimId, "beta", U, 1, "default");

  let s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual(["alpha", "beta", "gamma"]);
  expect(s.canRevert).toBe(true);

  const r = await repo.revertToPublished(dimId, U, "default");
  expect(r.reverted).toBe(3);

  s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual([]);

  const rows = await pgAll<{ key: string; label: string; notes: string | null }>(
    `SELECT country_code AS key, label, ${f!.field} AS notes FROM "zugzug"."dim_country" ORDER BY 1`,
  );
  expect(rows).toEqual([
    { key: "alpha", label: "Alpha", notes: null },
    { key: "beta", label: "Beta", notes: null },
  ]);
});

test("revert refuses when there is no published version", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  await repo.addRecordOne(dimId, "Alpha", "alpha", U, "default");
  const s = await repo.getPublishState(dimId, "default");
  expect(s.canRevert).toBe(false);
  await expect(repo.revertToPublished(dimId, U, "default")).rejects.toThrow(/publish/i);
});

test("publish with nothing to publish is a no-op (no version bump)", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  await repo.saveDraft(dimId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(dimId, U, "default");

  await repo.commit(dimId, U, "default");

  const s = await repo.getPublishState(dimId, "default");
  expect(s.version).toBe(1);
});
