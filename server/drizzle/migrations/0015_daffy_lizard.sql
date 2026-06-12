ALTER TABLE "zugzug_app"."active_sessions" DROP CONSTRAINT IF EXISTS "active_sessions_tenant_id_user_id_pk";--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'zugzug_app' AND table_name = 'active_sessions'
      AND constraint_name = 'active_sessions_pkey'
      AND constraint_type = 'PRIMARY KEY'
  ) THEN
    ALTER TABLE "zugzug_app"."active_sessions" ADD PRIMARY KEY ("user_id");
  END IF;
END $$;
