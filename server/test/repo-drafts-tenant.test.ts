process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect, beforeEach, afterAll } from "bun:test";
import "./setup.ts"; // registers warehouse factories
import { pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as record from "../src/repo-record.ts";
import * as drafts from "../src/repo-drafts.ts";

const TA = "tdr_a";
const TB = "tdr_b";
const DIM = "tdr_country";

async function cleanup(): Promise<void> {
  // Clean by dim_id to catch any lingering rows regardless of tenant_id value
  await pgRun(`DELETE FROM "zugzug_app"."draft" WHERE dim_id = $1`, [DIM]);
  for (const t of [TA, TB]) {
    await pgRun(`DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."dimension_field" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."record_version" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [t]);
    await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [t]);
  }
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."dim_${DIM}"`);
  await pgRun(`DROP TABLE IF EXISTS "zugzug"."map_${DIM}"`);
}
beforeEach(cleanup);
afterAll(cleanup);

test("listDrafts is tenant-scoped", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await provisionTenant({ id: TB, label: "B" });
  // dim id is globally unique; second call is a no-op (returns early)
  await record.addDimension(DIM, [], { keyKind: "slug", silent: true }, "u_test", TA);

  await drafts.saveDraft(DIM, "FRA", "mapped", "France", "fr", "u_test", TA);

  expect((await drafts.listDrafts(DIM, TA)).map((d) => d.raw)).toContain("FRA");
  expect(await drafts.listDrafts(DIM, TB)).toEqual([]);
});

test("createDraft ON CONFLICT resets rejected_reason and rejected_by", async () => {
  await provisionTenant({ id: TA, label: "A" });
  await record.addDimension(DIM, [], { keyKind: "slug", silent: true }, "u_test", TA);

  // Seed a rejected draft directly so we have rejected_reason/rejected_by set
  await pgRun(
    `INSERT INTO "zugzug_app"."draft"
       (dim_id, raw, status, target_label, target_key, user_id, created_at, tenant_id,
        source, confidence, reasoning, rejected_reason, rejected_by)
     VALUES ($1, $2, 'rejected', 'Germany', 'de', 'u_test', current_timestamp, $3,
             'user', null, null, 'wrong mapping', 'u_reviewer')`,
    [DIM, "DEU", TA],
  );

  // createDraft should clear the rejection fields on conflict
  await drafts.createDraft(
    { dim_id: DIM, raw: "DEU", target_label: "Germany", target_key: "de", status: "mapped" },
    "u_test",
    TA,
  );

  const rows = await drafts.listDrafts(DIM, TA);
  const deu = rows.find((d) => d.raw === "DEU");
  expect(deu).toBeDefined();
  expect(deu!.status).toBe("mapped");
  expect(deu!.rejectedReason).toBeNull();
  expect(deu!.rejectedBy).toBeNull();
});
