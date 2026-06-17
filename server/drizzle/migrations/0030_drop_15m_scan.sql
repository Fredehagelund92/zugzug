-- Hourly is now the minimum scan cadence; coerce any legacy '15m' rows to 'hourly'.
UPDATE "zugzug_app"."preferences" SET "scan_schedule" = 'hourly' WHERE "scan_schedule" = '15m';
