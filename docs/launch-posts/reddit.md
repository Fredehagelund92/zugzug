# Reddit — r/dataengineering

## Title

[Open Source] Zugzug – curation UI for the dbt stack

---

## Post

Most teams I've talked to solve the "messy string values" problem one of three ways: a seed file someone manually edits, a custom dbt macro that normalizes known variants, or a Jupyter notebook that runs on a prayer. None of those scale when the source of the messiness is a third-party feed with 3,000 distinct `partner_name` values and your analysts need to approve the mapping, not just eyeball it.

Zugzug is a self-hosted web app that sits between your warehouse and your dbt models and lets a team curate raw values to canonical IDs. It scans `DISTINCT` values from columns you register, shows them in a UI with frequency counts, and lets users assign each raw value to a canonical record (key + label). Assignments go through a draft → approval flow with a full audit log. On commit, it writes `dim_<x>` and `map_<x>` tables.

**Why TypeScript + Bun instead of Python?** The app is a web UI with an API, not a data pipeline. TypeScript gives end-to-end type safety between the frontend and the backend without a separate schema layer. Bun starts fast and its test runner has been enough so far. DuckDB is used for the warehouse adapter because it handles MotherDuck natively and the `@duckdb/node-api` bindings are solid.

**Why a UI at all?** The curation step is fundamentally a human task — someone with domain knowledge has to decide that "B.C.G." maps to the same canonical ID as "BCG." A notebook works for a one-time cleanup; it doesn't work when your source adds new values every week and you need an approver in the loop.

**Why not just X?** If X is "write it in dbt with seeds and tests," that works until you have 50 dimensions and non-technical people who need to approve changes. If X is Tamr or Stibo, they're not self-hostable and not priced for a 5-person data team.

**Architecture:** Bun + TypeScript backend, React 18 frontend, `WarehouseAdapter` interface. DuckDB/MotherDuck and Snowflake (key-pair auth) ship in v0.1. Postgres-as-warehouse, BigQuery, and Databricks are roadmapped. App state (drafts, audit log, users) in Postgres. Canonical results default to Postgres, exportable as Parquet; or write back to your warehouse if you have a writable adapter. Auth is password by default or OIDC for SSO.

Self-host requirements: Bun, Postgres 14+, read access to your warehouse. `bun run bootstrap -- --seed` sets up a demo warehouse to explore without connecting a real one.

MIT licensed. v0.1.0 — early release; rough edges exist and breaking changes between minor versions are likely until v1.0.

https://github.com/Fredehagelund92/zugzug

Feedback welcome, especially from anyone who's wrestled with this in production.
