ALTER TABLE "zugzug_app"."preferences" ALTER COLUMN "id" SET DATA TYPE serial;--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ADD COLUMN "source" varchar DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ADD COLUMN "confidence" varchar;--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ADD COLUMN "reasoning" varchar;--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" ADD COLUMN "ai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" ADD COLUMN "ai_provider" varchar DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" ADD COLUMN "ai_api_key" varchar;--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ADD CONSTRAINT "draft_source_chk" CHECK ("zugzug_app"."draft"."source" IN ('user', 'ai'));--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ADD CONSTRAINT "draft_confidence_chk" CHECK ("zugzug_app"."draft"."confidence" IS NULL OR "zugzug_app"."draft"."confidence" IN ('high', 'medium', 'low'));--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" ADD CONSTRAINT "preferences_ai_provider_chk" CHECK ("zugzug_app"."preferences"."ai_provider" IN ('openai', 'anthropic', 'none'));