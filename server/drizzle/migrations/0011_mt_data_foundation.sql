CREATE TABLE "zugzug_app"."tenant" (
	"id" varchar PRIMARY KEY NOT NULL,
	"slug" varchar NOT NULL,
	"label" varchar NOT NULL,
	"warehouse_id" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "tenant_id_format" CHECK ("zugzug_app"."tenant"."id" ~ '^[a-z][a-z0-9_]{0,20}$'),
	CONSTRAINT "tenant_slug_format" CHECK ("zugzug_app"."tenant"."slug" ~ '^[a-z][a-z0-9_]{0,20}$')
);
--> statement-breakpoint
CREATE TABLE "zugzug_app"."tenant_invite" (
	"tenant_id" varchar NOT NULL,
	"email" varchar NOT NULL,
	"role" varchar NOT NULL,
	"invited_by" varchar NOT NULL,
	"invited_at" timestamp NOT NULL,
	CONSTRAINT "tenant_invite_tenant_id_email_pk" PRIMARY KEY("tenant_id","email"),
	CONSTRAINT "tenant_invite_role_chk" CHECK ("zugzug_app"."tenant_invite"."role" IN ('admin', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "zugzug_app"."tenant_member" (
	"tenant_id" varchar NOT NULL,
	"user_id" varchar NOT NULL,
	"role" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "tenant_member_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "tenant_member_role_chk" CHECK ("zugzug_app"."tenant_member"."role" IN ('admin', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "zugzug_app"."active_sessions" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."ai_hint_cache" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."audit_log" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."canonical_version" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_field" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_source" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."scan_run" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_stat" ADD COLUMN "tenant_id" varchar DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "zugzug_app"."users" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "tenant_invite_email_idx" ON "zugzug_app"."tenant_invite" USING btree ("email");--> statement-breakpoint
CREATE INDEX "tenant_member_user_idx" ON "zugzug_app"."tenant_member" USING btree ("user_id");

-- Backfill: seed the default tenant + memberships from existing users.
--> statement-breakpoint

INSERT INTO "zugzug_app"."tenant" (id, slug, label, warehouse_id, created_at)
VALUES ('default', 'default', 'Default', 'default', now())
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

-- Existing rows in scoped tables get tenant_id = 'default' via the column DEFAULT
-- applied at ADD COLUMN time. No explicit UPDATE needed in Postgres 11+.

-- Memberships: every existing user becomes a member of the default tenant with
-- their current users.role. Idempotent.
INSERT INTO "zugzug_app"."tenant_member" (tenant_id, user_id, role, created_at)
SELECT 'default', id, role, now()
  FROM "zugzug_app"."users"
ON CONFLICT (tenant_id, user_id) DO NOTHING;
--> statement-breakpoint

-- Indexes that Drizzle didn't generate but the spec calls out for read paths.
CREATE INDEX IF NOT EXISTS "dimension_tenant_idx"
  ON "zugzug_app"."dimension" (tenant_id);
CREATE INDEX IF NOT EXISTS "draft_tenant_idx"
  ON "zugzug_app"."draft" (tenant_id);
CREATE INDEX IF NOT EXISTS "audit_log_tenant_time_idx"
  ON "zugzug_app"."audit_log" (tenant_id, created_at DESC);