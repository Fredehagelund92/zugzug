# Hacker News

## Title

Show HN: Zugzug – open-source curation UI for the dbt stack

---

## First comment

Data teams end up with messy string values in their warehouse: "BCG", "B.C.G.", "Boston Consulting Group." dbt has no primitive to reconcile them. You can hack it with seed files or macros, but there's no real UI for it — which means curation work either gets skipped or lives in a notebook someone runs manually. The commercial MDM tools that solve this (Tamr, Stibo, Reltio) are enterprise-priced and not built for teams that already live in the dbt ecosystem.

Zugzug is a self-hosted TypeScript/React app that fills that gap. You point it at your warehouse read-only, it scans distinct values from columns you register as dimensions, and your team reconciles them to canonical IDs via a browser UI. Assignments go through a draft + approval flow with an audit log. Committing writes `dim_<x>` and `map_<x>` tables — either into Postgres (default, exportable as Parquet) or back into your warehouse if you configure a writable adapter. The warehouse itself is never touched except by explicit commit. dbt then joins those tables as normal.

The backend is Bun + TypeScript with a `WarehouseAdapter` interface. DuckDB/MotherDuck and Snowflake (key-pair auth) ship in v0.1. Postgres-as-warehouse, BigQuery, and Databricks are roadmapped for community contribution. App state (drafts, audit, users) always lives in Postgres — the warehouse connection is read-only by default. Self-hosting requires Bun and Postgres; `bun run bootstrap` walks through setup.

This is v0.1 — early, expect breaking changes between minor versions. Production self-hosters welcome but heads-up.

Repo: https://github.com/Fredehagelund92/zugzug
Screenshot: <!-- add URL -->

Happy to answer questions about the architecture or the pivot story.
