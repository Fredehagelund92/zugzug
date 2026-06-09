# dbt Community Slack

## Channel

#tools (or #oss-tools if it exists)

---

## Message

Hey folks — just open-sourced something I've wanted for a while: Zugzug, a curation UI for reconciling raw warehouse values to canonical IDs before your dbt models join them.

The pattern it addresses: you have a column like `raw_partner_name` with "BCG", "B.C.G.", "Boston Consulting Group" all meaning the same thing. You want a `map_partner` table your dbt models can `LEFT JOIN ... USING (raw_partner_name)`. Zugzug scans distinct values, lets your team curate them via a browser UI with a draft + approval flow, and writes the `dim_`/`map_` tables. Canonical results default to Postgres, downloadable as Parquet — useful if Zugzug can't write to your warehouse directly (read-only creds, VPC restrictions, etc.).

Self-hosted, MIT licensed, v0.1 (early — expect rough edges). Requires Bun + Postgres. DuckDB/MotherDuck and Snowflake adapters ship in v0.1.

https://github.com/Fredehagelund92/zugzug

Looking for feedback from anyone who's tried to bolt curation onto dbt before — what hurts most?
