-- Enable RLS on every scoped table. The policy intentionally drops the `, true`
-- argument from `current_setting('app.tenant_id')` so a missing SET LOCAL throws
-- `unrecognized configuration parameter` rather than silently zero-rowing.
-- The super-admin escape uses `current_setting('app.is_super_admin', true) = 't'`
-- (with `true` arg) so it falls through when not set — bypass is opt-in.
--
-- App Postgres role keeps BYPASSRLS for the first 24h post-deploy as a safety
-- net; revoke after a clean smoke pass:
--   ALTER ROLE zugzug NOBYPASSRLS;

ALTER TABLE "zugzug_app"."dimension"          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_source"   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension_field"    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."source_stat"        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."draft"              ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."audit_log"          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."canonical_version"  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."ai_hint_cache"      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."preferences"        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."scan_run"           ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."active_sessions"    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_iso ON "zugzug_app"."dimension"          USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."dimension_source"   USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."dimension_field"    USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."source_stat"        USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."draft"              USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."audit_log"          USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."canonical_version"  USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."ai_hint_cache"      USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."preferences"        USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."scan_run"           USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."active_sessions"    USING (tenant_id = current_setting('app.tenant_id') OR current_setting('app.is_super_admin', true) = 't');
