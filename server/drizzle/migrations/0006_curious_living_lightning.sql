CREATE TABLE "zugzug_app"."api_tokens" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"token_hash" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "zugzug_app"."users" ADD COLUMN "password_hash" varchar;--> statement-breakpoint
ALTER TABLE "zugzug_app"."users" ADD COLUMN "auth_provider" varchar DEFAULT 'password' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_unique" ON "zugzug_app"."api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user_id_idx" ON "zugzug_app"."api_tokens" USING btree ("user_id");--> statement-breakpoint
-- Backfill: existing users with a google_sub came in via Google OAuth (now OIDC).
UPDATE "zugzug_app"."users" SET "auth_provider" = 'oidc' WHERE "google_sub" IS NOT NULL;