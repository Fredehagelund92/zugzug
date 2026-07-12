ALTER TABLE "zugzug_app"."preferences"
  ADD COLUMN IF NOT EXISTS "require_second_publisher" boolean NOT NULL DEFAULT false;
