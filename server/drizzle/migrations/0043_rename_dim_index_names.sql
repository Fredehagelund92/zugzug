-- ADR-0006 banned `dim` from schema identifiers, but 0039/0040 renamed only
-- tables and columns — Postgres keeps index names across a table rename, so
-- these five still carry the old vocabulary. Renamed from the names the
-- database actually holds (schema.ts was text-renamed in those sweeps and has
-- been ahead of the database ever since).
ALTER INDEX "zugzug_app"."dimension_source_dim_idx"    RENAME TO "reference_table_source_ref_table_idx";--> statement-breakpoint
ALTER INDEX "zugzug_app"."ai_hint_cache_dim_id_idx"    RENAME TO "ai_hint_cache_ref_table_id_idx";--> statement-breakpoint
ALTER INDEX "zugzug_app"."ai_hint_cache_tenant_dim_idx" RENAME TO "ai_hint_cache_tenant_ref_table_idx";--> statement-breakpoint
ALTER INDEX "zugzug_app"."dim_scan_value_dim_rows_idx" RENAME TO "source_scan_value_ref_table_rows_idx";--> statement-breakpoint
ALTER INDEX "zugzug_app"."canonical_version_tenant_dim_idx" RENAME TO "record_version_tenant_ref_table_idx";
