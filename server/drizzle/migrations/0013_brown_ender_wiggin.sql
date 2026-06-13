CREATE SEQUENCE IF NOT EXISTS "zugzug_app"."preferences_id_seq";--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" ALTER COLUMN "id" SET DEFAULT nextval('"zugzug_app"."preferences_id_seq"');--> statement-breakpoint
ALTER SEQUENCE "zugzug_app"."preferences_id_seq" OWNED BY "zugzug_app"."preferences"."id";