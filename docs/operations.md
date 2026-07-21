# Operations: backup & restore

Zugzug keeps its durable, hard-to-recreate state in **Postgres** (drafts, audit
log, users, table versions — and, in the default mode, the published records and
mappings themselves). If you self-host, backing up Postgres is the one thing you
must not skip. This guide covers what to back up, how, and how to restore.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the three-store model these
instructions follow.

## What to back up (in priority order)

1. **Postgres (`zugzug_app` schema) — critical.** Drafts and audit history live
   nowhere else. In the default mode (`MOTHERDUCK_WRITABLE=false`) your published
   records and mappings live here too. Lose this and you lose the workspace.
2. **The server `/data` volume — important if you use webhooks.** It holds the
   auto-generated cursor key and, when `WEBHOOKS_ENABLED=1`, the AES-256-GCM
   **webhook master key**. Losing the master key makes every stored webhook
   signing secret unrecoverable. The cursor key alone is low-stakes (rotating
   just forces Pull-API clients to resync from `?since=`).
3. **Your warehouse — usually not your job.** The warehouse is read-only to
   Zugzug, and MotherDuck is managed (with snapshots / `UNDROP`). If you run in
   `MOTHERDUCK_WRITABLE=true` mode, the published `dim_`/`map_` tables can be
   re-materialized by re-publishing from Postgres — so Postgres is still the
   source of truth to protect.

## Backing up Postgres

### Docker Compose deployment

The demo/compose stack runs Postgres as the `postgres` service (user `zugzug`,
database `zugzug`). Dump it to a file on the host:

```bash
docker compose exec -T postgres \
  pg_dump -U zugzug -d zugzug --format=custom \
  > "zugzug-$(date +%Y%m%d-%H%M%S).dump"
```

`--format=custom` is compressed and restores with `pg_restore` (selective,
parallel). For a plain SQL dump instead, drop `--format=custom` and it restores
with `psql`.

### External / managed Postgres

If `DATABASE_URL` points at your own Postgres (RDS, Neon, Supabase, self-run),
use `pg_dump` directly against it:

```bash
pg_dump "$DATABASE_URL" --format=custom > zugzug-$(date +%Y%m%d).dump
```

Managed providers usually also offer automated snapshots/PITR — enable those;
they're the lowest-effort safety net.

### Schedule it

A backup you don't take doesn't exist. Run the dump on a cron (daily is a sane
default for most teams) and keep several days of history off-box. Match the
cadence to how much curation work you're willing to lose — that's your RPO.

## Backing up the `/data` volume

Copy the generated keys out of the server's data dir (compose volume
`serverdata`, mounted at `/data`):

```bash
docker compose cp server:/data ./zugzug-data-backup
```

Or supply the keys explicitly via env instead of relying on auto-generation
(`ZUGZUG_CURSOR_KEY`, `ZUGZUG_WEBHOOK_MASTER_KEY` / `..._FILE`) and store them
in your secret manager — then there's nothing in `/data` to lose. Either way,
**keep the webhook master key somewhere you can recover it.**

## Restoring

1. **Bring up a clean Postgres** (or an empty target database). With compose:
   `docker compose up -d postgres` against an empty `pgdata` volume.
2. **Restore the dump.** The server runs migrations on boot, but a restore of a
   full dump recreates the schema and data directly:
   ```bash
   # custom-format dump:
   docker compose exec -T postgres \
     pg_restore -U zugzug -d zugzug --clean --if-exists < zugzug-YYYYMMDD.dump
   # plain SQL dump instead:
   #   docker compose exec -T postgres psql -U zugzug -d zugzug < zugzug-YYYYMMDD.sql
   ```
3. **Restore `/data`** if you're using webhooks, so the master key matches the
   encrypted secrets in the restored database:
   ```bash
   docker compose cp ./zugzug-data-backup/. server:/data
   ```
4. **Start the rest of the stack** (`docker compose up -d`) and verify:
   `curl -fsS http://localhost:8080/api/health` returns `{"ok":true,...}`, and
   your tables + audit history are present in the app.

## Test your restore

An untested backup is a guess. At least once, restore a dump into a throwaway
database and confirm the app comes up against it and the data is intact. Do this
before you need it, not during an incident.
