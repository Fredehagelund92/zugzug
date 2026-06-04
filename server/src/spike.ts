/* spike.ts — prove the bridge on the REAL stores. Run: `bun run spike`.

   Architecture (read-only MotherDuck token): canonical dim_/map_ + app state
   live in Postgres (read/write); MotherDuck is the read-only warehouse scanned
   in the same DuckDB session. So the asserts are:
     1. attach        — both catalogs present; warehouse db reachable in MD
     2. postgres PK    — UNIQUE/PK enforced on the canonical map table
     3. postgres upsert— ON CONFLICT DO UPDATE works (saveDraft/addCanonical)
     4. postgres txn   — multi-write transaction commits (commit() is single-catalog)
     5. rollback       — a rolled-back write is discarded
     6. cross-store    — one query spans MotherDuck ⋈ Postgres (the scan's core)
     7. real scan      — read an actual warehouse column (informative; skips if absent)

   Self-cleaning. */

import { connect, all, run, get } from "./db.ts";
import { env, pg } from "./env.ts";

const qid = (s: string) => `"${s.replace(/"/g, '""')}"`;
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

const WH = env.warehouseDb;
const DIM = pg("spike_dim");
const MAP = pg("spike_map");
const DRAFT = pg("spike_draft");
const cleanup = async () => {
  for (const t of [DIM, MAP, DRAFT]) await run(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
};

console.log("\nZug Zug — bridge spike (canonical in Postgres)\n");
await connect();

// 1. attach
const cats = await all<{ database_name: string; type: string }>(
  `SELECT database_name, type FROM duckdb_databases() WHERE database_name NOT IN ('system','temp') ORDER BY 1`,
);
console.log("Attached catalogs:");
for (const c of cats) console.log(`  · ${c.database_name} (${c.type})`);
check(
  "attach: Postgres catalog present",
  cats.some((c) => c.type === "postgres"),
  env.oltpCatalog,
);
if (env.attachWarehouse) {
  const haveWh = cats.some((c) => c.database_name === WH);
  check(
    `attach: warehouse db '${WH}' present in MotherDuck`,
    haveWh,
    haveWh ? "" : `available: ${cats.map((c) => c.database_name).join(", ")}`,
  );
} else {
  note(`attach: warehouse '${WH}' (MotherDuck)`, "deferred — ATTACH_WAREHOUSE=false");
}

// schemas + throwaway tables (Postgres)
await run(`CREATE SCHEMA IF NOT EXISTS ${env.oltpCatalog}.${env.appSchema}`);
await run(`CREATE SCHEMA IF NOT EXISTS ${env.oltpCatalog}.${env.canonicalSchema}`);
check("ddl: canonical + app schemas ensured (Postgres)", true);
await cleanup();
await run(`CREATE TABLE ${DIM} (k VARCHAR PRIMARY KEY, label VARCHAR)`);
await run(`CREATE TABLE ${MAP} (raw VARCHAR PRIMARY KEY, k VARCHAR)`);
await run(`CREATE TABLE ${DRAFT} (raw VARCHAR, k VARCHAR)`);

// 2. PK enforcement
console.log("\nPostgres canonical writes:");
await run(`INSERT INTO ${MAP} VALUES ('DK','DK')`);
let dup = false;
try {
  await run(`INSERT INTO ${MAP} VALUES ('DK','XX')`);
} catch {
  dup = true;
}
check("postgres: duplicate PK rejected", dup);

// 3. upsert
let ups = false,
  upsMsg = "";
try {
  await run(`INSERT INTO ${DIM} (k,label) VALUES ('US','x')`);
  await run(
    `INSERT INTO ${DIM} (k,label) VALUES ('US','United States') ON CONFLICT (k) DO UPDATE SET label = excluded.label`,
  );
  const g = await get<{ label: string }>(`SELECT label FROM ${DIM} WHERE k='US'`);
  ups = g?.label === "United States";
} catch (e) {
  upsMsg = String(e).split("\n")[0];
}
check("postgres: ON CONFLICT DO UPDATE works (saveDraft/addCanonical rely on it)", ups, upsMsg);

// 4. single-catalog multi-write transaction (the commit() pattern)
const conn = await connect();
let txnOk = false,
  txnMsg = "";
try {
  await conn.run("BEGIN");
  await conn.run(
    `INSERT INTO ${DIM} (k,label) VALUES ('GB','United Kingdom') ON CONFLICT (k) DO NOTHING`,
  );
  await conn.run(`INSERT INTO ${MAP} VALUES ('GB','GB')`);
  await conn.run(`DELETE FROM ${DRAFT} WHERE raw='GB'`);
  await conn.run("COMMIT");
  const g = await get<{ n: bigint }>(`SELECT count(*) AS n FROM ${MAP} WHERE raw='GB'`);
  txnOk = Number(g?.n) === 1;
} catch (e) {
  txnMsg = String(e).split("\n")[0];
  await conn.run("ROLLBACK").catch(() => {});
}
check("postgres: multi-write transaction commits (commit() is single-catalog)", txnOk, txnMsg);

// 5. rollback
let rb = false;
try {
  await conn.run("BEGIN");
  await conn.run(`INSERT INTO ${MAP} VALUES ('SE','SE')`);
  await conn.run("ROLLBACK");
  const g = await get<{ n: bigint }>(`SELECT count(*) AS n FROM ${MAP} WHERE raw='SE'`);
  rb = Number(g?.n) === 0;
} catch {
  await conn.run("ROLLBACK").catch(() => {});
}
check("postgres: rolled-back write discarded", rb);

// 6/7. cross-store join + real warehouse scan — only when the warehouse is attached
if (env.attachWarehouse) {
  console.log("\nCross-store bridge:");
  try {
    const r = await get<{ n: bigint }>(
      `SELECT count(*) AS n FROM (SELECT 1 FROM ${qid(WH)}.information_schema.tables LIMIT 5) t CROSS JOIN ${MAP} m`,
    );
    check("cross-store: one query spans MotherDuck ⋈ Postgres", Number(r?.n) >= 0, `${r?.n} rows`);
  } catch (e) {
    check("cross-store: one query spans MotherDuck ⋈ Postgres", false, String(e).split("\n")[0]);
  }

  const SCHEMA = "active_revenue",
    TABLE = "r_statistics",
    COL = "country";
  try {
    const r = await all<{ raw: string; rows: bigint }>(
      `SELECT CAST(${qid(COL)} AS VARCHAR) AS raw, count(*) AS rows
       FROM ${qid(WH)}.${qid(SCHEMA)}.${qid(TABLE)}
       WHERE ${qid(COL)} IS NOT NULL AND length(trim(CAST(${qid(COL)} AS VARCHAR))) > 0
       GROUP BY 1 ORDER BY rows DESC LIMIT 5`,
    );
    if (r.length) {
      console.log(`\nReal scan — top ${WH}.${SCHEMA}.${TABLE}.${COL} values:`);
      for (const x of r) console.log(`    · '${x.raw}' (${Number(x.rows)} rows)`);
      check(
        `scan: read real warehouse column ${SCHEMA}.${TABLE}.${COL}`,
        true,
        `${r.length} distinct sampled`,
      );
    } else {
      note(`scan: ${WH}.${SCHEMA}.${TABLE}.${COL}`, "table reachable but empty here");
    }
  } catch (e) {
    note(
      `scan: ${WH}.${SCHEMA}.${TABLE}.${COL}`,
      `not in ${WH} (${String(e).split("\n")[0]}) — fine, scan skips missing sources`,
    );
  }
} else {
  note(
    "cross-store bridge + real scan",
    "deferred — ATTACH_WAREHOUSE=false (warehouse not attached)",
  );
}

console.log("\nCleaning up…");
await cleanup();
console.log(
  `\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed, ${skipped} skipped.\n`,
);
process.exit(fail === 0 ? 0 : 1);
