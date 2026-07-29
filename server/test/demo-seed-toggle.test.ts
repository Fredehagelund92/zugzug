// End-to-end check against the real demo dataset (the one on demo.zugzughq.com):
// the Country table pairs a boolean column ("EU member") with a formula column
// ("Bloc"), which is exactly the combination that pinned the change count.
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgRun, pgGet } from "../src/pg.ts";
import * as repo from "../src/repo.ts";
import { seedDemo } from "../src/seed.ts";

beforeEach(async () => {
  await resetDb();
  for (const [id, name] of [
    ["u_ada", "Ada"],
    ["u_li", "Li"],
    ["u_cory", "Cory"],
  ]) {
    await pgRun(
      `INSERT INTO "zugzug_app"."users" (id, name, initials, email) VALUES ($1, $2, $3, $4)`,
      [id, name, name.slice(0, 2).toUpperCase(), `${id}@example.com`],
    );
  }
});

test("demo Country table: toggling EU member back clears the change count", async () => {
  await seedDemo();

  const t = await pgGet<{ id: string }>(
    `SELECT id FROM "zugzug_app"."reference_table" WHERE label = 'Country' AND tenant_id = 'default'`,
  );
  const f = await pgGet<{ field: string }>(
    `SELECT field FROM "zugzug_app"."reference_table_field"
     WHERE reference_table_id = $1 AND label = 'EU member' AND tenant_id = 'default'`,
    [t!.id],
  );

  // Start from a clean published baseline, as the demo does.
  await repo.commit(t!.id, "u_ada", "default");
  let s = await repo.getPublishState(t!.id, "default");
  expect(s.changedKeys).toEqual([]);
  expect(s.pendingDrafts + s.changedKeys.length).toBe(0);

  // Germany ships as an EU member — untick it.
  await repo.setFieldValue(t!.id, "de", f!.field, "false", "u_ada", "default");
  s = await repo.getPublishState(t!.id, "default");
  expect(s.changedKeys).toEqual(["de"]);

  // Tick it back: the count must return to zero.
  await repo.setFieldValue(t!.id, "de", f!.field, "true", "u_ada", "default");
  s = await repo.getPublishState(t!.id, "default");
  expect(s.changedKeys).toEqual([]);
  expect(s.pendingDrafts + s.changedKeys.length).toBe(0);
});
