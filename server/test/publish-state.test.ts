// DATABASE_URL is forced by test/preload-env.ts (bunfig [test].preload).
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import { pgRun } from "../src/pg.ts";
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

test("canonical edit after publish shows as changed; canonical-only publish bumps version", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  await repo.saveDraft(dimId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(dimId, U, "default");

  await repo.addCanonicalOne(dimId, "South Sudan", undefined, U, "default");

  let s = await repo.getPublishState(dimId, "default");
  expect(s.changedKeys).toEqual(["south_sudan"]);

  const r = await repo.commit(dimId, U, "default");
  expect(r.committed).toBe(0);

  s = await repo.getPublishState(dimId, "default");
  expect(s.version).toBe(2);
  expect(s.changedKeys).toEqual([]);
});

test("publish with nothing to publish is a no-op (no version bump)", async () => {
  const dimId = await repo.addDimension("Country", [], { keyKind: "slug" }, U, "default");
  await repo.saveDraft(dimId, "Deutschland", "mapped", "Germany", "germany", U, "default");
  await repo.commit(dimId, U, "default");

  await repo.commit(dimId, U, "default");

  const s = await repo.getPublishState(dimId, "default");
  expect(s.version).toBe(1);
});
