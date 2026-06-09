ALTER TABLE "zugzug_app"."users" ADD COLUMN "role" varchar DEFAULT 'editor' NOT NULL;

-- Backfill: every existing user on v0.1 → v0.2 is treated as admin.
-- The small group of v0.1 deployers are de-facto admins today; opt-out via
-- Settings → Team post-upgrade.
UPDATE "zugzug_app"."users" SET "role" = 'admin';