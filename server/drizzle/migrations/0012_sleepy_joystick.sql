CREATE INDEX "ai_hint_cache_tenant_dim_idx" ON "zugzug_app"."ai_hint_cache" USING btree ("tenant_id","dim_id");--> statement-breakpoint
CREATE INDEX "canonical_version_tenant_dim_idx" ON "zugzug_app"."canonical_version" USING btree ("tenant_id","dim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "preferences_tenant_unique" ON "zugzug_app"."preferences" USING btree ("tenant_id");
--> statement-breakpoint
-- Backfill: collapse duplicate preferences rows per tenant (defense vs prior race).
DELETE FROM "zugzug_app"."preferences" a
USING "zugzug_app"."preferences" b
WHERE a.tenant_id = b.tenant_id
  AND a.id > b.id;
--> statement-breakpoint
-- Add tenant_id to existing dynamic dim_/map_ tables. We discover them via the
-- dimension registry; each row gives us the canonical schema path + owning tenant.
DO $$
DECLARE
  d RECORD;
BEGIN
  FOR d IN SELECT id, dim_table, map_table, tenant_id FROM "zugzug_app"."dimension" LOOP
    EXECUTE format(
      'ALTER TABLE %s ADD COLUMN IF NOT EXISTS tenant_id VARCHAR NOT NULL DEFAULT %L',
      d.dim_table, d.tenant_id
    );
    EXECUTE format(
      'ALTER TABLE %s ADD COLUMN IF NOT EXISTS tenant_id VARCHAR NOT NULL DEFAULT %L',
      d.map_table, d.tenant_id
    );
  END LOOP;
END $$;