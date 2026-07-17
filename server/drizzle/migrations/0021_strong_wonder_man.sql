-- Multi-database warehouse — schema + preflight + structural backfill.
-- After applying this migration, run `bun run warehouse:backfill` to
-- populate credentials_encrypted before flipping USE_NEW_WAREHOUSE.
--
-- Required: zugzug.warehouse_db session var (set by drizzle/migrate.ts).

DO $$
DECLARE
  admin_id varchar;
  bad_rows int;
  bad_list text;
BEGIN
  -- Preflight A: at least one super-admin to own backfilled connections.
  -- NOTE: users has no created_at column; order by id for deterministic pick.
  SELECT id INTO admin_id
    FROM zugzug_app.users
   WHERE is_super_admin = true
   ORDER BY id LIMIT 1;
  -- Only require a super-admin when there are real users to draw from.
  -- Fresh installs (no users) skip this — bootstrap runs migrations
  -- before seeding the system user, and the backfill below falls back
  -- to a placeholder owner that the seed step or backfill script
  -- reconciles later.
  IF admin_id IS NULL AND EXISTS (SELECT 1 FROM zugzug_app.users) THEN
    RAISE EXCEPTION
      '[warehouse_multi_db] preflight A: no super-admin user found. '
      'Create one (bun run bootstrap -- --seed) and re-run.';
  END IF;

  -- Preflight B: every existing dimension_source.source_table must be
  -- <schema>.<table>. Malformed inputs would yield empty table_name rows.
  SELECT count(*) INTO bad_rows
    FROM zugzug_app.dimension_source
   WHERE source_table IS NULL
      OR position('.' IN source_table) = 0
      OR split_part(source_table, '.', 2) = '';
  IF bad_rows > 0 THEN
    SELECT string_agg(
             quote_ident(tenant_id) || '/' || quote_ident(dim_id) ||
             ': ' || coalesce(source_table, '<NULL>'),
             E'\n  ' ORDER BY tenant_id, dim_id)
      INTO bad_list
      FROM zugzug_app.dimension_source
     WHERE source_table IS NULL
        OR position('.' IN source_table) = 0
        OR split_part(source_table, '.', 2) = '';
    RAISE EXCEPTION
      '[warehouse_multi_db] preflight B: % dimension_source row(s) malformed. '
      'Offending rows:%s  %s', bad_rows, E'\n', bad_list;
  END IF;

  -- Preflight C: zugzug.warehouse_db must be set (drizzle/migrate.ts).
  -- Only required when there is data to backfill — a fresh install (no users)
  -- inserts no connections/databases below, so an empty setting is harmless.
  -- Same fresh-install guard as preflight A above.
  IF (current_setting('zugzug.warehouse_db', true) IS NULL
      OR current_setting('zugzug.warehouse_db', true) = '')
     AND EXISTS (SELECT 1 FROM zugzug_app.users) THEN
    RAISE EXCEPTION
      '[warehouse_multi_db] preflight C: zugzug.warehouse_db setting empty. '
      'drizzle/migrate.ts must SET zugzug.warehouse_db before runMigrations().';
  END IF;
END $$;

-- 1) New tables.
CREATE TABLE "zugzug_app"."warehouse_connection" (
  "id"                     varchar      NOT NULL,
  "tenant_id"              varchar      NOT NULL,
  "adapter"                varchar      NOT NULL,
  "label"                  varchar      NOT NULL,
  "credentials_encrypted"  text         NOT NULL,
  "credentials_hash"       varchar      NOT NULL,
  "credentials_version"    integer      NOT NULL DEFAULT 1,
  "last_verified_at"       timestamp,
  "last_verify_error"      text,
  "created_at"             timestamp    NOT NULL,
  "created_by"             varchar      NOT NULL,
  CONSTRAINT "warehouse_connection_tenant_id_id_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "warehouse_connection_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id"),
  CONSTRAINT "warehouse_connection_adapter_chk" CHECK ("adapter" IN ('motherduck', 'duckdb_local'))
);
CREATE UNIQUE INDEX "warehouse_connection_one_per_tenant" ON "zugzug_app"."warehouse_connection"("tenant_id");

CREATE TABLE "zugzug_app"."warehouse_database" (
  "id"                varchar          NOT NULL,
  "tenant_id"         varchar          NOT NULL,
  "connection_id"     varchar          NOT NULL,
  "database_name"     varchar(255)     NOT NULL,
  "label"             varchar(255),
  "last_probe_at"     timestamp,
  "last_probe_error"  text,
  "added_at"          timestamp        NOT NULL,
  "added_by"          varchar          NOT NULL,
  CONSTRAINT "warehouse_database_tenant_id_id_pk" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "warehouse_database_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id"),
  CONSTRAINT "warehouse_database_connection_fk"
    FOREIGN KEY ("tenant_id", "connection_id")
    REFERENCES "zugzug_app"."warehouse_connection"("tenant_id", "id")
    ON DELETE CASCADE
);
CREATE UNIQUE INDEX "warehouse_database_per_conn_unique"
  ON "zugzug_app"."warehouse_database"("tenant_id", "connection_id", "database_name");
CREATE INDEX "warehouse_database_conn_idx"
  ON "zugzug_app"."warehouse_database"("tenant_id", "connection_id");

CREATE TABLE "zugzug_app"."user_warehouse_state" (
  "user_id"             varchar  NOT NULL,
  "tenant_id"           varchar  NOT NULL,
  "recent_database_id"  varchar,
  "updated_at"          timestamp NOT NULL,
  CONSTRAINT "user_warehouse_state_tenant_id_user_id_pk" PRIMARY KEY ("tenant_id", "user_id"),
  CONSTRAINT "user_warehouse_state_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id"),
  CONSTRAINT "user_warehouse_state_recent_db_fk"
    FOREIGN KEY ("tenant_id", "recent_database_id")
    REFERENCES "zugzug_app"."warehouse_database"("tenant_id", "id")
    ON DELETE SET NULL
);

-- 2) preferences.legacy_default_database_id (nullable; backfilled below).
ALTER TABLE "zugzug_app"."preferences"
  ADD COLUMN "legacy_default_database_id" varchar;

-- 3) Backfill one connection per tenant (placeholder creds; populated by warehouse-backfill).
DO $$
DECLARE admin_id varchar;
BEGIN
  SELECT id INTO admin_id FROM zugzug_app.users WHERE is_super_admin = true ORDER BY id LIMIT 1;
  -- Fresh install fallback: bootstrap upserts u_system after migrations,
  -- and the warehouse-backfill script reassigns ownership for real users.
  PERFORM set_config('zugzug.bootstrap_admin', coalesce(admin_id, 'u_system'), true);
END $$;

INSERT INTO "zugzug_app"."warehouse_connection"
  (id, tenant_id, adapter, label, credentials_encrypted, credentials_hash, credentials_version, created_at, created_by)
SELECT 'wc_' || replace(gen_random_uuid()::text, '-', ''),
       t.id,
       'motherduck',
       'Production warehouse',
       '__PENDING__',
       '__PENDING__',
       1,
       now(),
       current_setting('zugzug.bootstrap_admin')
  FROM "zugzug_app"."tenant" t
 WHERE t.deleted_at IS NULL
   -- Skip backfill on a fresh install: no real users → no dimension_source
   -- data to reshape, so leave warehouse_connection/database empty for tests
   -- and bootstrap to populate explicitly.
   AND EXISTS (SELECT 1 FROM "zugzug_app"."users");

-- 4) Backfill one database per tenant from current_setting('zugzug.warehouse_db').
INSERT INTO "zugzug_app"."warehouse_database"
  (id, tenant_id, connection_id, database_name, label, added_at, added_by)
SELECT 'wd_' || replace(gen_random_uuid()::text, '-', ''),
       wc.tenant_id,
       wc.id,
       current_setting('zugzug.warehouse_db'),
       'Imported from env',
       now(),
       wc.created_by
  FROM "zugzug_app"."warehouse_connection" wc;

-- 5) preferences.legacy_default_database_id ← the new wd_<...> per tenant.
UPDATE "zugzug_app"."preferences" p
   SET legacy_default_database_id = wd.id
  FROM "zugzug_app"."warehouse_database" wd
 WHERE wd.tenant_id = p.tenant_id;

-- 6) Reshape dimension_source.
ALTER TABLE "zugzug_app"."dimension_source"
  ADD COLUMN "database_id" varchar,
  ADD COLUMN "schema_name" varchar(255),
  ADD COLUMN "table_name"  varchar(255),
  ADD COLUMN "column_name" varchar(255);

UPDATE "zugzug_app"."dimension_source" ds
   SET database_id = wd.id,
       schema_name = split_part(ds.source_table, '.', 1),
       table_name  = split_part(ds.source_table, '.', 2),
       column_name = ds.source_column
  FROM "zugzug_app"."warehouse_database" wd
 WHERE wd.tenant_id = ds.tenant_id;

-- Drop the old PK FIRST so we can relax NOT NULL on source_table / source_column.
ALTER TABLE "zugzug_app"."dimension_source" DROP CONSTRAINT "dimension_source_tenant_id_dim_id_source_table_source_column_pk";

ALTER TABLE "zugzug_app"."dimension_source"
  ALTER COLUMN source_table  DROP NOT NULL,
  ALTER COLUMN source_column DROP NOT NULL,
  ALTER COLUMN database_id   SET NOT NULL,
  ALTER COLUMN schema_name   SET NOT NULL,
  ALTER COLUMN table_name    SET NOT NULL,
  ALTER COLUMN column_name   SET NOT NULL,
  ADD CONSTRAINT "dimension_source_schema_name_nonempty" CHECK (length(schema_name) > 0),
  ADD CONSTRAINT "dimension_source_table_name_nonempty"  CHECK (length(table_name)  > 0),
  ADD CONSTRAINT "dimension_source_column_name_nonempty" CHECK (length(column_name) > 0);

ALTER TABLE "zugzug_app"."dimension_source"
  ADD CONSTRAINT "dimension_source_tenant_id_dim_id_database_id_schema_name_table_name_column_name_pk"
  PRIMARY KEY ("tenant_id", "dim_id", "database_id", "schema_name", "table_name", "column_name");

ALTER TABLE "zugzug_app"."dimension_source"
  ADD CONSTRAINT "dimension_source_database_fk"
    FOREIGN KEY ("tenant_id", "database_id")
    REFERENCES "zugzug_app"."warehouse_database"("tenant_id", "id")
    ON DELETE RESTRICT;

CREATE INDEX "dimension_source_dim_idx"      ON "zugzug_app"."dimension_source"("tenant_id", "dim_id");
CREATE INDEX "dimension_source_database_idx" ON "zugzug_app"."dimension_source"("tenant_id", "database_id");

-- 7) Reshape source_stat (same pattern, CASCADE on database FK).
ALTER TABLE "zugzug_app"."source_stat"
  ADD COLUMN "database_id" varchar,
  ADD COLUMN "schema_name" varchar(255),
  ADD COLUMN "table_name"  varchar(255),
  ADD COLUMN "column_name" varchar(255);

UPDATE "zugzug_app"."source_stat" ss
   SET database_id = wd.id,
       schema_name = split_part(ss.source_table, '.', 1),
       table_name  = split_part(ss.source_table, '.', 2),
       column_name = ss.source_column
  FROM "zugzug_app"."warehouse_database" wd
 WHERE wd.tenant_id = ss.tenant_id
   AND ss.source_table IS NOT NULL
   AND position('.' IN ss.source_table) > 0;

DELETE FROM "zugzug_app"."source_stat" WHERE database_id IS NULL;

-- Drop the old PK FIRST so we can relax NOT NULL on source_table / source_column.
ALTER TABLE "zugzug_app"."source_stat" DROP CONSTRAINT "source_stat_tenant_id_dim_id_source_table_source_column_pk";

ALTER TABLE "zugzug_app"."source_stat"
  ALTER COLUMN source_table  DROP NOT NULL,
  ALTER COLUMN source_column DROP NOT NULL,
  ALTER COLUMN database_id   SET NOT NULL,
  ALTER COLUMN schema_name   SET NOT NULL,
  ALTER COLUMN table_name    SET NOT NULL,
  ALTER COLUMN column_name   SET NOT NULL,
  ADD CONSTRAINT "source_stat_schema_name_nonempty" CHECK (length(schema_name) > 0),
  ADD CONSTRAINT "source_stat_table_name_nonempty"  CHECK (length(table_name)  > 0),
  ADD CONSTRAINT "source_stat_column_name_nonempty" CHECK (length(column_name) > 0);

ALTER TABLE "zugzug_app"."source_stat"
  ADD CONSTRAINT "source_stat_tenant_id_dim_id_database_id_schema_name_table_name_column_name_pk"
  PRIMARY KEY ("tenant_id", "dim_id", "database_id", "schema_name", "table_name", "column_name");
ALTER TABLE "zugzug_app"."source_stat"
  ADD CONSTRAINT "source_stat_database_fk"
    FOREIGN KEY ("tenant_id", "database_id")
    REFERENCES "zugzug_app"."warehouse_database"("tenant_id", "id")
    ON DELETE CASCADE;

-- 8) RLS policies (no-ops if RLS is not yet enabled in this env).
ALTER TABLE "zugzug_app"."warehouse_connection"  ENABLE ROW LEVEL SECURITY;
CREATE POLICY "warehouse_connection_tenant_isolation" ON "zugzug_app"."warehouse_connection"
  USING (tenant_id = current_setting('app.tenant_id')::varchar);

ALTER TABLE "zugzug_app"."warehouse_database"   ENABLE ROW LEVEL SECURITY;
CREATE POLICY "warehouse_database_tenant_isolation" ON "zugzug_app"."warehouse_database"
  USING (tenant_id = current_setting('app.tenant_id')::varchar);

ALTER TABLE "zugzug_app"."user_warehouse_state" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_warehouse_state_tenant_isolation" ON "zugzug_app"."user_warehouse_state"
  USING (tenant_id = current_setting('app.tenant_id')::varchar);
