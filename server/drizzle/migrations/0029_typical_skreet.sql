-- Remove personal access tokens. Headless access is now via service accounts only
-- (zugzug_app.service_account, Integrations → Service accounts).
DROP TABLE "zugzug_app"."api_tokens" CASCADE;
