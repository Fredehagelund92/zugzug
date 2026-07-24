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

## Keep it clean (nightly reset)

The demo will accumulate visitor signups and edits. Reset it on a schedule with
the bundled script — it wipes the database and reseeds on boot, **preserving the
TLS cert** (so you don't hit Let's Encrypt rate limits):

```bash
# crontab -e  (as the user that owns the repo)
0 4 * * *  cd /home/USER/zugzug && DEMO_RESET_CONFIRM=yes ./scripts/demo-reset.sh >> /var/log/zugzug-demo-reset.log 2>&1
```

The reset guard (`DEMO_RESET_CONFIRM=yes`) exists so it can never fire by
accident. **Never point this at a real instance** — it destroys all data.

## Link it from the site

Once it's live, add a *"Try the live demo →"* button on the landing page
pointing at your demo URL.
