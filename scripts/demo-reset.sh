#!/usr/bin/env bash
# Reset the PUBLIC DEMO to a clean, freshly-seeded state — in place.
#
# Runs the DB-level reset inside the running server container: it empties all
# workspace data and reseeds the fictional demo. No restart, no downtime; the
# bundled local warehouse and the Caddy TLS cert are left untouched.
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

echo "[demo-reset] $(date -u +%FT%TZ) resetting demo…"
docker compose -f compose.prod.yml exec -T \
  -e DEMO_RESET_CONFIRM=yes server bun run demo-reset
echo "[demo-reset] done."
