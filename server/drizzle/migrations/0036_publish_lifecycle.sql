CREATE TABLE IF NOT EXISTS "zugzug_app"."dimension_version" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "dim_id" text NOT NULL,
  "version" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'publish',
  "restores_version" integer,
  "snapshot" jsonb NOT NULL,
  "published_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dimension_version_kind_chk" CHECK ("kind" IN ('publish','rollback')),
  CONSTRAINT "dimension_version_unique" UNIQUE ("tenant_id","dim_id","version")
);
--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_version" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."dimension_version"
  USING (tenant_id = current_setting('app.tenant_id')
         OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ADD COLUMN IF NOT EXISTS "rejected_reason" text;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ADD COLUMN IF NOT EXISTS "rejected_by" text;
