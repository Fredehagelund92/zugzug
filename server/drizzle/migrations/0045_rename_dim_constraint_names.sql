-- The last of the ADR-0006 vocabulary. 0039/0040 renamed tables and columns and
-- 0043 caught five indexes; Postgres carries constraint names across a table
-- rename, so every primary key, foreign key, check and the remaining indexes
-- still read `dimension` / `canonical_version` / `dim_id`. Written from the
-- names the database actually holds (schema.ts has been ahead of it since those
-- sweeps), and renamed to the names drizzle derives from schema.ts so the two
-- finally agree. Three primary keys derive to more than Postgres' 63-character
-- identifier limit, so those carry an explicit short name in schema.ts instead.

-- reference_table
ALTER TABLE "zugzug_app"."reference_table" RENAME CONSTRAINT "dimension_tenant_id_id_pk" TO "reference_table_tenant_id_id_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table" RENAME CONSTRAINT "dimension_tenant_id_tenant_id_fk" TO "reference_table_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table" RENAME CONSTRAINT "dimension_ordering_mode_chk" TO "reference_table_ordering_mode_chk";--> statement-breakpoint
ALTER INDEX "zugzug_app"."dimension_tenant_idx" RENAME TO "reference_table_tenant_idx";--> statement-breakpoint

-- reference_table_source
ALTER TABLE "zugzug_app"."reference_table_source" RENAME CONSTRAINT "dimension_source_tenant_id_dim_id_database_id_schema_name_table" TO "reference_table_source_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table_source" RENAME CONSTRAINT "dimension_source_tenant_id_tenant_id_fk" TO "reference_table_source_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table_source" RENAME CONSTRAINT "dimension_source_database_fk" TO "reference_table_source_database_fk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table_source" RENAME CONSTRAINT "dimension_source_schema_name_nonempty" TO "reference_table_source_schema_name_nonempty";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table_source" RENAME CONSTRAINT "dimension_source_table_name_nonempty" TO "reference_table_source_table_name_nonempty";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table_source" RENAME CONSTRAINT "dimension_source_column_name_nonempty" TO "reference_table_source_column_name_nonempty";--> statement-breakpoint
ALTER INDEX "zugzug_app"."dimension_source_database_idx" RENAME TO "reference_table_source_database_idx";--> statement-breakpoint

-- reference_table_field
ALTER TABLE "zugzug_app"."reference_table_field" RENAME CONSTRAINT "dimension_field_tenant_id_dim_id_field_pk" TO "reference_table_field_tenant_id_reference_table_id_field_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table_field" RENAME CONSTRAINT "dimension_field_tenant_id_tenant_id_fk" TO "reference_table_field_tenant_id_tenant_id_fk";--> statement-breakpoint

-- reference_table_version
ALTER TABLE "zugzug_app"."reference_table_version" RENAME CONSTRAINT "dimension_version_pkey" TO "reference_table_version_pkey";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table_version" RENAME CONSTRAINT "dimension_version_unique" TO "reference_table_version_unique";--> statement-breakpoint
ALTER TABLE "zugzug_app"."reference_table_version" RENAME CONSTRAINT "dimension_version_kind_chk" TO "reference_table_version_kind_chk";--> statement-breakpoint

-- record_version
ALTER TABLE "zugzug_app"."record_version" RENAME CONSTRAINT "canonical_version_tenant_id_dim_id_key_pk" TO "record_version_tenant_id_reference_table_id_key_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."record_version" RENAME CONSTRAINT "canonical_version_tenant_id_tenant_id_fk" TO "record_version_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER INDEX "zugzug_app"."canonical_version_pull_idx" RENAME TO "record_version_pull_idx";--> statement-breakpoint
ALTER INDEX "zugzug_app"."canonical_version_recent_idx" RENAME TO "record_version_recent_idx";--> statement-breakpoint
ALTER INDEX "zugzug_app"."canonical_version_tombstone_idx" RENAME TO "record_version_tombstone_idx";--> statement-breakpoint

-- source_scan_value
ALTER TABLE "zugzug_app"."source_scan_value" RENAME CONSTRAINT "dim_scan_value_pk" TO "source_scan_value_tenant_id_reference_table_id_raw_lower_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_scan_value" RENAME CONSTRAINT "dim_scan_value_tenant_fk" TO "source_scan_value_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_scan_value" RENAME CONSTRAINT "dim_scan_value_raw_nonempty" TO "source_scan_value_raw_nonempty";--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_scan_value" RENAME CONSTRAINT "dim_scan_value_total_rows_nonneg" TO "source_scan_value_total_rows_nonneg";--> statement-breakpoint

-- source_scan_occurrence
ALTER TABLE "zugzug_app"."source_scan_occurrence" RENAME CONSTRAINT "dim_scan_occurrence_pk" TO "source_scan_occurrence_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_scan_occurrence" RENAME CONSTRAINT "dim_scan_occurrence_tenant_fk" TO "source_scan_occurrence_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_scan_occurrence" RENAME CONSTRAINT "dim_scan_occurrence_rows_nonneg" TO "source_scan_occurrence_rows_nonneg";--> statement-breakpoint

-- source_stat, ai_hint_cache, draft, user_grid_layout
ALTER TABLE "zugzug_app"."source_stat" RENAME CONSTRAINT "source_stat_tenant_id_dim_id_database_id_schema_name_table_name" TO "source_stat_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."ai_hint_cache" RENAME CONSTRAINT "ai_hint_cache_tenant_id_dim_id_raw_pk" TO "ai_hint_cache_tenant_id_reference_table_id_raw_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" RENAME CONSTRAINT "draft_tenant_id_dim_id_raw_user_id_pk" TO "draft_tenant_id_reference_table_id_raw_user_id_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."user_grid_layout" RENAME CONSTRAINT "user_grid_layout_user_id_dim_id_pk" TO "user_grid_layout_user_id_reference_table_id_pk";
