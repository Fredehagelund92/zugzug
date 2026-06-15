CREATE TABLE "zugzug_app"."auth_credential_quota" (
	"credential_id" varchar PRIMARY KEY NOT NULL,
	"window_started_at" timestamp NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zugzug_app"."tenant_slug_alias" (
	"old_slug" varchar PRIMARY KEY NOT NULL,
	"tenant_id" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zugzug_app"."tenant_slug_alias" ADD CONSTRAINT "tenant_slug_alias_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_credential_quota_window_idx" ON "zugzug_app"."auth_credential_quota" USING btree ("window_started_at");--> statement-breakpoint
CREATE INDEX "tenant_slug_alias_tenant_idx" ON "zugzug_app"."tenant_slug_alias" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_slug_alias_expires_idx" ON "zugzug_app"."tenant_slug_alias" USING btree ("expires_at");