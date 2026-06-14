-- 0023_warehouse_env_token.sql
-- Strip per-tenant warehouse credentials; collapse warehouse_database to
-- deployment-global. After this migration, MOTHERDUCK_TOKEN comes from env.

-- 1. Preflight: every warehouse_database row must point at a non-empty database_name.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM "zugzug_app"."warehouse_database"
   WHERE database_name IS NULL OR length(database_name) = 0;
  IF bad > 0 THEN
    RAISE EXCEPTION '[warehouse_env_token] preflight: % warehouse_database rows have empty database_name', bad;
  END IF;
END $$;
--> statement-breakpoint

-- 2. Pick a survivor per database_name (lexicographically smallest id).
CREATE TEMP TABLE _db_survivor AS
SELECT database_name, MIN(id) AS survivor_id
  FROM "zugzug_app"."warehouse_database"
 GROUP BY database_name;
--> statement-breakpoint

-- 2b. Drop composite FKs before repointing — survivor may live in a different
-- tenant than the referencing row, which the composite (tenant_id, database_id)
-- FK would reject. Single-column FKs are re-added in step 7 after dedup.
ALTER TABLE "zugzug_app"."dimension_source"     DROP CONSTRAINT "dimension_source_database_fk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_stat"          DROP CONSTRAINT "source_stat_database_fk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."user_warehouse_state" DROP CONSTRAINT "user_warehouse_state_recent_db_fk";--> statement-breakpoint

-- 3. Repoint FKs to survivors.
UPDATE "zugzug_app"."dimension_source" ds
   SET database_id = s.survivor_id
  FROM "zugzug_app"."warehouse_database" wd
  JOIN _db_survivor s ON s.database_name = wd.database_name
 WHERE ds.database_id = wd.id AND wd.id <> s.survivor_id;
--> statement-breakpoint

UPDATE "zugzug_app"."source_stat" ss
   SET database_id = s.survivor_id
  FROM "zugzug_app"."warehouse_database" wd
  JOIN _db_survivor s ON s.database_name = wd.database_name
 WHERE ss.database_id = wd.id AND wd.id <> s.survivor_id;
--> statement-breakpoint

UPDATE "zugzug_app"."user_warehouse_state" uws
   SET recent_database_id = s.survivor_id
  FROM "zugzug_app"."warehouse_database" wd
  JOIN _db_survivor s ON s.database_name = wd.database_name
 WHERE uws.recent_database_id = wd.id AND wd.id <> s.survivor_id;
--> statement-breakpoint

UPDATE "zugzug_app"."preferences" p
   SET legacy_default_database_id = s.survivor_id
  FROM "zugzug_app"."warehouse_database" wd
  JOIN _db_survivor s ON s.database_name = wd.database_name
 WHERE p.legacy_default_database_id = wd.id AND wd.id <> s.survivor_id;
--> statement-breakpoint

-- 4. Delete loser rows.
DELETE FROM "zugzug_app"."warehouse_database"
 WHERE id NOT IN (SELECT survivor_id FROM _db_survivor);
--> statement-breakpoint

-- 6. Drop warehouse_database's composite PK, tenant_id, connection_id; add single-col PK + unique.
-- Drop RLS policy first — it depends on tenant_id.
DROP POLICY IF EXISTS "warehouse_database_tenant_isolation" ON "zugzug_app"."warehouse_database";--> statement-breakpoint
ALTER TABLE "zugzug_app"."warehouse_database" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "zugzug_app"."warehouse_database"
  DROP CONSTRAINT "warehouse_database_tenant_id_id_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."warehouse_database"
  DROP COLUMN "tenant_id",
  DROP COLUMN "connection_id";--> statement-breakpoint
ALTER TABLE "zugzug_app"."warehouse_database"
  ADD CONSTRAINT "warehouse_database_pk" PRIMARY KEY ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_database_database_name_uniq"
  ON "zugzug_app"."warehouse_database" ("database_name");--> statement-breakpoint

-- 7. Recreate single-column FKs.
ALTER TABLE "zugzug_app"."dimension_source"
  ADD CONSTRAINT "dimension_source_database_fk"
    FOREIGN KEY ("database_id") REFERENCES "zugzug_app"."warehouse_database"("id")
    ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_stat"
  ADD CONSTRAINT "source_stat_database_fk"
    FOREIGN KEY ("database_id") REFERENCES "zugzug_app"."warehouse_database"("id")
    ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "zugzug_app"."user_warehouse_state"
  ADD CONSTRAINT "user_warehouse_state_recent_db_fk"
    FOREIGN KEY ("recent_database_id") REFERENCES "zugzug_app"."warehouse_database"("id")
    ON DELETE SET NULL;--> statement-breakpoint

-- 9. Drop warehouse_connection entirely.
DROP TABLE "zugzug_app"."warehouse_connection";
