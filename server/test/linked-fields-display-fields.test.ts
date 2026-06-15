// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { pgAll } from "../src/pg.ts";
import { pg } from "../src/env.ts";

const tenantId = "default";
const userId = "u_test";

let SETUP_COUNTER = 0;

async function setupLink(): Promise<{ srcDim: string; tgtDim: string; fkField: string }> {
  const tag = `${++SETUP_COUNTER}_${process.pid}`;
  const tgtDim = await repo.addDimension(`Country_${tag}`, [], {}, userId, tenantId);
  await repo.addField(tgtDim, "ISO Code", "text", undefined, { silent: true }, userId, tenantId);
  await repo.addField(tgtDim, "Region", "text", undefined, { silent: true }, userId, tenantId);
  const srcDim = await repo.addDimension(`Partner_${tag}`, [], {}, userId, tenantId);
  await repo.addField(
    srcDim,
    "Country",
    "linked",
    undefined,
    {
      silent: true,
      referencedDimId: tgtDim,
      displayFields: ["label"],
    },
    userId,
    tenantId,
  );
  return { srcDim, tgtDim, fkField: "country" };
}

beforeEach(async () => { await resetDb(); });

test("displayFields update accepts label + valid target fields", async () => {
  const { srcDim, fkField } = await setupLink();
  await repo.updateField(
    srcDim,
    fkField,
    { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code"] }) },
    userId,
    tenantId,
  );
  const dim = await repo.getDimension(srcDim, tenantId);
  const cfg = dim?.fields.find((f) => f.field === fkField);
  expect(cfg?.displayFields).toEqual(["label", "iso_code"]);
});

test("displayFields update rejects missing label", async () => {
  const { srcDim, fkField } = await setupLink();
  await expect(
    repo.updateField(
      srcDim,
      fkField,
      { fieldConfig: JSON.stringify({ displayFields: ["iso_code"] }) },
      userId,
      tenantId,
    ),
  ).rejects.toThrow(/must include "label"/i);
});

test("displayFields update rejects duplicates", async () => {
  const { srcDim, fkField } = await setupLink();
  await expect(
    repo.updateField(
      srcDim,
      fkField,
      { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code", "iso_code"] }) },
      userId,
      tenantId,
    ),
  ).rejects.toThrow(/duplicate/i);
});

test("displayFields update rejects field not on target dim", async () => {
  const { srcDim, fkField } = await setupLink();
  await expect(
    repo.updateField(
      srcDim,
      fkField,
      { fieldConfig: JSON.stringify({ displayFields: ["label", "does_not_exist"] }) },
      userId,
      tenantId,
    ),
  ).rejects.toThrow(/does_not_exist/);
});

test("displayFields update tolerates stale entries that were already stored (recovery path)", async () => {
  const { srcDim, fkField, tgtDim } = await setupLink();
  await repo.updateField(
    srcDim,
    fkField,
    { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code"] }) },
    userId,
    tenantId,
  );
  // Simulate target-dim field deletion (the real "stale" scenario):
  // ISO Code is removed from Country; the stored displayFields still references it.
  // No repo.deleteField exists, so do a raw DELETE — uniquely-tagged dims ensure no cruft.
  await pgAll(
    `DELETE FROM ${pg("dimension_field")} WHERE dim_id = $1 AND field = $2 AND tenant_id = $3`,
    [tgtDim, "iso_code", tenantId],
  );
  // The user keeps iso_code in displayFields AND adds region — must succeed (recovery path).
  await repo.updateField(
    srcDim,
    fkField,
    { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code", "region"] }) },
    userId,
    tenantId,
  );
  const dim = await repo.getDimension(srcDim, tenantId);
  const cfg = dim?.fields.find((f) => f.field === fkField);
  expect(cfg?.displayFields).toEqual(["label", "iso_code", "region"]);
});

test("targetDimId is immutable", async () => {
  const { srcDim, fkField } = await setupLink();
  const otherDim = await repo.addDimension("Channel", [], {}, userId, tenantId);
  await expect(
    repo.updateField(
      srcDim,
      fkField,
      { fieldConfig: JSON.stringify({ targetDimId: otherDim }) },
      userId,
      tenantId,
    ),
  ).rejects.toThrow(/targetDimId.*immutable/i);
});

test("displayFields update appends audit entry with before/after", async () => {
  const { srcDim, fkField } = await setupLink();
  await repo.updateField(
    srcDim,
    fkField,
    { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code"] }) },
    userId,
    tenantId,
  );
  const rows = await pgAll<{ action: string; metadata: string | null; detail: string; table_id: string | null }>(
    `SELECT action, metadata, detail, table_id FROM ${pg("audit_log")}
     WHERE tenant_id = $1 AND action = $2 AND table_id = $3 AND detail = $4
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, "field.displayFields.update", srcDim, fkField],
  );
  expect(rows.length).toBe(1);
  expect(rows[0].detail).toBe(fkField);
  expect(rows[0].table_id).toBe(srcDim);
  const meta = JSON.parse(rows[0].metadata ?? "{}");
  expect(meta.before).toEqual(["label"]);
  expect(meta.after).toEqual(["label", "iso_code"]);
});
