/* verify-eid.ts — prove external-ID keys with live-resolved names on the REAL
   Postgres (and the warehouse when ATTACH_WAREHOUSE=true). Self-cleaning.
   Run: `bun run verify-eid`.

   Always-on (Postgres) asserts: migration columns, external-ID refTable creation
   (nullable label + key_kind), and the unresolved fallback (key shown, label = key).
   The live-resolution path is exercised only when ATTACH_WAREHOUSE=true AND a real
   master table is provided via EID_TABLE / EID_ID_COL / EID_NAME_COL — else skipped. */

import { pgRun, pgAll, pgGet } from "./pg.ts";
import { env, pg } from "./env.ts";
import * as repo from "./repo.ts";
import { runMigrations } from "../drizzle/migrate.ts";
import { registerFactories } from "./warehouse/credentials.ts";
import { createDuckDbAdapter } from "./warehouse/duckdb/index.ts";
import { SnowflakeAdapter } from "./warehouse/snowflake/index.ts";
import { getAdapter } from "./warehouse/registry.ts";

let pass = 0,
  fail = 0,
  skipped = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};
const note = (name: string, detail: string) => {
  console.log(`  ⊘ ${name} — ${detail}`);
  skipped++;
};

const NAME = "Verify EID Partner";
const REF_TABLE_ID = "verify_eid_partner"; // slug(NAME)
const KEYCOL = `${REF_TABLE_ID}_code`;
const canon = (t: string) => `${env.oltpCatalog}.${env.recordSchema}.${t}`;
const DIMT = canon(`dim_${REF_TABLE_ID}`);
const MAPT = canon(`map_${REF_TABLE_ID}`);

async function cleanup(): Promise<void> {
  await pgRun(`DROP TABLE IF EXISTS ${DIMT}`).catch(() => {});
  await pgRun(`DROP TABLE IF EXISTS ${MAPT}`).catch(() => {});
  await pgRun(
    `DELETE FROM ${pg("reference_table_source")} WHERE reference_table_id = '${REF_TABLE_ID}'`,
  ).catch(() => {});
  await pgRun(
    `DELETE FROM ${pg("reference_table_field")} WHERE reference_table_id = '${REF_TABLE_ID}'`,
  ).catch(() => {});
  await pgRun(`DELETE FROM ${pg("reference_table")} WHERE id = '${REF_TABLE_ID}'`).catch(() => {});
}

console.log("\nZug Zug — external-ID keys verification\n");
registerFactories({
  duckdb: async (creds) => createDuckDbAdapter(creds),
  snowflake: async (creds) => new SnowflakeAdapter(creds),
});
await getAdapter(); // warm the env-configured adapter
await runMigrations();
await cleanup();

// 1. migration columns exist on the refTable registry
const cols = await pgAll<{ column_name: string }>(
  `SELECT column_name FROM ${env.oltpCatalog}.information_schema.columns
   WHERE table_schema = '${env.appSchema}' AND table_name = 'reference_table'`,
);
const have = new Set(cols.map((c) => c.column_name));
check(
  "schema: key_kind + name binding columns present",
  ["key_kind", "name_table", "name_id_col", "name_col"].every((c) => have.has(c)),
  ["key_kind", "name_table", "name_id_col", "name_col"].filter((c) => have.has(c)).join(", "),
);

const TENANT = "default";

// 2. create an external-ID refTable → key_kind persisted + nullable-label dim_
await repo.addRefTable(NAME, [], { keyKind: "external_id" }, "u_verify", TENANT);
const refTables = await repo.listRefTables(TENANT);
const d = refTables.find((x) => x.id === REF_TABLE_ID);
check(
  "addRefTable: external-ID refTable registered with key_kind",
  d?.keyKind === "external_id",
  d?.keyKind ?? "missing",
);
const labelNullable = await pgGet<{ is_nullable: string }>(
  `SELECT is_nullable FROM ${env.oltpCatalog}.information_schema.columns
   WHERE table_schema = '${env.recordSchema}' AND table_name = 'dim_${REF_TABLE_ID}' AND column_name = 'label'`,
);
check(
  "addRefTable: dim_ label is nullable for external-ID",
  labelNullable?.is_nullable === "YES",
  labelNullable?.is_nullable ?? "n/a",
);

// 3 + 4. derive + live resolution — only with a real warehouse master table
const T = process.env.EID_TABLE?.trim(),
  IDC = process.env.EID_ID_COL?.trim(),
  NMC = process.env.EID_NAME_COL?.trim();
if (env.attachWarehouse && T && IDC && NMC) {
  const res = await repo.deriveRecord(REF_TABLE_ID, T, IDC, NMC, {}, "u_verify", "default");
  check(
    "derive: external-ID keys seeded from master table",
    res.derived > 0,
    `${res.derived} ids from ${T}.${IDC}`,
  );
  const bind = await pgGet<{ name_table: string; name_col: string }>(
    `SELECT name_table, name_col FROM ${pg("reference_table")} WHERE id = '${REF_TABLE_ID}'`,
  );
  check(
    "derive: name binding persisted",
    bind?.name_table === T && bind?.name_col === NMC,
    `${bind?.name_table}.${bind?.name_col}`,
  );
  const full = await repo.getRefTable(REF_TABLE_ID, TENANT);
  const resolved = full?.record.filter((c) => !c.unresolved && c.label !== c.key) ?? [];
  check(
    "getRefTable: at least one name resolved live",
    resolved.length > 0,
    `${resolved.length}/${full?.record.length ?? 0} resolved`,
  );
  check(
    "getRefTable: keys are raw IDs (not slugged)",
    (full?.record.length ?? 0) > 0 && (full?.record.every((c) => c.key === c.key.trim()) ?? false),
  );
} else {
  note(
    "derive + live resolution",
    "set ATTACH_WAREHOUSE=true and EID_TABLE/EID_ID_COL/EID_NAME_COL to exercise",
  );
  // unresolved fallback IS testable without a binding: seed an ID by hand, read it back
  await pgRun(`INSERT INTO ${DIMT} (${KEYCOL}) VALUES ('P-001') ON CONFLICT DO NOTHING`);
  const full = await repo.getRefTable(REF_TABLE_ID, TENANT);
  const row = full?.record.find((c) => c.key === "P-001");
  check(
    "getRefTable: no binding → row unresolved, label falls back to key",
    !!row && row.unresolved === true && row.label === "P-001",
    row ? `unresolved=${row.unresolved} label=${row.label}` : "row missing",
  );
}

console.log("\nCleaning up…");
await cleanup();
console.log(
  `\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed, ${skipped} skipped.\n`,
);
process.exit(fail === 0 ? 0 : 1);
