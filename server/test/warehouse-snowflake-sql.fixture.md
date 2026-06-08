# SnowflakeAdapter — expected SQL strings (live-validation reference)

This file documents the SQL each SnowflakeAdapter method produces. Use it to
hand-validate against a real Snowflake account before declaring Phase 2
production-ready. Each block can be pasted into a Snowflake Worksheet.

**Test fixture creds used below:**
- account: abc123.eu-west-1
- database: ANALYTICS
- schema: PUBLIC
- warehouse: WH

**Test fixture data:** create these once before live-validating:

```sql
CREATE OR REPLACE SCHEMA ANALYTICS.RAW;

CREATE OR REPLACE TABLE ANALYTICS.RAW.PARTNERS (
  ID NUMBER,
  NAME VARCHAR,
  REGION VARCHAR
);
INSERT INTO ANALYTICS.RAW.PARTNERS VALUES
  (1, 'Acme', 'US'),
  (2, 'Acme Inc', 'us'),
  (3, 'Foo', 'EU'),
  (4, '', NULL),
  (5, 'Bar', 'EU');

CREATE OR REPLACE TABLE ANALYTICS.RAW.COUNTRIES (
  CODE VARCHAR,
  LABEL VARCHAR
);
INSERT INTO ANALYTICS.RAW.COUNTRIES VALUES
  ('US', 'United States'),
  ('EU', 'European Union');
```

---

## ping()

```sql
SELECT 1 AS OK
```

Expected: 1 row, column `OK` = 1.

---

## tableExists({schema: 'RAW', table: 'PARTNERS'})

```sql
SELECT 1 FROM "ANALYTICS"."RAW"."PARTNERS" LIMIT 0
```

Expected: 0 rows, no error. Returns true.

---

## listTables({})

Two queries, joined in JS:

```sql
-- Query 1: TABLES
SELECT TABLE_SCHEMA, TABLE_NAME
FROM "ANALYTICS".INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA') AND TABLE_TYPE IN ('BASE TABLE','VIEW')
ORDER BY TABLE_SCHEMA, TABLE_NAME
LIMIT 5000;

-- Query 2: COLUMNS
SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
FROM "ANALYTICS".INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA')
ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
LIMIT 100000;
```

Expected: PARTNERS and COUNTRIES in TABLES; their 5 columns in COLUMNS.

---

## listColumns({schema: 'RAW', table: 'PARTNERS'})

```sql
SELECT COLUMN_NAME, DATA_TYPE
FROM "ANALYTICS".INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'RAW' AND TABLE_NAME = 'PARTNERS'
ORDER BY ORDINAL_POSITION
```

Expected: 3 rows — (ID, NUMBER), (NAME, VARCHAR), (REGION, VARCHAR).

---

## distinctValues({schema: 'RAW', table: 'PARTNERS'}, 'REGION', 100)

```sql
SELECT DISTINCT CAST("REGION" AS VARCHAR) AS V
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
ORDER BY 1
LIMIT 100
```

Expected: 3 rows — EU, US, us.

---

## topValuesByFrequency({schema: 'RAW', table: 'PARTNERS'}, 'REGION', 10)

```sql
SELECT CAST("REGION" AS VARCHAR) AS V, COUNT(*) AS N
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
GROUP BY 1
ORDER BY N DESC, V
LIMIT 10
```

Expected: EU=2, US=1, us=1.

---

## columnStats({schema: 'RAW', table: 'PARTNERS'}, 'REGION', {approximate: false})

```sql
SELECT COUNT("REGION") AS ROWS, COUNT(DISTINCT "REGION") AS D
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
```

Expected: ROWS=4, D=3.

---

## columnStats({schema: 'RAW', table: 'PARTNERS'}, 'REGION', {approximate: true})

```sql
SELECT COUNT("REGION") AS ROWS, APPROX_COUNT_DISTINCT("REGION") AS D
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
```

Expected: ROWS=4, D≈3 (small dataset → exact match).

---

## nameResolution({schema: 'RAW', table: 'COUNTRIES'}, 'CODE', 'LABEL')

```sql
SELECT CAST("CODE" AS VARCHAR) AS ID, CAST("LABEL" AS VARCHAR) AS NM
FROM "ANALYTICS"."RAW"."COUNTRIES"
WHERE "CODE" IS NOT NULL
```

Expected: 2 rows — (US, United States), (EU, European Union).

---

## distinctValuesWithProvenance — 2 sources

```sql
SELECT CAST("REGION" AS VARCHAR) AS V, 0 AS SRC_IDX, COUNT(*) AS N
FROM "ANALYTICS"."RAW"."PARTNERS"
WHERE "REGION" IS NOT NULL AND LENGTH(TRIM(CAST("REGION" AS VARCHAR))) > 0
GROUP BY 1
UNION ALL
SELECT CAST("CODE" AS VARCHAR) AS V, 1 AS SRC_IDX, COUNT(*) AS N
FROM "ANALYTICS"."RAW"."COUNTRIES"
WHERE "CODE" IS NOT NULL AND LENGTH(TRIM(CAST("CODE" AS VARCHAR))) > 0
GROUP BY 1
```

Expected: 5 rows — 3 from PARTNERS (EU=2, US=1, us=1), 2 from COUNTRIES (US=1, EU=1).

---

## ensureCanonicalTables

```sql
CREATE TABLE IF NOT EXISTS "ANALYTICS"."ZUGZUG"."DIM_COUNTRY" (
  "COUNTRY_CODE" VARCHAR PRIMARY KEY,
  LABEL VARCHAR
);

CREATE TABLE IF NOT EXISTS "ANALYTICS"."ZUGZUG"."MAP_COUNTRY" (
  "RAW" VARCHAR PRIMARY KEY,
  "COUNTRY_CODE" VARCHAR NOT NULL
);
```

(Pre-req: `CREATE SCHEMA IF NOT EXISTS ANALYTICS.ZUGZUG;`)

Expected: both tables exist after running.

---

## commitCanonical — small batch (3 drafts)

Task 9 chose the simpler form `USING (VALUES (?, ?), ...) AS S(colA, colB)`.

dim_country MERGE:

```sql
MERGE INTO "ANALYTICS"."ZUGZUG"."DIM_COUNTRY" T
USING (VALUES (?, ?), (?, ?)) AS S("COUNTRY_CODE", LABEL)
ON T."COUNTRY_CODE" = S."COUNTRY_CODE"
WHEN NOT MATCHED THEN INSERT ("COUNTRY_CODE", LABEL) VALUES (S."COUNTRY_CODE", S.LABEL);
```
Binds: `['US', 'United States', 'GB', 'United Kingdom']`

map_country MERGE:

```sql
MERGE INTO "ANALYTICS"."ZUGZUG"."MAP_COUNTRY" T
USING (VALUES (?, ?), (?, ?), (?, ?)) AS S("RAW", "COUNTRY_CODE")
ON T."RAW" = S."RAW"
WHEN NOT MATCHED THEN INSERT ("RAW", "COUNTRY_CODE") VALUES (S."RAW", S."COUNTRY_CODE");
```
Binds: `['USA', 'US', 'U.S.', 'US', 'United Kingdom', 'GB']`

Expected: dim_country gets 2 rows (US, GB); map_country gets 3 rows.

---

## Live-validation checklist

When credentials become available, run each block above in a Snowflake Worksheet
against the fixture dataset. Confirm:

- [ ] All `LIVE-VALIDATION:` comments in `index.ts` and `sdk-wrapper.ts` are resolved.
- [ ] Column case in returned rows matches expectations (UPPERCASE by default).
- [ ] Key-pair auth works end-to-end with a real PEM.
- [ ] `getNumUpdatedRows()` returns the expected count after each MERGE.
- [ ] MERGE INTO + USING (VALUES ...) syntax is accepted as-is, OR the fallback
      (temp-table approach noted in Task 9's LIVE-VALIDATION comment) needs implementation.
- [ ] If anything diverges from this fixture, update both the fixture AND the
      adapter implementation in the same commit so the doc stays the source of
      truth for "what the adapter actually produces."
