DROP INDEX IF EXISTS "zugzug_app"."dim_scan_value_dim_rows_idx";
--> statement-breakpoint
CREATE INDEX "dim_scan_value_dim_rows_idx"
  ON "zugzug_app"."dim_scan_value" ("tenant_id", "dim_id", "total_rows" DESC, "raw_lower" ASC);
