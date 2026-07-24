ALTER TABLE "zugzug_app"."dimension" RENAME TO "reference_table";--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_source" RENAME TO "reference_table_source";--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_field" RENAME TO "reference_table_field";--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_version" RENAME TO "reference_table_version";--> statement-breakpoint
ALTER TABLE "zugzug_app"."dim_scan_value" RENAME TO "source_scan_value";--> statement-breakpoint
ALTER TABLE "zugzug_app"."dim_scan_occurrence" RENAME TO "source_scan_occurrence";--> statement-breakpoint
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'zugzug_app' AND column_name = 'dim_id'
  LOOP
    EXECUTE format('ALTER TABLE "zugzug_app".%I RENAME COLUMN "dim_id" TO "reference_table_id"', r.table_name);
  END LOOP;
END $$;
