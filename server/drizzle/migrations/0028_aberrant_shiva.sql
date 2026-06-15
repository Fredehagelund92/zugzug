ALTER TABLE "zugzug_app"."api_tokens" ALTER COLUMN "token_prefix" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" DROP COLUMN "legacy_default_database_id";--> statement-breakpoint
ALTER TABLE "zugzug_app"."tenant" DROP COLUMN "warehouse_id";