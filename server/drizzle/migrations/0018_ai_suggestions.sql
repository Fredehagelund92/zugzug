-- Add source, confidence, reasoning columns to draft table
ALTER TABLE "zugzug_app"."draft"
ADD COLUMN "source" varchar NOT NULL DEFAULT 'user'
ADD COLUMN "confidence" varchar
ADD COLUMN "reasoning" varchar;

-- Add CHECK constraints
ALTER TABLE "zugzug_app"."draft"
ADD CONSTRAINT "draft_source_check" CHECK ("source" IN ('user', 'ai'));

ALTER TABLE "zugzug_app"."draft"
ADD CONSTRAINT "draft_confidence_check" CHECK ("confidence" IN ('high', 'medium', 'low') OR "confidence" IS NULL);

-- Add AI config columns to preferences table
ALTER TABLE "zugzug_app"."preferences"
ADD COLUMN "ai_enabled" boolean NOT NULL DEFAULT false
ADD COLUMN "ai_provider" varchar NOT NULL DEFAULT 'none'
ADD COLUMN "ai_api_key" varchar;

-- Add CHECK constraint for ai_provider
ALTER TABLE "zugzug_app"."preferences"
ADD CONSTRAINT "preferences_ai_provider_check" CHECK ("ai_provider" IN ('openai', 'anthropic', 'none'));
