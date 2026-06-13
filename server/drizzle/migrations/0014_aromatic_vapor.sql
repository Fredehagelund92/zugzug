ALTER TABLE "zugzug_app"."ai_hint_cache" DROP CONSTRAINT IF EXISTS "ai_hint_cache_dim_id_raw_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."canonical_version" DROP CONSTRAINT IF EXISTS "canonical_version_dim_id_key_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_field" DROP CONSTRAINT IF EXISTS "dimension_field_dim_id_field_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_source" DROP CONSTRAINT IF EXISTS "dimension_source_dim_id_source_table_source_column_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" DROP CONSTRAINT IF EXISTS "draft_dim_id_raw_user_id_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_stat" DROP CONSTRAINT IF EXISTS "source_stat_dim_id_source_table_source_column_pk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."active_sessions" DROP CONSTRAINT IF EXISTS "active_sessions_pkey";--> statement-breakpoint
ALTER TABLE "zugzug_app"."active_sessions" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."active_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."ai_hint_cache" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."ai_hint_cache" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."audit_log" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."audit_log" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."canonical_version" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."canonical_version" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension" DROP CONSTRAINT IF EXISTS "dimension_pkey";--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_field" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_field" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_source" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_source" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."scan_run" DROP CONSTRAINT IF EXISTS "scan_run_pkey";--> statement-breakpoint
ALTER TABLE "zugzug_app"."scan_run" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."scan_run" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_stat" ALTER COLUMN "tenant_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_stat" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'active_sessions'
      AND constraint_name = 'active_sessions_tenant_id_user_id_pk'
  ) THEN
    ALTER TABLE "zugzug_app"."active_sessions" ADD CONSTRAINT "active_sessions_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'ai_hint_cache'
      AND constraint_name = 'ai_hint_cache_tenant_id_dim_id_raw_pk'
  ) THEN
    ALTER TABLE "zugzug_app"."ai_hint_cache" ADD CONSTRAINT "ai_hint_cache_tenant_id_dim_id_raw_pk" PRIMARY KEY("tenant_id","dim_id","raw");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'canonical_version'
      AND constraint_name = 'canonical_version_tenant_id_dim_id_key_pk'
  ) THEN
    ALTER TABLE "zugzug_app"."canonical_version" ADD CONSTRAINT "canonical_version_tenant_id_dim_id_key_pk" PRIMARY KEY("tenant_id","dim_id","key");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'dimension'
      AND constraint_name = 'dimension_tenant_id_id_pk'
  ) THEN
    ALTER TABLE "zugzug_app"."dimension" ADD CONSTRAINT "dimension_tenant_id_id_pk" PRIMARY KEY("tenant_id","id");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'dimension_field'
      AND constraint_name = 'dimension_field_tenant_id_dim_id_field_pk'
  ) THEN
    ALTER TABLE "zugzug_app"."dimension_field" ADD CONSTRAINT "dimension_field_tenant_id_dim_id_field_pk" PRIMARY KEY("tenant_id","dim_id","field");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'dimension_source'
      AND constraint_name = 'dimension_source_tenant_id_dim_id_source_table_source_column_pk'
  ) THEN
    ALTER TABLE "zugzug_app"."dimension_source" ADD CONSTRAINT "dimension_source_tenant_id_dim_id_source_table_source_column_pk" PRIMARY KEY("tenant_id","dim_id","source_table","source_column");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'draft'
      AND constraint_name = 'draft_tenant_id_dim_id_raw_user_id_pk'
  ) THEN
    ALTER TABLE "zugzug_app"."draft" ADD CONSTRAINT "draft_tenant_id_dim_id_raw_user_id_pk" PRIMARY KEY("tenant_id","dim_id","raw","user_id");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'scan_run'
      AND constraint_name = 'scan_run_tenant_id_id_pk'
  ) THEN
    ALTER TABLE "zugzug_app"."scan_run" ADD CONSTRAINT "scan_run_tenant_id_id_pk" PRIMARY KEY("tenant_id","id");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'source_stat'
      AND constraint_name = 'source_stat_tenant_id_dim_id_source_table_source_column_pk'
  ) THEN
    ALTER TABLE "zugzug_app"."source_stat" ADD CONSTRAINT "source_stat_tenant_id_dim_id_source_table_source_column_pk" PRIMARY KEY("tenant_id","dim_id","source_table","source_column");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  -- Delete orphaned audit_log rows (test artifacts) before adding FK
  DELETE FROM "zugzug_app"."audit_log" WHERE tenant_id NOT IN (SELECT id FROM "zugzug_app"."tenant");
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'active_sessions'
      AND constraint_name = 'active_sessions_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."active_sessions" ADD CONSTRAINT "active_sessions_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'ai_hint_cache'
      AND constraint_name = 'ai_hint_cache_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."ai_hint_cache" ADD CONSTRAINT "ai_hint_cache_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'audit_log'
      AND constraint_name = 'audit_log_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'canonical_version'
      AND constraint_name = 'canonical_version_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."canonical_version" ADD CONSTRAINT "canonical_version_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'dimension'
      AND constraint_name = 'dimension_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."dimension" ADD CONSTRAINT "dimension_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'dimension_field'
      AND constraint_name = 'dimension_field_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."dimension_field" ADD CONSTRAINT "dimension_field_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'dimension_source'
      AND constraint_name = 'dimension_source_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."dimension_source" ADD CONSTRAINT "dimension_source_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'draft'
      AND constraint_name = 'draft_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."draft" ADD CONSTRAINT "draft_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'preferences'
      AND constraint_name = 'preferences_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."preferences" ADD CONSTRAINT "preferences_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'scan_run'
      AND constraint_name = 'scan_run_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."scan_run" ADD CONSTRAINT "scan_run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'source_stat'
      AND constraint_name = 'source_stat_tenant_id_tenant_id_fk'
  ) THEN
    ALTER TABLE "zugzug_app"."source_stat" ADD CONSTRAINT "source_stat_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "zugzug_app"."tenant"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."users" ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp;
