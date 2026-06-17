CREATE TABLE "zugzug_app"."dim_scan_value" (
  "tenant_id"  varchar NOT NULL,
  "dim_id"     varchar NOT NULL,
  "raw"        varchar NOT NULL,
  "raw_lower"  varchar NOT NULL,
  "total_rows" bigint  NOT NULL,
  "scanned_at" timestamp NOT NULL,
  CONSTRAINT "dim_scan_value_pk" PRIMARY KEY ("tenant_id", "dim_id", "raw_lower"),
  CONSTRAINT "dim_scan_value_raw_nonempty"   CHECK (length("raw") > 0),
  CONSTRAINT "dim_scan_value_total_rows_nonneg" CHECK ("total_rows" >= 0),
  CONSTRAINT "dim_scan_value_tenant_fk" FOREIGN KEY ("tenant_id")
    REFERENCES "zugzug_app"."tenant"("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX "dim_scan_value_dim_rows_idx"
  ON "zugzug_app"."dim_scan_value" ("tenant_id", "dim_id", "total_rows" DESC);
--> statement-breakpoint

CREATE TABLE "zugzug_app"."dim_scan_occurrence" (
  "tenant_id"   varchar NOT NULL,
  "dim_id"      varchar NOT NULL,
  "raw_lower"   varchar NOT NULL,
  "table_name"  varchar NOT NULL,
  "column_name" varchar NOT NULL,
  "rows"        bigint  NOT NULL,
  CONSTRAINT "dim_scan_occurrence_pk"
    PRIMARY KEY ("tenant_id", "dim_id", "raw_lower", "table_name", "column_name"),
  CONSTRAINT "dim_scan_occurrence_rows_nonneg" CHECK ("rows" >= 0),
  CONSTRAINT "dim_scan_occurrence_tenant_fk" FOREIGN KEY ("tenant_id")
    REFERENCES "zugzug_app"."tenant"("id") ON DELETE CASCADE
);
--> statement-breakpoint

ALTER TABLE "zugzug_app"."dim_scan_value"      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zugzug_app"."dim_scan_occurrence" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_iso ON "zugzug_app"."dim_scan_value"
  USING (tenant_id = current_setting('app.tenant_id')
         OR current_setting('app.is_super_admin', true) = 't');
--> statement-breakpoint
CREATE POLICY tenant_iso ON "zugzug_app"."dim_scan_occurrence"
  USING (tenant_id = current_setting('app.tenant_id')
         OR current_setting('app.is_super_admin', true) = 't');
