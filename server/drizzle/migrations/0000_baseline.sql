CREATE SCHEMA IF NOT EXISTS "zugzug_app";
CREATE SCHEMA IF NOT EXISTS "zugzug";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."active_sessions" (
	"user_id" varchar PRIMARY KEY NOT NULL,
	"last_seen" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."allowed_emails" (
	"email" varchar PRIMARY KEY NOT NULL,
	"added_by" varchar NOT NULL,
	"added_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."audit_log" (
	"id" varchar PRIMARY KEY NOT NULL,
	"created_at" timestamp NOT NULL,
	"user_id" varchar NOT NULL,
	"action" varchar NOT NULL,
	"detail" varchar NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."dimension" (
	"id" varchar PRIMARY KEY NOT NULL,
	"label" varchar NOT NULL,
	"dim_table" varchar NOT NULL,
	"map_table" varchar NOT NULL,
	"key_col" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"key_kind" varchar,
	"name_table" varchar,
	"name_id_col" varchar,
	"name_col" varchar
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."dimension_field" (
	"dim_id" varchar NOT NULL,
	"field" varchar NOT NULL,
	"label" varchar NOT NULL,
	"type" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"options" varchar,
	CONSTRAINT "dimension_field_dim_id_field_pk" PRIMARY KEY("dim_id","field")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."dimension_source" (
	"dim_id" varchar NOT NULL,
	"source_table" varchar NOT NULL,
	"source_column" varchar NOT NULL,
	"schedule" varchar,
	CONSTRAINT "dimension_source_dim_id_source_table_source_column_pk" PRIMARY KEY("dim_id","source_table","source_column")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."draft" (
	"dim_id" varchar NOT NULL,
	"raw" varchar NOT NULL,
	"status" varchar NOT NULL,
	"target_label" varchar,
	"target_key" varchar,
	"user_id" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "draft_dim_id_raw_user_id_pk" PRIMARY KEY("dim_id","raw","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."preferences" (
	"id" integer PRIMARY KEY NOT NULL,
	"publish_threshold" integer NOT NULL,
	"suggest_threshold" integer NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."sessions" (
	"id" varchar PRIMARY KEY NOT NULL,
	"user_id" varchar NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."source_stat" (
	"dim_id" varchar NOT NULL,
	"source_table" varchar NOT NULL,
	"source_column" varchar NOT NULL,
	"present" boolean NOT NULL,
	"rows" bigint NOT NULL,
	"distinct_values" bigint NOT NULL,
	"unmapped" bigint NOT NULL,
	"scanned_at" timestamp NOT NULL,
	CONSTRAINT "source_stat_dim_id_source_table_source_column_pk" PRIMARY KEY("dim_id","source_table","source_column")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."user_grid_layout" (
	"user_id" varchar NOT NULL,
	"dim_id" varchar NOT NULL,
	"config" varchar NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "user_grid_layout_user_id_dim_id_pk" PRIMARY KEY("user_id","dim_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zugzug_app"."users" (
	"id" varchar PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"initials" varchar NOT NULL,
	"email" varchar,
	"google_sub" varchar
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "zugzug_app"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "zugzug_app"."users" USING btree ("email") WHERE email IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_sub_unique" ON "zugzug_app"."users" USING btree ("google_sub") WHERE google_sub IS NOT NULL;
