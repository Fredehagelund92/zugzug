<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.png">
  <img alt="Zug Zug" src="docs/images/logo-light.png" height="46">
</picture>

### One record for `Brasil`, `Great Britain`, and every other spelling your warehouse can't agree on.

Zug Zug is a shared, spreadsheet-fast UI that runs next to your warehouse. Your team
maps messy values to one approved record and maintains the reference tables every
dashboard depends on — with roles, drafts, and full history. Publish, and the result
is plain SQL tables back in your own warehouse. Self-hosted, one command to run.

[**Live demo →**](https://demo.zugzughq.com) &nbsp;·&nbsp; [Docs](https://zugzughq.com/docs) &nbsp;·&nbsp; [Quickstart](#try-it) &nbsp;·&nbsp; [How it works](#how-it-works) &nbsp;·&nbsp; [Architecture](./ARCHITECTURE.md)

<sub>**Status: pre-1.0 — early release.** Expect rough edges and breaking changes between minor versions until v1.0.</sub>

<br>

<img alt="A Country reference table open in the Zug Zug grid — records with key, ISO-3, region, currency and EU-member columns, and a Publish button." src="docs/images/grid.png" width="860">

</div>

## What is this?

Every warehouse fills with names nobody agrees on — `BCG`, `B.C.G.`,
`Boston Consulting Group`, all the same company. Multiply that by every country,
currency, vendor, and channel your dashboards group by, and *"which spelling is real?"*
becomes a standing tax on every number your team reports.

**Zug Zug is where a human settles it.** Point it at a warehouse column with a
read-only credential; it scans the distinct values still waiting to be mapped. Your
team maps each one to an approved **record** in a spreadsheet-fast grid, and maintains
the **reference tables** — Country, Currency, Partner — those records live in.
Publishing materializes `dim_<x>` / `map_<x>` tables your warehouse can read directly.

**Everything you publish lands as plain tables in your own warehouse** — no lock-in,
no proprietary format. The mapping work your team does is yours to keep, with or
without Zug Zug.

> *The enterprise calls this "master data management." The incumbents — Tamr, Stibo,
> Reltio — cost six figures, are closed, and are built for a central governance team.
> Zug Zug is the small, self-hosted version, for the people who actually know the data.*

**Not entity resolution. Not an app builder.** No survivorship rules, no automatic
merging, no app platform — a person decides which values mean the same thing, and the
result is a table. Optional AI suggestions can propose a record for a value (bring your
own OpenAI/Anthropic key), but nothing is saved until a human confirms it.

## Try it

**Live demo — [demo.zugzughq.com](https://demo.zugzughq.com)** · one-click login, seeded
data, nothing to install. Poke the grid and the Review inbox in your browser.

**Or run it yourself in 30 seconds.** Requires [Docker](https://docs.docker.com/get-docker/) —
no warehouse or Google account needed:

```bash
git clone https://github.com/Fredehagelund92/zugzug.git
cd zugzug
docker compose up
```

Open `http://localhost:8080` and create your account — the first user becomes the
admin. It boots with sample reference tables like `Country` and `Product Category`,
plus a bundled local warehouse, so the grid and source catalog are live from the
first click. (First run builds the images — a few minutes; later runs start in
seconds.)

<sub>See [Develop locally](#develop-locally) to hot-reload the code, or `server/.env.example` to connect your own warehouse and turn off the demo seed.</sub>

## How it works

**1. Read-only in.** Connect with a read-only credential. Zug Zug scans `DISTINCT`
values from the columns you register as sources, and skips the ones already mapped —
it never writes to your warehouse unless you opt into a writable adapter.

**2. A human maps them.** The **Review** inbox lists every unmapped value across all
your tables, ordered by how often it occurs, so you spend time where the rows are.
You're not signing up to hand-map 40,000 spellings — the few hundred most frequent
usually cover the vast majority of your rows, and the long tail stays unmapped until
it's worth the effort. Map it, merge duplicates, or skip — with drafts, roles, and a
full audit trail.

<div align="center">
<img alt="The Zug Zug Review inbox — messy source values like 'Brasil' and 'Great Britain' mapped to approved records, with per-table progress and keyboard shortcuts." src="docs/images/review.png" width="860">
</div>

**3. Publish.** Drafts sit in Postgres until an editor **publishes**, folding them
into a new numbered table version and materializing the `dim_<x>` / `map_<x>` tables.
The audit log records who published what, and when. Then it's just a join:

```sql
-- Zug Zug publishes two tables per list:
--   map_country(raw, key)        — every source spelling → a record's key
--   dim_country(key, label, …)   — the approved records and their attributes
select o.*, d.label as country
from raw.orders o
left join map_country m on m.raw = o.shipping_country
left join dim_country d on d.key  = m.key
```

For the full picture — the three stores, the request path, the server subsystems —
see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Why not a CSV, a Google Sheet, or a dbt seed?

Because those work right up until a second person touches them.

- **A seed or CSV** has no review, no roles, and no history — one bad find-and-replace
  and you can't tell what changed or who did it. It also doesn't know what's in your
  warehouse, so nobody notices when a new spelling shows up.
- **A Google Sheet** lives outside your warehouse and outside version control. Zug Zug
  scans the actual `DISTINCT` values still waiting to be mapped, so the work is always
  the real backlog — not a stale copy someone exported last quarter.
- **A hand-written `CASE` statement** is the same list, buried in SQL, editable only by
  whoever owns the model. Zug Zug hands that list to the people who actually know
  whether `Brasil` is Brazil.

The honest tradeoff: this is a Postgres and a container that a CSV isn't. Worth it once
more than one person edits the same list — probably not before.

## Publishing is pull-first

The recommended path is **pull-first**: results live in Postgres, and your warehouse
team ingests them through the pipeline they already trust — a dbt source, the Pull
API, or an on-demand Parquet snapshot — so every publish flows through the same
dev→prod and review path as everything else.

Prefer a direct push? Configure a writable warehouse adapter and each publish writes
straight into your warehouse (e.g. a MotherDuck database you already query) — an opt-in
convenience that trades pipeline control for simplicity. See [ADR-0007](./docs/adr/0007-publish-is-pull-first.md).

Self-hosting? Read [backup & restore](https://zugzughq.com/docs/guides/backup-restore) *before* you have real
data to lose. Running it for real? See [Deploy to production](https://zugzughq.com/docs/guides/deploy) —
Caddy auto-HTTPS and bundled Postgres, with escape hatches for existing ingress and
managed databases.

## Adapters

A warehouse adapter is a small TypeScript interface (`WarehouseAdapter`). DuckDB /
MotherDuck is production-ready and is what the demo runs on; Snowflake is experimental;
other warehouses are community-roadmapped.

| Adapter | Status | Notes |
|---|---|---|
| DuckDB (read-only) | **shipped** | Local files, in-memory, or MotherDuck with a read-only token |
| DuckDB / MotherDuck (writable) | **opt-in, unverified against MotherDuck** | Set `MOTHERDUCK_WRITABLE=true`; token needs write access. The write path is covered end-to-end against a local writable DuckDB, but has not been run against a live MotherDuck account — validate on a staging database before relying on it. Publishing is [pull-first](docs/adr/0007-publish-is-pull-first.md) by design. |
| Snowflake | **experimental** | Key-pair (JWT) auth; the scan and publish paths work. Warehouse catalog auto-discovery isn't wired up yet, so you register sources by explicit path. |
| Postgres-as-warehouse | roadmapped | Community PR welcome — see [Add an adapter](https://github.com/Fredehagelund92/zugzug/issues/new?template=add-adapter.yml) |
| BigQuery | roadmapped | See above |
| Databricks | roadmapped | See above |

New adapters implement the interface in `server/src/warehouse/adapter.ts`; the
Snowflake adapter in `server/src/warehouse/snowflake/` is the reference
implementation.

## Auth

Two modes, switched by environment variable:

- **Password (default).** Local email + password. The first user to sign up becomes
  the admin and controls the invite allowlist via Settings → Team.
- **OIDC.** Set `OIDC_ISSUER_URL` to any compliant provider (Google Workspace, Okta,
  Authentik, Keycloak). The sign-in page shows an SSO button automatically.
- **API tokens.** Generated per workspace in Integrations → Service accounts
  (`zzsa_*`). Pass as `Authorization: Bearer <token>`; scoped to one workspace,
  intended for dbt CI and scripts.

See `server/.env.example` for every auth option.

## Develop locally

For hacking on Zug Zug with hot reload (Vite + `bun --watch`), run the two processes
directly. Prerequisites: [Bun](https://bun.sh) 1.x, Postgres 14+, and a warehouse you
have read access to.

```bash
git clone https://github.com/Fredehagelund92/zugzug.git
cd zugzug

# 1. Configure the server
cp server/.env.example server/.env
#   DATABASE_URL=postgres://user:pass@localhost:5432/zugzug
#   MOTHERDUCK_TOKEN=<your token>   (read-only is enough for scanning)
#   ATTACH_WAREHOUSE=true           (false by default; flip to enable scans)

# 2. Bootstrap (first run only). --seed provisions a small demo warehouse;
#    omit it if you have a real DATABASE_URL and MOTHERDUCK_TOKEN.
cd server && bun run bootstrap -- --seed

# 3. Start the backend (listens on :8787)
bun run start

# 4. In another shell, start the frontend
cd ../app && bun run dev
```

Open `http://localhost:5173`; the first user to sign up becomes the admin. For
non-default setups (Snowflake, OIDC, writable warehouse store), every option is
documented in `server/.env.example`.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All commits require a `Signed-off-by:` line
(DCO) — use `git commit -s`. To propose a new warehouse adapter, open an
[Add an adapter](https://github.com/Fredehagelund92/zugzug/issues/new?template=add-adapter.yml)
issue first — it helps to agree on the auth shape before writing code.

## License

MIT. See [LICENSE](./LICENSE).
