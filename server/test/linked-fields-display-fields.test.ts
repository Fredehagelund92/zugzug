// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { pgAll } from "../src/pg.ts";
import { pg } from "../src/env.ts";

const tenantId = "default";
const userId = "u_test";

async function setupLink(): Promise<{ srcDim: string; tgtDim: string; fkField: string }> {
  const tgtDim = await repo.addDimension("Country", [], {}, userId, tenantId);
  await repo.addField(tgtDim, "ISO Code", "text", undefined, { silent: true }, userId, tenantId);
  await repo.addField(tgtDim, "Region", "text", undefined, { silent: true }, userId, tenantId);
  const srcDim = await repo.addDimension("Partner", [], {}, userId, tenantId);
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
  // Simulate target-dim field rename by replacing iso_code's row via direct UPDATE
  await pgAll(`UPDATE ${pg("dimension_field")} SET field = 'code' WHERE dim_id = $1 AND field = $2 AND tenant_id = $3`, [tgtDim, "iso_code", tenantId]);
  // The stored displayFields still references iso_code (stale). User keeps it and adds region — must succeed.
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
  const rows = await pgAll<{ action: string; metadata: string | null; detail: string }>(
    `SELECT action, metadata, detail FROM ${pg("audit_log")} WHERE tenant_id = $1 AND action = $2 ORDER BY created_at DESC`,
    [tenantId, "field.displayFields.update"],
  );
  expect(rows.length).toBe(1);
  expect(rows[0].detail).toBe(fkField);
  const meta = JSON.parse(rows[0].metadata ?? "{}");
  expect(meta.before).toEqual(["label"]);
  expect(meta.after).toEqual(["label", "iso_code"]);
});
