/* schema.ts — idempotent DDL for the Postgres OLTP app state (the chatty,
   multi-user layer). The canonical dim_/map_ tables live in MotherDuck and are
   created per-dimension in repo.ts; here we provision only the app-state schema.

   Mirrors the three-store split in ARCHITECTURE.md: this is everything in
   `postgres://zugzug` — registry, drafts, audit, users, presence. */

import { run, all, get } from "./db.ts";
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
  for (const col of ["key_kind VARCHAR", "name_table VARCHAR", "name_id_col VARCHAR", "name_col VARCHAR", "description VARCHAR", "color VARCHAR"]) {
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
  // single-select columns store an ordered list of allowed option labels as a
  // JSON string in a VARCHAR column. We don't query inside the JSON, and using
  // a real JSON/JSONB column would force every write through DuckDB's postgres
  // extension UPDATE-rewrite, which drops the ::json cast — leaving Postgres
  // with a VARCHAR expression bound to a JSON column. Storing the serialized
  // string avoids that entirely. Nullable: text/number/boolean/date columns
  // keep it null.
  // If a prior bootstrap created `options` as JSON, drop it. The pre-Phase-2
  // codebase had no select columns so dropping loses nothing — and the rewrite
  // mechanic above means no production write would have succeeded against the
  // JSON column anyway. The subsequent ADD COLUMN IF NOT EXISTS recreates it.
  const colType = await get<{ data_type: string }>(
    `SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = 'options'`,
    [env.appSchema, "dimension_field"],
  );
  if (colType && colType.data_type !== "character varying") {
    await run(`ALTER TABLE ${pg("dimension_field")} DROP COLUMN options`);
  }
  await run(`ALTER TABLE ${pg("dimension_field")} ADD COLUMN IF NOT EXISTS options VARCHAR`);

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
  // Idempotent: add auth columns to existing users table.
  // email and google_sub are nullable to preserve existing demo rows.
  await run(`ALTER TABLE ${pg("users")} ADD COLUMN IF NOT EXISTS email VARCHAR`);
  await run(`ALTER TABLE ${pg("users")} ADD COLUMN IF NOT EXISTS google_sub VARCHAR`);
  // Partial unique indexes aren't supported by DuckDB's postgres extension yet
  // ("Creating partial indexes is not supported currently"). Best-effort: the
  // CREATE will work when issued against Postgres directly; through the bridge
  // it's a no-op, and we lean on the app layer + the unique columns elsewhere.
  try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON ${pg("users")} (email) WHERE email IS NOT NULL`); } catch {}
  try { await run(`CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON ${pg("users")} (google_sub) WHERE google_sub IS NOT NULL`); } catch {}

  await run(`CREATE TABLE IF NOT EXISTS ${pg("active_sessions")} (
    user_id   VARCHAR PRIMARY KEY,
    last_seen TIMESTAMP NOT NULL
  )`);

  // allowlist: only explicitly added emails may log in. Empty = bootstrap mode.
  await run(`CREATE TABLE IF NOT EXISTS ${pg("allowed_emails")} (
    email      VARCHAR PRIMARY KEY,
    added_by   VARCHAR NOT NULL,
    added_at   TIMESTAMP NOT NULL
  )`);

  // server-side sessions — the zz_sid cookie holds only the session id.
  await run(`CREATE TABLE IF NOT EXISTS ${pg("sessions")} (
    id         VARCHAR PRIMARY KEY,
    user_id    VARCHAR NOT NULL,
    expires_at TIMESTAMP NOT NULL
  )`);
  await run(`CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON ${pg("sessions")} (user_id)`);

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

  // per-user-per-dimension UI layout: column widths, order, hidden set. NOT
  // saved views — those are deferred. config is a single JSON-string blob in
  // a VARCHAR column (same DuckDB-rewrite avoidance as dimension_field.options;
  // see the comment on that ALTER above). PATCH writes the whole blob.
  await run(`CREATE TABLE IF NOT EXISTS ${pg("user_grid_layout")} (
    user_id    VARCHAR NOT NULL,
    dim_id     VARCHAR NOT NULL,
    config     VARCHAR NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, dim_id)
  )`);

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
