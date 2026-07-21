# Zugzug

> The missing curation UI for the dbt stack.

**Status: v0.1 — early release.** Expect rough edges and breaking changes between minor versions until v1.0.

Your warehouse accumulates raw strings that nobody agrees on: "BCG", "B.C.G.", "Boston Consulting Group". dbt has no primitive to reconcile them. Existing MDM tools (Tamr, Stibo, Reltio) are enterprise-priced and closed-source. Zugzug is the gap between "messy values land in the warehouse" and "dbt models join clean dimensions." A team maps source values to approved records in a browser UI; results land in `dim_<x>` / `map_<x>` tables dbt can join directly.

The same grid maintains the dimensions themselves as governed reference tables — the one Country or Currency list your dashboards and finance close depend on — edited in place like a spreadsheet, with roles, audit history, and CSV import/export. Not entity resolution, not an app builder: curated lists and the mappings into them, materialized where dbt can join them.

```
warehouse (read-only)
        |
        v
  scan distinct values
  (filter out already-mapped)
        |
        v
  human curates in UI  <-- drafts, comments, bulk approval
        |
        v
     commit
        |
        v
  dim_partner / map_partner  -->  dbt: LEFT JOIN map_partner USING (raw_partner_name)
```

## How it works

You connect Zugzug to your warehouse with a read-only credential. The adapter scans `DISTINCT` values from the columns you register as dimensions — it never modifies the warehouse unless you explicitly configure a writable adapter.

The UI shows unmapped values alongside their frequency counts. Team members map each source value to a record (a `key` + `label` pair). Mappings sit in Postgres as drafts until an editor publishes them. The audit log records who published what and when.

Publishing writes `dim_<x>` and `map_<x>` tables. In default mode (Postgres record store), results live in Postgres and are downloadable as Parquet on demand. If you configure a writable warehouse adapter, each publish writes directly into your warehouse — for example, into a MotherDuck database your dbt project already reads.

The warehouse adapter is a TypeScript interface (`WarehouseAdapter`). DuckDB/MotherDuck and Snowflake are shipped. Additional adapters (Postgres-as-warehouse, BigQuery, Databricks) are community-roadmapped — see the issue template below.

For the full picture — the three stores, the request path, and the server subsystems — see [ARCHITECTURE.md](./ARCHITECTURE.md). Self-hosting? Read [backup & restore](./docs/operations.md) before you have real data to lose.

## Try it in 30 seconds

Requires [Docker](https://docs.docker.com/get-docker/). No warehouse or Google account needed.

```bash
git clone https://github.com/Fredehagelund92/zugzug.git
cd zugzug
docker compose up
```

Open `http://localhost:8080` and create your account — the first user becomes the admin. The demo boots with sample reference tables like `Country` and `Product Category` so you can explore the grid right away. (First run builds the images; that takes a few minutes. Later runs start in seconds.)

To connect your own warehouse or turn off the demo seed, see [Develop locally](#develop-locally) and `server/.env.example`.

## Develop locally

For hacking on Zugzug with hot reload (Vite + `bun --watch`), run the two processes directly:

Prerequisites: [Bun](https://bun.sh) 1.x, Postgres 14+, and a warehouse you have read access to.

```bash
git clone https://github.com/Fredehagelund92/zugzug.git
cd zugzug
```

### 1. Configure the server

```bash
cp server/.env.example server/.env
# Edit server/.env:
#   DATABASE_URL=postgres://user:pass@localhost:5432/zugzug
#   MOTHERDUCK_TOKEN=<your token>   (read-only is enough for scanning)
#   ATTACH_WAREHOUSE=true           (false by default; flip to enable scans)
```

### 2. Bootstrap (first run only)

```bash
cd server && bun run bootstrap -- --seed
```

`--seed` provisions a small demo warehouse so you can explore without connecting a real warehouse. Omit it if you have a real `DATABASE_URL` and `MOTHERDUCK_TOKEN`.

### 3. Start the backend

```bash
# still in server/
bun run start
```

The API listens on `:8787`.

### 4. Start the frontend

```bash
cd ../app && bun run dev
```

Open `http://localhost:5173`. The first user to sign up becomes the admin.

For non-default setups (Snowflake, OIDC, writable warehouse store), see `server/.env.example` — every option is documented there.

## Adapters

| Adapter | Status | Notes |
|---|---|---|
| DuckDB (read-only) | shipped | Local files, in-memory, or MotherDuck with a read-only token |
| DuckDB / MotherDuck (writable) | shipped | Set `MOTHERDUCK_WRITABLE=true`; token needs write access |
| Snowflake | shipped | Key-pair auth; `authenticator: SNOWFLAKE_JWT`. Password and SSO auth not yet implemented. |
| Postgres-as-warehouse | roadmapped | Community PR welcome — see [Add an adapter](https://github.com/Fredehagelund92/zugzug/issues/new?template=add-adapter.yml) |
| BigQuery | roadmapped | See above |
| Databricks | roadmapped | See above |

New adapters implement the `WarehouseAdapter` interface in `server/src/warehouse/adapter.ts`. The Snowflake adapter in `server/src/warehouse/snowflake/` is the reference implementation.

## Auth

Two modes, switched by environment variable:

**Password mode (default):** Local email + password. The first user to sign up becomes the admin and controls the invite allowlist via Settings → Team.

**OIDC mode:** Set `OIDC_ISSUER_URL` to any compliant provider (Google Workspace, Okta, Authentik, Keycloak). The sign-in page shows an SSO button automatically.

**API tokens:** Generated per workspace in Integrations → Service accounts (`zzsa_*`). Pass as `Authorization: Bearer <token>`. Scoped to one workspace; intended for dbt CI and scripts.

See `server/.env.example` for all auth options.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). All commits require a `Signed-off-by:` line (DCO). Use `git commit -s`.

To propose a new warehouse adapter, open an [Add an adapter](https://github.com/Fredehagelund92/zugzug/issues/new?template=add-adapter.yml) issue first — it helps to agree on the auth shape before writing code.

## License

MIT. See [LICENSE](./LICENSE).
