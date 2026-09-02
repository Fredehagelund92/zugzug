-- A failed scan (timeout, auth error, warehouse blip) used to be stored as
-- present=false, i.e. indistinguishable from "the column is gone". Keep the
-- failure reason so the two can be told apart; NULL means the last scan
-- actually reached the warehouse.
ALTER TABLE "zugzug_app"."source_stat"
  ADD COLUMN IF NOT EXISTS "scan_error" text;
