CREATE TABLE "zugzug_app"."ai_hint_cache" (
	"dim_id" varchar NOT NULL,
	"raw" varchar NOT NULL,
	"suggestion" varchar,
	"confidence" integer NOT NULL,
	"reasoning" varchar NOT NULL,
	"model" varchar NOT NULL,
	"created_at" timestamp NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_hint_cache_dim_id_raw_pk" PRIMARY KEY("dim_id","raw")
);
--> statement-breakpoint
CREATE INDEX "ai_hint_cache_dim_id_idx" ON "zugzug_app"."ai_hint_cache" USING btree ("dim_id");