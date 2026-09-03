// DATABASE_URL is forced by test/preload-env.ts (bunfig [test].preload).
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgAll, pgRun } from "../src/pg.ts";
import * as repo from "../src/repo.ts";
import { getSnapshot } from "../src/repo-versions.ts";

const U = "u_publish";

beforeEach(async () => {
  await resetDb();
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, initials, email)
     VALUES ($1, 'Mira Patel', 'MP', 'mira@example.com')`,
    [U],
  );
});

test("fresh refTable: version 0, nothing published, no pending work", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  const s = await repo.getPublishState(refTableId, "default");
  expect(s.version).toBe(0);
  expect(s.publishedAt).toBeNull();
  expect(s.pendingDrafts).toBe(0);
  expect(s.changedKeys).toEqual([]);
});

test("staged draft shows as pending; publish folds it and bumps version", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  await repo.saveDraft(refTableId, "Deutschland", "mapped", "Germany", "germany", U, "default");

  let s = await repo.getPublishState(refTableId, "default");
  expect(s.pendingDrafts).toBe(1);

  const r = await repo.commit(refTableId, U, "default");
  expect(r.committed).toBe(1);

  s = await repo.getPublishState(refTableId, "default");
  expect(s.version).toBe(1);
  expect(s.publishedByName).toBe("Mira Patel");
  expect(s.pendingDrafts).toBe(0);
  expect(s.changedKeys).toEqual([]);
});

test("record edit after publish shows as changed; record-only publish bumps version", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  await repo.saveDraft(refTableId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(refTableId, U, "default");

  await repo.addRecordOne(refTableId, "South Sudan", undefined, U, "default");

  let s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual(["south_sudan"]);

  const r = await repo.commit(refTableId, U, "default");
  expect(r.committed).toBe(0);

  s = await repo.getPublishState(refTableId, "default");
  expect(s.version).toBe(2);
  expect(s.changedKeys).toEqual([]);
});

test("field edit shows as changed; publish clears it", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  const f = await repo.addField(refTableId, "Region", "text", undefined, {}, U, "default");
  await repo.saveDraft(refTableId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(refTableId, U, "default");

  await repo.setFieldValue(refTableId, "germany", f!.field, "Europe", U, "default");

  let s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual(["germany"]);

  await repo.commit(refTableId, U, "default");
  s = await repo.getPublishState(refTableId, "default");
  expect(s.version).toBe(2);
  expect(s.changedKeys).toEqual([]);
});

test("reverting an edit to its published value clears it from changed", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  const f = await repo.addField(refTableId, "Region", "text", undefined, {}, U, "default");
  await repo.saveDraft(refTableId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(refTableId, U, "default");

  // Field edit, then revert to the published value (empty).
  await repo.setFieldValue(refTableId, "germany", f!.field, "Europe", U, "default");
  let s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual(["germany"]);
  await repo.setFieldValue(refTableId, "germany", f!.field, null, U, "default");
  s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual([]);

  // Rename, then revert to the published label.
  await repo.renameRecord(refTableId, "germany", "Deutschland", U, 2, "default");
  s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual(["germany"]);
  await repo.renameRecord(refTableId, "germany", "Germany", U, 3, "default");
  s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual([]);

  // Nothing net-changed → publish is a no-op.
  await repo.commit(refTableId, U, "default");
  s = await repo.getPublishState(refTableId, "default");
  expect(s.version).toBe(1);
});

// Formula fields have no dim_ column, but the published snapshot carries their
// evaluated values (writeVersionSnapshot injects them for the Pull API). The
// changed-key diff must ignore them, or every stamped record in a table with a
// formula column stays "changed" forever and the count never returns to zero.
test("formula column: reverting an edit still clears it from changed", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  const region = await repo.addField(refTableId, "Region", "text", undefined, {}, U, "default");
  await repo.addField(
    refTableId,
    "Shout",
    "formula",
    undefined,
    { formula: { expr: "upper(label)", resultType: "text" } },
    U,
    "default",
  );
  await repo.saveDraft(refTableId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(refTableId, U, "default");

  // A fresh publish leaves nothing changed.
  let s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual([]);

  await repo.setFieldValue(refTableId, "germany", region!.field, "Europe", U, "default");
  s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual(["germany"]);

  await repo.setFieldValue(refTableId, "germany", region!.field, null, U, "default");
  s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual([]);
});

test("formula column: a boolean toggled back clears it from changed", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  const active = await repo.addField(refTableId, "Active", "boolean", undefined, {}, U, "default");
  await repo.addField(
    refTableId,
    "Bloc",
    "formula",
    undefined,
    { formula: { expr: 'IF([Active] = "true", "EU", "-")', resultType: "text" } },
    U,
    "default",
  );
  await repo.saveDraft(refTableId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(refTableId, U, "default"); // creates the record
  await repo.setFieldValue(refTableId, "germany", active!.field, "false", U, "default");
  await repo.commit(refTableId, U, "default"); // publishes false as the baseline

  await repo.setFieldValue(refTableId, "germany", active!.field, "true", U, "default");
  let s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual(["germany"]);

  await repo.setFieldValue(refTableId, "germany", active!.field, "false", U, "default");
  s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual([]);
});

test("never-published table counts every record, even without version rows", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  await repo.addRecordOne(refTableId, "Germany", "germany", U, "default");
  // Bulk path: creates the record without a record_version row.
  await repo.addRecord(refTableId, [{ key: "france", label: "France" }], "default");

  const s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual(["france", "germany"]);
});

test("field edit writes an audit entry for the activity feed", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  const f = await repo.addField(refTableId, "Region", "text", undefined, {}, U, "default");
  await repo.addRecordOne(refTableId, "Germany", "germany", U, "default");

  await repo.setFieldValue(refTableId, "germany", f!.field, "Europe", U, "default");

  const rows = await pgAll<{ action: string; detail: string; row_key: string }>(
    `SELECT action, detail, row_key FROM "zugzug_app"."audit_log"
     WHERE table_id = $1 AND row_key = 'germany' AND action = 'Edited record'`,
    [refTableId],
  );
  expect(rows.length).toBe(1);
  expect(rows[0]!.detail).toContain(f!.field);
});

test("revert all changes restores the last published version", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  const f = await repo.addField(refTableId, "Notes", "text", undefined, {}, U, "default");
  await repo.addRecordOne(refTableId, "Alpha", "alpha", U, "default");
  await repo.addRecordOne(refTableId, "Beta", "beta", U, "default");
  await repo.commit(refTableId, U, "default");

  // Drift: edit a field, add a record, remove a record.
  await repo.setFieldValue(refTableId, "alpha", f!.field, "x", U, "default");
  await repo.addRecordOne(refTableId, "Gamma", "gamma", U, "default");
  await repo.retireRecord(refTableId, "beta", U, 1, "default");

  let s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual(["alpha", "beta", "gamma"]);
  expect(s.canRevert).toBe(true);

  const r = await repo.revertToPublished(refTableId, U, "default");
  expect(r.reverted).toBe(3);

  s = await repo.getPublishState(refTableId, "default");
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
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  await repo.addRecordOne(refTableId, "Alpha", "alpha", U, "default");
  const s = await repo.getPublishState(refTableId, "default");
  expect(s.canRevert).toBe(false);
  await expect(repo.revertToPublished(refTableId, U, "default")).rejects.toThrow(/publish/i);
});

test("publish with nothing to publish is a no-op (no version bump)", async () => {
  const refTableId = await repo.addRefTable("Country", [], { keyKind: "slug" }, U, "default");
  await repo.saveDraft(refTableId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(refTableId, U, "default");

  await repo.commit(refTableId, U, "default");

  const s = await repo.getPublishState(refTableId, "default");
  expect(s.version).toBe(1);
});

test("manual reorder counts as an unpublished change and ships in the next version", async () => {
  const refTableId = await repo.addRefTable("Tier", [], { keyKind: "slug" }, U, "default");
  await repo.updateRefTableMeta(refTableId, { orderingMode: "manual" }, U, "default");
  await repo.addRecordOne(refTableId, "Gold", undefined, U, "default");
  await repo.addRecordOne(refTableId, "Silver", undefined, U, "default");
  await repo.addRecordOne(refTableId, "Bronze", undefined, U, "default");

  await repo.commit(refTableId, U, "default");
  let s = await repo.getPublishState(refTableId, "default");
  expect(s.version).toBe(1);
  expect(s.changedKeys).toEqual([]);

  // Drag Bronze to the top. No drafts are involved — this is the only change.
  await repo.reorderRecordRow(refTableId, "bronze", null, "gold", U, "default");

  s = await repo.getPublishState(refTableId, "default");
  expect(s.changedKeys).toEqual(["bronze"]);

  await repo.commit(refTableId, U, "default");
  s = await repo.getPublishState(refTableId, "default");
  expect(s.version).toBe(2);
  expect(s.changedKeys).toEqual([]);

  // The published snapshot carries the new order.
  const snap = await getSnapshot(refTableId, "default", 2);
  const ordered = [...snap!.records].sort((a, b) => Number(a.position) - Number(b.position));
  expect(ordered.map((r) => r.label)).toEqual(["Bronze", "Gold", "Silver"]);
});
