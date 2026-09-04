-- The confidence bands (publish_threshold / suggest_threshold) were stored and
-- returned but never read: the slider that set them controlled nothing and was
-- removed, and auto-publish is governed by auto_publish_enabled (0041).
ALTER TABLE "zugzug_app"."preferences" DROP COLUMN IF EXISTS "publish_threshold";--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" DROP COLUMN IF EXISTS "suggest_threshold";
