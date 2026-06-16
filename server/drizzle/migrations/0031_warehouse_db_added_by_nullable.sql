-- Warehouse databases auto-register from adapter discovery, so the
-- "added_by" actor is now optional (null = system auto-register).
ALTER TABLE "zugzug_app"."warehouse_database" ALTER COLUMN "added_by" DROP NOT NULL;
