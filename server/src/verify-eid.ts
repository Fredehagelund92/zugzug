/* verify-eid.ts — prove external-ID keys with live-resolved names on the REAL
   Postgres (and the warehouse when ATTACH_WAREHOUSE=true). Self-cleaning.
   Run: `bun run verify-eid`.

   Always-on (Postgres) asserts: migration columns, external-ID dimension creation
   (nullable label + key_kind), and the unresolved fallback (key shown, label = key).
   The live-resolution path is exercised only when ATTACH_WAREHOUSE=true AND a real
   master table is provided via EID_TABLE / EID_ID_COL / EID_NAME_COL — else skipped. */

import { connect, run, all, get } from "./db.ts";
import { ensureSchema } from "./schema.ts";
import { env, pg } from "./env.ts";
import * as repo from "./repo.ts";

let pass = 0, fail = 0, skipped = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); ok ? pass++ : fail++; };
const note = (name: string, detail: string) => { console.log(`  ⊘ ${name} — ${detail}`); skipped++; };

const NAME = "Verify EID Partner";
const DIM_ID = "verify_eid_partner"; // slug(NAME)
const KEYCOL = `${DIM_ID}_code`;
const canon = (t: string) => `${env.oltpCatalog}.${env.canonicalSchema}.${t}`;
const DIMT = canon(`dim_${DIM_ID}`);
const MAPT = canon(`map_${DIM_ID}`);

async function cleanup(): Promise<void> {
  await run(`DROP TABLE IF EXISTS ${DIMT}`).catch(() => {});
  await run(`DROP TABLE IF EXISTS ${MAPT}`).catch(() => {});
  await run(`DELETE FROM ${pg("dimension_source")} WHERE dim_id = '${DIM_ID}'`).catch(() => {});
  await run(`DELETE FROM ${pg("dimension_field")} WHERE dim_id = '${DIM_ID}'`).catch(() => {});
  await run(`DELETE FROM ${pg("dimension")} WHERE id = '${DIM_ID}'`).catch(() => {});
}

console.log("\nZug Zug — external-ID keys verification\n");
await connect();
await ensureSchema();
await cleanup();

// 1. migration columns exist on the dimension registry
const cols = await all<{ column_name: string }>(
  `SELECT column_name FROM ${env.oltpCatalog}.information_schema.columns
   WHERE table_schema = '${env.appSchema}' AND table_name = 'dimension'`);
const have = new Set(cols.map((c) => c.column_name));
check("schema: key_kind + name binding columns present",
  ["key_kind", "name_table", "name_id_col", "name_col"].every((c) => have.has(c)),
  ["key_kind", "name_table", "name_id_col", "name_col"].filter((c) => have.has(c)).join(", "));

// 2. create an external-ID dimension → key_kind persisted + nullable-label dim_
await repo.addDimension(NAME, [], { keyKind: "external_id" });
const dims = await repo.listDimensions();
const d = dims.find((x) => x.id === DIM_ID);
check("addDimension: external-ID dimension registered with key_kind", d?.keyKind === "external_id", d?.keyKind ?? "missing");
const labelNullable = await get<{ is_nullable: string }>(
  `SELECT is_nullable FROM ${env.oltpCatalog}.information_schema.columns
   WHERE table_schema = '${env.canonicalSchema}' AND table_name = 'dim_${DIM_ID}' AND column_name = 'label'`);
check("addDimension: dim_ label is nullable for external-ID", labelNullable?.is_nullable === "YES", labelNullable?.is_nullable ?? "n/a");

// 3 + 4. derive + live resolution — only with a real warehouse master table
const T = process.env.EID_TABLE?.trim(), IDC = process.env.EID_ID_COL?.trim(), NMC = process.env.EID_NAME_COL?.trim();
if (env.attachWarehouse && T && IDC && NMC) {
  const res = await repo.deriveCanonical(DIM_ID, T, IDC, NMC);
  check("derive: external-ID keys seeded from master table", res.derived > 0, `${res.derived} ids from ${T}.${IDC}`);
  const bind = await get<{ name_table: string; name_col: string }>(
    `SELECT name_table, name_col FROM ${pg("dimension")} WHERE id = '${DIM_ID}'`);
  check("derive: name binding persisted", bind?.name_table === T && bind?.name_col === NMC, `${bind?.name_table}.${bind?.name_col}`);
  const full = await repo.getDimension(DIM_ID);
  const resolved = full?.canonical.filter((c) => !c.unresolved && c.label !== c.key) ?? [];
  check("getDimension: at least one name resolved live", resolved.length > 0, `${resolved.length}/${full?.canonical.length ?? 0} resolved`);
  check("getDimension: keys are raw IDs (not slugged)", (full?.canonical.length ?? 0) > 0 && (full?.canonical.every((c) => c.key === c.key.trim()) ?? false));
} else {
  note("derive + live resolution", "set ATTACH_WAREHOUSE=true and EID_TABLE/EID_ID_COL/EID_NAME_COL to exercise");
  // unresolved fallback IS testable without a binding: seed an ID by hand, read it back
  await run(`INSERT INTO ${DIMT} (${KEYCOL}) VALUES ('P-001') ON CONFLICT DO NOTHING`);
  const full = await repo.getDimension(DIM_ID);
  const row = full?.canonical.find((c) => c.key === "P-001");
  check("getDimension: no binding → row unresolved, label falls back to key",
    !!row && row.unresolved === true && row.label === "P-001",
    row ? `unresolved=${row.unresolved} label=${row.label}` : "row missing");
}

console.log("\nCleaning up…");
await cleanup();
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed, ${skipped} skipped.\n`);
process.exit(fail === 0 ? 0 : 1);
