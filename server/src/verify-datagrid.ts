/* verify-datagrid.ts — exercises the new DataGrid-backing endpoints end-to-end
   against the REAL Postgres. Self-cleaning: drops a throwaway dimension at the
   end so re-runs are idempotent.

   Run: `bun run verify-datagrid`. */

import * as repo from "./repo.ts";
import { ensureSchema } from "./schema.ts";
import { run } from "./db.ts";
import { pg } from "./env.ts";

const SCOPE = "dg_verify_" + Math.random().toString(36).slice(2, 8);

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`▸ ${label} … `);
  const t = Date.now();
  try { const r = await fn(); process.stdout.write(`ok (${Date.now() - t}ms)\n`); return r; }
  catch (e) { process.stdout.write("FAIL\n"); throw e; }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assert: " + msg);
}

async function cleanup() {
  // remove anything we created (best-effort)
  try { await run(`DELETE FROM ${pg("dimension_field")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]); } catch {}
  try { await run(`DELETE FROM ${pg("dimension_source")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]); } catch {}
  try { await run(`DELETE FROM ${pg("dimension")} WHERE id LIKE $1`, [`${SCOPE}%`]); } catch {}
}

(async () => {
  await ensureSchema();

  await step("clean prior scope rows", cleanup);

  const dimId = await step("create test dimension", async () => {
    return await repo.addDimension(`${SCOPE} country`, []);
  });
  assert(dimId.startsWith(SCOPE), "dimId should start with scope");

  await step("addField(text)", async () => {
    const r = await repo.addField(dimId, "Capital");
    assert(r?.field === "capital", `expected field 'capital', got ${r?.field}`);
  });

  await step("addField(select, options=[EMEA,AMER])", async () => {
    const r = await repo.addField(dimId, "Region", "select", ["EMEA", "AMER"]);
    assert(r?.field === "region", `expected field 'region', got ${r?.field}`);
    const fields = await repo.listFields(dimId);
    const region = fields.find((f) => f.field === "region");
    assert(region?.type === "select", "region type is select");
    assert(JSON.stringify(region?.options) === JSON.stringify(["EMEA", "AMER"]), `options mismatch: ${JSON.stringify(region?.options)}`);
  });

  await step("addColumnOption appends a new option", async () => {
    const r = await repo.addColumnOption(dimId, "region", "APAC");
    assert(JSON.stringify(r?.options) === JSON.stringify(["EMEA", "AMER", "APAC"]), `options after add: ${JSON.stringify(r?.options)}`);
  });

  await step("addColumnOption is idempotent on duplicate label", async () => {
    const r = await repo.addColumnOption(dimId, "region", "APAC");
    assert(JSON.stringify(r?.options) === JSON.stringify(["EMEA", "AMER", "APAC"]), `idempotent expected, got: ${JSON.stringify(r?.options)}`);
  });

  await step("addColumnOption refuses non-select column", async () => {
    const r = await repo.addColumnOption(dimId, "capital", "Berlin");
    assert(r === null, `expected null for non-select column, got: ${JSON.stringify(r)}`);
  });

  await step("cleanup", cleanup);

  console.log("\n✓ verify-datagrid (Phase 2): all checks passed");
  process.exit(0);
})().catch((e) => { console.error("\n✗ verify-datagrid:", e?.message ?? e); process.exit(1); });
