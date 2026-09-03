ALTER TABLE "zugzug_app"."preferences"
  ADD COLUMN IF NOT EXISTS "auto_publish_enabled" boolean NOT NULL DEFAULT false;
