ALTER TABLE "zugzug_app"."dimension" ADD COLUMN "ordering_mode" varchar DEFAULT 'derived' NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension" ADD COLUMN "last_rebalanced_at" timestamp;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension" ADD CONSTRAINT "dimension_ordering_mode_chk" CHECK ("zugzug_app"."dimension"."ordering_mode" IN ('derived', 'manual'));

-- Walk every registered dim_* table and add position column + indexes.
-- IF NOT EXISTS makes the block idempotent for dims created during deploy window.
DO $$
DECLARE
  r            RECORD;
  dot_pos      INT;
  schema_name  TEXT;
  table_name   TEXT;
BEGIN
  FOR r IN SELECT id, dim_table FROM "zugzug_app"."dimension"
  LOOP
    dot_pos     := position('.' IN r.dim_table);
    schema_name := substring(r.dim_table FROM 1 FOR dot_pos - 1);
    table_name  := substring(r.dim_table FROM dot_pos + 1);

    EXECUTE format(
      'ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS position BIGINT',
      schema_name, table_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON %I.%I (position) WHERE position IS NOT NULL',
      'dim_' || r.id || '_position_idx',
      schema_name, table_name
    );

    EXECUTE format(
      'CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.%I (position) WHERE position IS NOT NULL',
      'dim_' || r.id || '_position_uniq',
      schema_name, table_name
    );
  END LOOP;
END $$;