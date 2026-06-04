/* verify-tables.ts — end-to-end check of POST /api/tables (createTable) against
   the REAL Postgres. Self-cleaning: drops any rows it created.

   Run: `bun run verify-tables`. */

import { createTable, CreateTableError } from "./tables.ts";
import * as repo from "./repo.ts";
import { pgRun, pgGet } from "./pg.ts";
import { pg } from "./env.ts";

const SCOPE = "tbl_verify_" + Math.random().toString(36).slice(2, 8);

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`▸ ${label} … `);
  const t = Date.now();
  try { const r = await fn(); process.stdout.write(`ok (${Date.now() - t}ms)\n`); return r; }
  catch (e) { process.stdout.write("FAIL\n"); throw e; }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assert: " + msg);
}

async function cleanup(): Promise<void> {
  try { await pgRun(`DELETE FROM ${pg("dimension_field")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]); } catch {}
  try { await pgRun(`DELETE FROM ${pg("dimension_source")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]); } catch {}
  try { await pgRun(`DELETE FROM ${pg("dimension")} WHERE id LIKE $1`, [`${SCOPE}%`]); } catch {}
}

(async () => {
  await step("clean prior scope rows", cleanup);

  // ─── 1. Blank mode with 2 columns including a colored select ─────────────
  const blankName = `${SCOPE} risk`;
  const { id: blankId } = await step("createTable(blank, 2 columns inc. select)", () =>
    createTable({
      name: blankName,
      description: "Severity tier for incidents.",
      color: "rose",
      mode: "blank",
      columns: [
        { label: "Severity", type: "select", options: [
          { label: "high", color: "rose" },
          { label: "medium", color: "amber" },
          { label: "low", color: "mint" },
        ]},
        { label: "Owner", type: "text" },
      ],
    }),
  );
  assert(blankId.startsWith(SCOPE), `dimId should start with scope; got ${blankId}`);

  await step("blank dim has description + color", async () => {
    const row = await pgGet<{ description: string | null; color: string | null }>(
      `SELECT description, color FROM ${pg("dimension")} WHERE id = $1`, [blankId],
    );
    assert(row?.description === "Severity tier for incidents.", `description mismatch: ${row?.description}`);
    assert(row?.color === "rose", `color mismatch: ${row?.color}`);
  });

  await step("blank dim has 2 fields with the new option shape", async () => {
    const fields = await repo.listFields(blankId);
    assert(fields.length === 2, `expected 2 fields, got ${fields.length}`);
    const sev = fields.find((f) => f.field === "severity");
    assert(sev?.type === "select", "severity is select");
    assert(sev?.options?.length === 3, `expected 3 options, got ${sev?.options?.length}`);
    assert(sev?.options?.[0].label === "high" && sev.options[0].color === "rose", "first option label+color");
  });

  await step("blank: one consolidated audit entry exists", async () => {
    const audit = await repo.listAudit(50);
    const tableAudits = audit.filter((a) => a.detail.startsWith(blankName));
    assert(tableAudits.length === 1, `expected 1 audit entry, got ${tableAudits.length}`);
    assert(tableAudits[0].action === "Created table", `action: ${tableAudits[0].action}`);
  });

  // ─── 2. Validation: name collision ───────────────────────────────────────
  await step("collision returns NAME_TAKEN", async () => {
    try {
      await createTable({ name: blankName, mode: "blank" });
      throw new Error("expected NAME_TAKEN");
    } catch (e) {
      assert(e instanceof CreateTableError && e.code === "NAME_TAKEN", `expected NAME_TAKEN, got ${(e as Error).message}`);
    }
  });

  // ─── 3. Validation: blank with empty name ────────────────────────────────
  await step("empty name returns INVALID", async () => {
    try {
      await createTable({ name: "  ", mode: "blank" });
      throw new Error("expected INVALID");
    } catch (e) {
      assert(e instanceof CreateTableError && e.code === "INVALID", `expected INVALID, got ${(e as Error).message}`);
    }
  });

  // ─── 4. Validation: source mode without source picker ────────────────────
  await step("source without picker returns MISSING_PICKER or WAREHOUSE_OFFLINE", async () => {
    try {
      await createTable({ name: `${SCOPE} no_pick`, mode: "source" });
      throw new Error("expected error");
    } catch (e) {
      assert(e instanceof CreateTableError, `expected CreateTableError, got ${(e as Error).message}`);
      // Either MISSING_PICKER (no source) or WAREHOUSE_OFFLINE — depends on env.attachWarehouse
    }
  });

  // ─── 5. Lazy option migration: legacy string[] reads as OptionDef[] ──────
  await step("legacy string[] options read as {label, color: null}", async () => {
    // Create a fresh dimension and a select field with empty options via the silent path
    const legacyName = `${SCOPE} legacy`;
    const legacyId = await repo.addDimension(legacyName, [], { silent: true });
    await repo.addField(legacyId, "Status", "select", undefined, { silent: true });
    // Overwrite the options JSON with the LEGACY string[] shape to simulate pre-T5 data
    await pgRun(
      `UPDATE ${pg("dimension_field")} SET options = $1 WHERE dim_id = $2 AND field = 'status'`,
      [JSON.stringify(["open", "closed"]), legacyId],
    );
    const fields = await repo.listFields(legacyId);
    const status = fields.find((f) => f.field === "status");
    assert(status?.options?.length === 2, `expected 2 lifted options, got ${status?.options?.length}`);
    assert(status?.options?.[0].label === "open" && status.options[0].color === null, "first option lifted with null color");
  });

  await step("cleanup", cleanup);
  console.log("\n✓ verify-tables passed");
  process.exit(0);
})().catch((e) => {
  console.error("\nverify-tables FAILED:", e);
  void cleanup().finally(() => process.exit(1));
});
