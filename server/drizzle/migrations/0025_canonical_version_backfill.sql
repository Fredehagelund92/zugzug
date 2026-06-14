-- 0025_canonical_version_backfill.sql
-- One-shot backfill of canonical_version.updated_at for rows that pre-date
-- per-canonical version tracking. Reads max(created_at) from audit_log
-- for the six canonical mutation actions emitted by repo-canonical.ts
-- (see canonical-version-backfill.test.ts for the guard test that keeps
-- this list in sync); falls back to now() when no audit row exists.
--
-- Idempotent via ON CONFLICT (tenant_id, dim_id, key) DO NOTHING — re-running
-- is a no-op for any row that already has a canonical_version entry.
--
-- The target table name (`<canonical_schema>.dim_<slug>`) is per-dimension
-- dynamic, so the body is wrapped in a PL/pgSQL block that iterates every
-- (tenant, dim) pair via the dimension registry and EXECUTEs the inner UPSERT.
--
-- dim_table is already a schema-qualified identifier stored verbatim by
-- addDimension() (e.g. "zugzug.dim_country"). It is constructed from a
-- slug-validated id and a server-controlled schema name, so it is safe to
-- splice directly. key_col is also slug-derived (`<id>_code`) but we still
-- quote it via %I for defense-in-depth.
--
-- See design §4.5 of outbound-integrations spec.

DO $$
DECLARE
  d RECORD;
  sql_str text;
BEGIN
  FOR d IN
    SELECT dim.id AS dim_id,
           dim.tenant_id,
           dim.dim_table,
           dim.key_col
      FROM "zugzug_app"."dimension" dim
  LOOP
    sql_str := format(
      $f$
        INSERT INTO "zugzug_app"."canonical_version"
          (tenant_id, dim_id, key, version, updated_at, updated_by)
        SELECT %L::varchar, %L::varchar, %I, 0,
               coalesce(
                 (SELECT max(created_at) FROM "zugzug_app"."audit_log"
                   WHERE tenant_id = %L::varchar
                     AND table_id  = %L::varchar
                     AND row_key   = %I
                     AND action IN ('Added canonical', 'Renamed canonical',
                                    'Merged canonical', 'Retired canonical',
                                    'Inserted canonical at position',
                                    'Reordered canonical')),
                 now()),
               'migration:phase1'
          FROM %s
         WHERE tenant_id = %L::varchar
        ON CONFLICT (tenant_id, dim_id, key) DO NOTHING
      $f$,
      d.tenant_id, d.dim_id, d.key_col,
      d.tenant_id, d.dim_id, d.key_col,
      d.dim_table, d.tenant_id
    );
    EXECUTE sql_str;
  END LOOP;
END $$;
