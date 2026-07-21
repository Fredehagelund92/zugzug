/* verify-datagrid.ts — exercises the new DataGrid-backing endpoints end-to-end
   against the REAL Postgres. Self-cleaning: drops a throwaway dimension at the
   end so re-runs are idempotent.

   Run: `bun run verify-datagrid`. */

import * as repo from "./repo.ts";
import { pgRun } from "./pg.ts";
import { pg } from "./env.ts";
import { runMigrations } from "../drizzle/migrate.ts";

const T = "default";

const SCOPE = "dg_verify_" + Math.random().toString(36).slice(2, 8);

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`▸ ${label} … `);
  const t = Date.now();
  try {
    const r = await fn();
    process.stdout.write(`ok (${Date.now() - t}ms)\n`);
    return r;
  } catch (e) {
    process.stdout.write("FAIL\n");
    throw e;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("assert: " + msg);
}

async function cleanup() {
  // remove anything we created (best-effort)
  try {
    await pgRun(`DELETE FROM ${pg("dimension_field")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]);
  } catch {
    /* best-effort cleanup */
  }
  try {
    await pgRun(`DELETE FROM ${pg("dimension_source")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]);
  } catch {
    /* best-effort cleanup */
  }
  try {
    await pgRun(`DELETE FROM ${pg("dimension")} WHERE id LIKE $1`, [`${SCOPE}%`]);
  } catch {
    /* best-effort cleanup */
  }
}

(async () => {
  await runMigrations();

  await step("clean prior scope rows", cleanup);

  const dimId = await step("create test dimension", async () => {
    return await repo.addDimension(`${SCOPE} country`, [], {}, "u_verify", T);
  });
  assert(dimId.startsWith(SCOPE), "dimId should start with scope");

  await step("addField(text)", async () => {
    const r = await repo.addField(dimId, "Capital", "text", undefined, {}, "u_verify", T);
    assert(r?.field === "capital", `expected field 'capital', got ${r?.field}`);
  });

  await step("addField(select, options=[EMEA,AMER])", async () => {
    const r = await repo.addField(
      dimId,
      "Region",
      "select",
      [
        { label: "EMEA", color: null },
        { label: "AMER", color: null },
      ],
      {},
      "u_verify",
      T,
    );
    assert(r?.field === "region", `expected field 'region', got ${r?.field}`);
    const fields = await repo.listFields(dimId, T);
    const region = fields.find((f) => f.field === "region");
    assert(region?.type === "select", "region type is select");
    const labels = region?.options?.map((o) => o.label);
    assert(
      JSON.stringify(labels) === JSON.stringify(["EMEA", "AMER"]),
      `options mismatch: ${JSON.stringify(region?.options)}`,
    );
  });

  await step("addColumnOption appends a new option", async () => {
    const r = await repo.addColumnOption(dimId, "region", "APAC", null, {}, "u_verify", T);
    const labels = r?.options?.map((o) => o.label);
    assert(
      JSON.stringify(labels) === JSON.stringify(["EMEA", "AMER", "APAC"]),
      `options after add: ${JSON.stringify(r?.options)}`,
    );
  });

  await step("addColumnOption is idempotent on duplicate label", async () => {
    const r = await repo.addColumnOption(dimId, "region", "APAC", null, {}, "u_verify", T);
    const labels = r?.options?.map((o) => o.label);
    assert(
      JSON.stringify(labels) === JSON.stringify(["EMEA", "AMER", "APAC"]),
      `idempotent expected, got: ${JSON.stringify(r?.options)}`,
    );
  });

  await step("addColumnOption refuses non-select column", async () => {
    const r = await repo.addColumnOption(dimId, "capital", "Berlin", null, {}, "u_verify", T);
    assert(r === null, `expected null for non-select column, got: ${JSON.stringify(r)}`);
  });

  // ---- Phase 3: grid layout + column rename / change-type / delete ----

  const USER = "u_ada";

  await step("setGridLayout writes config", async () => {
    await repo.setGridLayout(USER, dimId, {
      widths: { region: 120 },
      order: ["region", "capital"],
      hidden: [],
    });
    const r = await repo.getGridLayout(USER, dimId);
    assert(r.widths?.region === 120, `widths.region: ${r.widths?.region}`);
    assert(
      JSON.stringify(r.order) === JSON.stringify(["region", "capital"]),
      `order: ${JSON.stringify(r.order)}`,
    );
  });

  await step("renameColumn updates the label", async () => {
    await repo.renameColumn(dimId, "capital", "Capital city", "u_verify", T);
    const fields = await repo.listFields(dimId, T);
    const cap = fields.find((f) => f.field === "capital");
    assert(cap?.label === "Capital city", `label: ${cap?.label}`);
  });

  await step("changeColumnType text → select seeds options from distinct values", async () => {
    // first, add a couple of canonical rows and set capital values
    await repo.addCanonicalOne(dimId, "Denmark", "denmark", "u_verify", T);
    await repo.addCanonicalOne(dimId, "Germany", "germany", "u_verify", T);
    await repo.setFieldValue(dimId, "denmark", "capital", "Copenhagen", "u_verify", T);
    await repo.setFieldValue(dimId, "germany", "capital", "Berlin", "u_verify", T);
    const res = await repo.changeColumnType(
      dimId,
      "capital",
      {
        newType: "select",
        coerceInvalidToNull: false,
        userId: "u_verify",
      },
      T,
    );
    assert(res.ok, `changeColumnType failed: ${JSON.stringify(res)}`);
    const fields = await repo.listFields(dimId, T);
    const cap = fields.find((f) => f.field === "capital");
    assert(cap?.type === "select", `type after change: ${cap?.type}`);
    const capLabels = cap?.options?.map((o) => o.label);
    assert(
      capLabels && capLabels.includes("Copenhagen") && capLabels.includes("Berlin"),
      `options after change: ${JSON.stringify(cap?.options)}`,
    );
  });

  await step("deleteColumn drops dim_field + cell values", async () => {
    const r = await repo.deleteColumn(dimId, "capital", "u_verify", T);
    assert(r.ok, "deleteColumn ok");
    const fields = await repo.listFields(dimId, T);
    assert(
      !fields.some((f) => f.field === "capital"),
      `capital still present: ${JSON.stringify(fields)}`,
    );
  });

  // ---- Phase 4: rating, url, and email field types ----

  const ratingFieldId = await step("addField(rating)", async () => {
    const result = await repo.addField(
      dimId,
      "Quality",
      "rating",
      undefined,
      { ratingMax: 5 },
      "u_verify",
      T,
    );
    assert(result != null, "addField(rating) returned null");
    return result.field;
  });

  await step("listFields returns ratingMax", async () => {
    const fields = await repo.listFields(dimId, T);
    const f = fields.find((x) => x.field === ratingFieldId);
    assert(f != null, "rating field not found");
    assert(f.type === "rating", `expected type=rating, got ${f.type}`);
    assert(f.ratingMax === 5, `expected ratingMax=5, got ${f.ratingMax}`);
  });

  await step("changeColumnType text → url (lossless relabel)", async () => {
    const textField = await repo.addField(dimId, "Website", "text", undefined, {}, "u_verify", T);
    assert(textField != null, "addField(text) returned null");
    const res = await repo.changeColumnType(
      dimId,
      textField.field,
      {
        newType: "url",
        coerceInvalidToNull: false,
        userId: "u_verify",
      },
      T,
    );
    assert(res.ok, "changeColumnType to url failed");
    const fields = await repo.listFields(dimId, T);
    assert(fields.find((x) => x.field === textField.field)?.type === "url", "type should be url");
  });

  await step("cleanup grid layout rows", async () => {
    await pgRun(`DELETE FROM ${pg("user_grid_layout")} WHERE dim_id LIKE $1`, [`${SCOPE}%`]);
  });

  await step("cleanup", cleanup);

  console.log("\n✓ verify-datagrid (Phase 3): all checks passed");
  process.exit(0);
})().catch((e) => {
  console.error("\n✗ verify-datagrid:", e?.message ?? e);
  process.exit(1);
});
