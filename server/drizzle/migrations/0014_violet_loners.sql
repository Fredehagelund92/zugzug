ALTER TABLE "zugzug_app"."active_sessions" ADD COLUMN IF NOT EXISTS "impersonating_tenant_id" varchar;--> statement-breakpoint
ALTER TABLE "zugzug_app"."users" ADD COLUMN "last_seen_at" timestamp;