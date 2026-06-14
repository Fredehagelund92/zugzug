CREATE TABLE "zugzug_app"."outbound_event" (
	"id" varchar PRIMARY KEY NOT NULL,
	"tenant_id" varchar NOT NULL,
	"type" varchar(64) NOT NULL,
	"dim_id" varchar,
	"occurred_at" timestamp NOT NULL,
	"payload" jsonb NOT NULL,
	"idem_key" varchar(128) NOT NULL,
	CONSTRAINT "outbound_event_type_chk" CHECK ("zugzug_app"."outbound_event"."type" IN (
        'dimension.committed',
        'dimension.created',
        'dimension.schema.updated',
        'canonical.deleted'
      ))
);
--> statement-breakpoint
CREATE TABLE "zugzug_app"."service_account" (
	"id" varchar PRIMARY KEY NOT NULL,
	"tenant_id" varchar NOT NULL,
	"name" varchar NOT NULL,
	"token_hash" varchar NOT NULL,
	"token_prefix" varchar(12) NOT NULL,
	"scopes" varchar[] DEFAULT ARRAY['read']::varchar[] NOT NULL,
	"created_at" timestamp NOT NULL,
	"created_by" varchar NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"expires_at" timestamp,
	CONSTRAINT "service_account_scope_chk" CHECK ("zugzug_app"."service_account"."scopes" <@ ARRAY['read', 'webhook:manage']::varchar[]
           AND cardinality("zugzug_app"."service_account"."scopes") >= 1)
);
--> statement-breakpoint
CREATE TABLE "zugzug_app"."webhook" (
	"id" varchar PRIMARY KEY NOT NULL,
	"tenant_id" varchar NOT NULL,
	"url" varchar(2048) NOT NULL,
	"secret_ciphertext" "bytea" NOT NULL,
	"secret_nonce" "bytea" NOT NULL,
	"secret_key_version" integer DEFAULT 1 NOT NULL,
	"secret_prefix" varchar(12) NOT NULL,
	"secret_ciphertext_previous" "bytea",
	"secret_nonce_previous" "bytea",
	"secret_previous_expires_at" timestamp,
	"secret_prefix_previous" varchar(12),
	"events" varchar[] NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"description" varchar,
	"created_at" timestamp NOT NULL,
	"created_by" varchar NOT NULL,
	"paused_at" timestamp,
	"disabled_at" timestamp,
	"disabled_reason" varchar,
	CONSTRAINT "webhook_status_chk" CHECK (status IN ('active', 'paused', 'disabled')),
	CONSTRAINT "webhook_url_scheme_chk" CHECK ("zugzug_app"."webhook"."url" ~* '^https?://'),
	CONSTRAINT "webhook_events_nonempty_chk" CHECK (cardinality("zugzug_app"."webhook"."events") > 0),
	CONSTRAINT "webhook_events_known_chk" CHECK ("zugzug_app"."webhook"."events" <@ ARRAY[
        'dimension.committed',
        'dimension.created',
        'dimension.schema.updated',
        'canonical.deleted'
      ]::varchar[])
);
--> statement-breakpoint
CREATE TABLE "zugzug_app"."webhook_delivery" (
	"id" varchar PRIMARY KEY NOT NULL,
	"tenant_id" varchar NOT NULL,
	"webhook_id" varchar NOT NULL,
	"event_id" varchar NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"delivery_url" varchar(2048) NOT NULL,
	"signing_kid" varchar(16) NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"status" varchar(16) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp,
	"last_attempt_at" timestamp,
	"last_response_code" integer,
	"last_response_body" text,
	"last_error" text,
	"payload" jsonb NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "webhook_delivery_status_chk" CHECK (status IN ('pending', 'in_flight', 'success', 'retry', 'dlq')),
	CONSTRAINT "webhook_delivery_signing_kid_chk" CHECK (signing_kid IN ('current', 'previous'))
);
--> statement-breakpoint
ALTER TABLE "zugzug_app"."api_tokens" ADD COLUMN "token_prefix" varchar(12);--> statement-breakpoint
ALTER TABLE "zugzug_app"."canonical_version" ADD COLUMN "retired_at" timestamp;--> statement-breakpoint
ALTER TABLE "zugzug_app"."canonical_version" ADD COLUMN "retired_into" varchar;--> statement-breakpoint
ALTER TABLE "zugzug_app"."outbound_event" ADD CONSTRAINT "outbound_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zugzug_app"."service_account" ADD CONSTRAINT "service_account_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zugzug_app"."webhook" ADD CONSTRAINT "webhook_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zugzug_app"."webhook_delivery" ADD CONSTRAINT "webhook_delivery_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_event_tenant_idem_unique" ON "zugzug_app"."outbound_event" USING btree ("tenant_id","idem_key");--> statement-breakpoint
CREATE INDEX "outbound_event_tenant_type_time_idx" ON "zugzug_app"."outbound_event" USING btree ("tenant_id","type","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_account_token_hash_unique" ON "zugzug_app"."service_account" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "service_account_tenant_prefix_idx" ON "zugzug_app"."service_account" USING btree ("tenant_id","token_prefix");--> statement-breakpoint
CREATE INDEX "service_account_tenant_idx" ON "zugzug_app"."service_account" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhook_tenant_idx" ON "zugzug_app"."webhook" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "webhook_delivery_due_idx" ON "zugzug_app"."webhook_delivery" USING btree ("next_attempt_at") WHERE status IN ('pending', 'retry');--> statement-breakpoint
CREATE INDEX "webhook_delivery_webhook_time_idx" ON "zugzug_app"."webhook_delivery" USING btree ("webhook_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_delivery_in_flight_reaper_idx" ON "zugzug_app"."webhook_delivery" USING btree ("last_attempt_at") WHERE status = 'in_flight';--> statement-breakpoint
CREATE INDEX "api_tokens_prefix_idx" ON "zugzug_app"."api_tokens" USING btree ("token_prefix") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "canonical_version_pull_idx" ON "zugzug_app"."canonical_version" USING btree ("tenant_id","dim_id","updated_at","key") WHERE retired_at IS NULL;--> statement-breakpoint
CREATE INDEX "canonical_version_tombstone_idx" ON "zugzug_app"."canonical_version" USING btree ("tenant_id","dim_id","retired_at") WHERE retired_at IS NOT NULL;--> statement-breakpoint
-- Drop the Drizzle-generated webhook_delivery_webhook_time_idx and replace
-- with an INCLUDE variant so the auto-disable scan (PR3) can answer "are
-- the last 50 non-test deliveries all DLQ?" index-only, no heap fetch.
-- Drizzle 0.45.2 cannot express INCLUDE through its index() helper.
DROP INDEX IF EXISTS "zugzug_app"."webhook_delivery_webhook_time_idx";--> statement-breakpoint
CREATE INDEX "webhook_delivery_webhook_time_idx"
  ON "zugzug_app"."webhook_delivery" ("webhook_id", "created_at" DESC)
  INCLUDE ("status", "is_test");