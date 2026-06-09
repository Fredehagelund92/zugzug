CREATE TABLE "zugzug_app"."scan_run" (
	"id" varchar PRIMARY KEY NOT NULL,
	"source_id" varchar NOT NULL,
	"started_at" timestamp NOT NULL,
	"ended_at" timestamp,
	"status" varchar NOT NULL,
	"rows_scanned" integer,
	"duration_ms" integer,
	"error_message" text
);
--> statement-breakpoint
CREATE INDEX "scan_run_source_id_idx" ON "zugzug_app"."scan_run" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "scan_run_started_at_idx" ON "zugzug_app"."scan_run" USING btree ("started_at");--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_source" DROP COLUMN "schedule";