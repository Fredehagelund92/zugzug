/* schema.ts — idempotent DDL for the Postgres OLTP app state (the chatty,
   multi-user layer). The canonical dim_/map_ tables live in MotherDuck and are
   created per-dimension in repo.ts; here we provision only the app-state schema.

   Mirrors the three-store split in ARCHITECTURE.md: this is everything in
   `postgres://zugzug` — registry, drafts, audit, users, presence. */

import { run, all } from "./db.ts";
import { env, pg } from "./env.ts";

const DEFAULT_USERS = [
  { id: "u_ada", name: "Ada Berg", initials: "AB" },
  { id: "u_li", name: "Li Bauer", initials: "LB" },
  { id: "u_cory", name: "Cory Mills", initials: "CM" },
];

export async function ensureSchema(): Promise<void> {
  await run(`CREATE SCHEMA IF NOT EXISTS ${env.oltpCatalog}.${env.appSchema}`);
  // canonical dim_/map_ live here (Postgres, read/write) — not in MotherDuck
  await run(`CREATE SCHEMA IF NOT EXISTS ${env.oltpCatalog}.${env.canonicalSchema}`);

  // dimension registry — one row per dimension, pointing at its MotherDuck tables
  await run(`CREATE TABLE IF NOT EXISTS ${pg("dimension")} (
    id        VARCHAR PRIMARY KEY,
    label     VARCHAR NOT NULL,
    dim_table VARCHAR NOT NULL,
    map_table VARCHAR NOT NULL,
    key_col   VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL
  )`);

  // external-ID keys: a dimension may be keyed by a real warehouse ID (e.g.
  // partner_id) instead of a name-derived slug. key_kind drives that; the name
  // binding says where to resolve the human name from, live, on read.
  // ADD COLUMN IF NOT EXISTS keeps this idempotent on an existing dimension table.
  for (const col of ["key_kind VARCHAR", "name_table VARCHAR", "name_id_col VARCHAR", "name_col VARCHAR"]) {
    await run(`ALTER TABLE ${pg("dimension")} ADD COLUMN IF NOT EXISTS ${col}`);
  }
  await run(`UPDATE ${pg("dimension")} SET key_kind = 'slug' WHERE key_kind IS NULL`);

  // which warehouse table.column feed a dimension (drives scanUnmapped)
  await run(`CREATE TABLE IF NOT EXISTS ${pg("dimension_source")} (
    dim_id        VARCHAR NOT NULL,
    source_table  VARCHAR NOT NULL,
    source_column VARCHAR NOT NULL,
    PRIMARY KEY (dim_id, source_table, source_column)
  )`);
  // optional cadence for an automatic scan: NULL | '15m' | 'hourly' | 'daily'.
  await run(`ALTER TABLE ${pg("dimension_source")} ADD COLUMN IF NOT EXISTS schedule VARCHAR`);

  // enrichment fields: extra attribute columns on a dimension's dim_ table
  // (region, currency, …). The registry; the columns themselves are ALTERed in.
  await run(`CREATE TABLE IF NOT EXISTS ${pg("dimension_field")} (
    dim_id     VARCHAR NOT NULL,
    field      VARCHAR NOT NULL,
    label      VARCHAR NOT NULL,
    type       VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL,
    PRIMARY KEY (dim_id, field)
  )`);

  // cached scan stats per source (refreshed by POST /api/sources/scan) so the
  // sources list/queue reads instantly without hitting the warehouse per row —
  // the scalable pattern for many sources.
  await run(`CREATE TABLE IF NOT EXISTS ${pg("source_stat")} (
    dim_id          VARCHAR NOT NULL,
    source_table    VARCHAR NOT NULL,
    source_column   VARCHAR NOT NULL,
    present         BOOLEAN NOT NULL,
    rows            BIGINT  NOT NULL,
    distinct_values BIGINT  NOT NULL,
    unmapped        BIGINT  NOT NULL,
    scanned_at      TIMESTAMP NOT NULL,
    PRIMARY KEY (dim_id, source_table, source_column)
  )`);

  // per-user staged edits — accept/merge/skip land here, not in MotherDuck
  await run(`CREATE TABLE IF NOT EXISTS ${pg("draft")} (
    dim_id       VARCHAR NOT NULL,
    raw          VARCHAR NOT NULL,
    status       VARCHAR NOT NULL,   -- 'mapped' | 'skipped'
    target_label VARCHAR,
    target_key   VARCHAR,
    user_id      VARCHAR NOT NULL,
    created_at   TIMESTAMP NOT NULL,
    PRIMARY KEY (dim_id, raw, user_id)
  )`);

  // append-only audit (who / what / when)
  await run(`CREATE TABLE IF NOT EXISTS ${pg("audit_log")} (
    id         VARCHAR PRIMARY KEY,
    created_at TIMESTAMP NOT NULL,
    user_id    VARCHAR NOT NULL,
    action     VARCHAR NOT NULL,
    detail     VARCHAR NOT NULL
  )`);

  // users + presence
  await run(`CREATE TABLE IF NOT EXISTS ${pg("users")} (
    id       VARCHAR PRIMARY KEY,
    name     VARCHAR NOT NULL,
    initials VARCHAR NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS ${pg("active_sessions")} (
    user_id   VARCHAR PRIMARY KEY,
    last_seen TIMESTAMP NOT NULL
  )`);

  // workspace-global preferences (single row, id=1) — the auto-match bands
  // (publish_threshold = auto-publish on scan; suggest_threshold = surface as
  // a suggestion). Defaults are 95 / 80.
  await run(`CREATE TABLE IF NOT EXISTS ${pg("preferences")} (
    id                INT PRIMARY KEY,
    publish_threshold INT NOT NULL,
    suggest_threshold INT NOT NULL,
    updated_at        TIMESTAMP NOT NULL
  )`);
  await run(`INSERT INTO ${pg("preferences")} (id, publish_threshold, suggest_threshold, updated_at)
    VALUES (1, 95, 80, current_timestamp)
    ON CONFLICT (id) DO NOTHING`);

  // seed the demo team if the users table is empty
  const existing = await all<{ n: bigint }>(`SELECT count(*) AS n FROM ${pg("users")}`);
  if (Number(existing[0]?.n ?? 0) === 0) {
    for (const u of DEFAULT_USERS) {
      await run(`INSERT INTO ${pg("users")} (id, name, initials) VALUES ($1,$2,$3)`, [u.id, u.name, u.initials]);
      await run(`INSERT INTO ${pg("active_sessions")} (user_id, last_seen) VALUES ($1, current_timestamp)`, [u.id]);
    }
  }

  // system 'Auto-match' user — owns drafts created automatically when a scan
  // surfaces a suggestion above the publish threshold. Idempotent for existing DBs.
  await run(
    `INSERT INTO ${pg("users")} (id, name, initials)
     VALUES ('u_system','Auto-match','AM')
     ON CONFLICT (id) DO NOTHING`,
  );
}
