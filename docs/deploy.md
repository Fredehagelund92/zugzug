# Deploy to production (self-hosted)

Turnkey HTTPS deploy: Caddy gets you an automatic Let's Encrypt certificate,
and a bundled Postgres runs out of the box. Two escape hatches below cover
existing ingress and managed databases.

See [ARCHITECTURE.md](../ARCHITECTURE.md) for the stack and
[operations](./operations.md) for backup/restore.

## Prerequisites

- A host with [Docker](https://docs.docker.com/get-docker/) and ports **80 + 443** open to the internet and free on the host (not already bound by another web server or reverse proxy — if they are, Caddy can't bind them and ACME will fail).
- A DNS **A**/**AAAA** record for your domain pointing at the host.

## 1. Configure

```bash
git clone https://github.com/Fredehagelund92/zugzug.git
cd zugzug
cp .env.prod.example .env
```

Edit `.env`:
- `DOMAIN` — your domain (e.g. `zugzug.acme.com`).
- `ACME_EMAIL` — your email (Let's Encrypt expiry notices).
- `ORIGIN` — `https://<DOMAIN>` (must match; this makes cookies `Secure`).
- Generate secrets:
  ```bash
  openssl rand -hex 32    # -> POSTGRES_PASSWORD
  openssl rand -base64 32 # -> ZUGZUG_CURSOR_KEY
  ```

## 2. Launch

```bash
docker compose -f compose.prod.yml up -d --build
```

Caddy provisions the TLS certificate on first request (needs the DNS record live
and 80/443 reachable). Open `https://<DOMAIN>` and **create the first account —
it becomes the admin.** Do this immediately; to restrict who else can sign up,
set `ALLOWED_DOMAIN` (or configure OIDC) in `.env` and `up -d` again.

## Escape hatches

**Behind existing ingress / your own TLS** — remove the `caddy` service from
`compose.prod.yml`, publish `app` on a host port (e.g. `ports: ["8080:80"]`),
terminate TLS in your upstream proxy, and keep `ORIGIN=https://<domain>`.

**Managed / external Postgres** — remove the `postgres` service, set
`DATABASE_URL` in `.env` to your managed instance (e.g.
`postgres://user:pass@host:5432/db?sslmode=require`), and also remove the
`depends_on: postgres` block from the `server` service in `compose.prod.yml`
(leaving it causes `docker compose` to error with "undefined service postgres").
Recommended at scale for managed backups/PITR.

## Operate

- **Back up Postgres** and, if you use webhooks, the **webhook master key** — see [operations](./operations.md). Losing the master key orphans every stored webhook secret.
- **Warehouse (optional):** set `ATTACH_WAREHOUSE=true` + `MOTHERDUCK_TOKEN`. If you enable `MOTHERDUCK_WRITABLE=true` (publishing `dim_`/`map_` into your warehouse), validate against a staging warehouse first — it's the least-tested path.
- **Updates:** `git pull && docker compose -f compose.prod.yml up -d --build`. Migrations run automatically on server boot.
