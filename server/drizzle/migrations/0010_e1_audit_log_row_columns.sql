ALTER TABLE "zugzug_app"."audit_log" ADD COLUMN "table_id" varchar;--> statement-breakpoint
ALTER TABLE "zugzug_app"."audit_log" ADD COLUMN "row_key" varchar;--> statement-breakpoint
CREATE INDEX "audit_log_table_row_recency_idx" ON "zugzug_app"."audit_log" USING btree ("table_id","row_key","created_at" DESC NULLS LAST) WHERE "zugzug_app"."audit_log"."table_id" IS NOT NULL;