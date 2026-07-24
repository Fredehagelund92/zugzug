#!/usr/bin/env bash
# Reset the PUBLIC DEMO to a clean, freshly-seeded state.
#
# Wipes the Postgres volume (all workspace data) and reboots the stack; the demo
# seed re-runs on first boot (needs SEED_DEMO=true in .env). Deliberately keeps
# the Caddy TLS cert volume — wiping it would re-request certs nightly and hit
# Let's Encrypt rate limits.
#
# DESTRUCTIVE. Only ever run against a throwaway demo host. Guarded by an env var
# so it can't fire by accident; the nightly cron sets it:
#
#   DEMO_RESET_CONFIRM=yes ./scripts/demo-reset.sh
set -euo pipefail

if [ "${DEMO_RESET_CONFIRM:-}" != "yes" ]; then
  echo "refusing: set DEMO_RESET_CONFIRM=yes to reset the demo (this wipes ALL data)." >&2
  exit 1
fi

cd "$(dirname "$0")/.."
PROJECT="zugzug-prod"   # compose.prod.yml `name:`

echo "[demo-reset] $(date -u +%FT%TZ) wiping demo database…"
docker compose -f compose.prod.yml stop
docker volume rm "${PROJECT}_pgdata" 2>/dev/null || true
docker compose -f compose.prod.yml up -d
echo "[demo-reset] done — the demo reseeds on boot."
