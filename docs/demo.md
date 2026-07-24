# Run a public demo (cheap VM)

A throwaway, self-resetting public demo of Zug Zug, seeded with a full fictional
dataset (`server/src/seed.ts`) so visitors land on a populated instance —
governed reference tables, typed columns, a hierarchy, and live value-mapping in
published / in-review / unmapped states.

The Zug Zug app is a stateful stack (Bun + Postgres + DuckDB), so it runs on a
container host, **not** Vercel. The website goes on Vercel; the demo goes here.

## Cheapest host

A small VPS running the repo's `compose.prod.yml` verbatim — Caddy auto-HTTPS
included. Any of these work; cheapest first:

- **Hetzner CX22** — ~€4/mo (2 vCPU / 4 GB), plenty for a demo.
- **DigitalOcean / Vultr** — ~$4–6/mo.

You need a domain (or subdomain, e.g. `demo.zugzug.dev`) with a DNS **A** record
pointing at the VM.

## Deploy

On a fresh Ubuntu VM with [Docker](https://docs.docker.com/engine/install/ubuntu/):

```bash
git clone https://github.com/Fredehagelund92/zugzug.git
cd zugzug
cp .env.prod.example .env
```

Edit `.env` for a demo:

```bash
DOMAIN=demo.zugzug.dev
ACME_EMAIL=you@example.com
ORIGIN=https://demo.zugzug.dev
POSTGRES_PASSWORD=$(openssl rand -hex 32)
ZUGZUG_CURSOR_KEY=$(openssl rand -base64 32)
SEED_DEMO=true                             # load the fictional demo dataset on first boot
ATTACH_WAREHOUSE=true                       # attach the bundled local warehouse
WAREHOUSE_ADAPTER=duckdb
DUCK_WAREHOUSE_PATH=/data/warehouse.duckdb  # generated on first boot with sample messy data
```

With the local warehouse attached, the demo shows the full loop — browse the
catalog, wire a source column, scan it, then map and publish. No MotherDuck token
or cloud needed; the warehouse is a local DuckDB file on the `/data` volume
(preserved across resets, so it's generated only once).

Launch:

```bash
docker compose -f compose.prod.yml up -d --build
```

Point DNS at the VM, wait for Caddy to provision the certificate, and open
`https://demo.zugzug.dev`. The **first signup becomes the admin** — do it once
yourself so the demo has an owner.

## Keep it clean (daily reset)

The demo will accumulate visitor signups and edits. Reset it on a schedule.

The reset is a single in-place command — `bun run demo-reset` — that empties all
workspace data and reseeds the fictional demo. It's DB-level, so there's no
restart or downtime, and it never touches the bundled warehouse or the TLS cert
(no Let's Encrypt rate-limit risk). It's guarded by `DEMO_RESET_CONFIRM=yes` so
it can never fire by accident. **Never point it at a real instance** — it
destroys all data.

**On a VM (compose)** — a nightly cron running the bundled wrapper, which execs
the reset inside the running server container:

```bash
# crontab -e  (as the user that owns the repo)
0 4 * * *  cd /home/USER/zugzug && DEMO_RESET_CONFIRM=yes ./scripts/demo-reset.sh >> /var/log/zugzug-demo-reset.log 2>&1
```

**On Fly.io** — a scheduled Machine runs the same command once a day, then
stops. Create it once in your app; it reuses the app image and inherits the
app's Fly secrets (`DATABASE_URL` etc.), so you only pass the warehouse env and
the confirm flag. Get the current image ref from `fly image show -a <app>`:

```bash
fly machine run registry.fly.io/<app>:<tag> \
  --app <app> \
  --schedule daily \
  --env DEMO_RESET_CONFIRM=yes \
  --env WAREHOUSE_ADAPTER=duckdb \
  --env DUCK_WAREHOUSE_PATH=/data/warehouse.duckdb \
  bun run demo-reset
```

The scheduled Machine regenerates its own copy of the sample warehouse (the
generator is deterministic), so the scan produces identical values regardless of
which Machine runs it — no shared volume needed.

## Link it from the site

Once it's live, add a _"Try the live demo →"_ button on the landing page
pointing at your demo URL.
