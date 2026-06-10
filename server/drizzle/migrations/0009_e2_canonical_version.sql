CREATE TABLE "zugzug_app"."canonical_version" (
	"dim_id" varchar NOT NULL,
	"key" varchar NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp NOT NULL,
	"updated_by" varchar NOT NULL,
	CONSTRAINT "canonical_version_dim_id_key_pk" PRIMARY KEY("dim_id","key")
);
--> statement-breakpoint
CREATE INDEX "canonical_version_recent_idx" ON "zugzug_app"."canonical_version" USING btree ("dim_id","updated_at");

-- Backfill: every existing canonical row in every registered dimension gets
-- version=1 owned by u_system. Idempotent — re-running is a no-op via ON CONFLICT.
-- Reads dim_table from "zugzug_app"."dimension" and loops dynamically because
-- dim_X tables are imperatively created per-dimension (not in Drizzle schema).
DO $$
DECLARE
  d record;
  sql_stmt text;
BEGIN
  FOR d IN
    SELECT id, dim_table, key_col
    FROM "zugzug_app"."dimension"
  LOOP
    sql_stmt := format(
      'INSERT INTO "zugzug_app"."canonical_version" (dim_id, key, version, updated_at, updated_by)
       SELECT %L, %I, 1, now(), %L
         FROM %s
       ON CONFLICT (dim_id, key) DO NOTHING',
      d.id, d.key_col, 'u_system', d.dim_table
    );
    EXECUTE sql_stmt;
  END LOOP;
END $$;