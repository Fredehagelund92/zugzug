#!/usr/bin/env sh
set -e

# Auto-generate a Pull-API cursor-signing key on first boot if none supplied.
# Persisted in the mounted data volume so it survives restarts. Losing it just
# invalidates in-flight Pull-API cursors (clients resync from ?since=), so this
# is low-stakes — but a stable key avoids surprising 500s on the read API.
if [ -z "$ZUGZUG_CURSOR_KEY" ]; then
  KEY_FILE="${ZUGZUG_DATA_DIR:-/data}/cursor.key"
  mkdir -p "$(dirname "$KEY_FILE")"
  if [ ! -f "$KEY_FILE" ]; then
    head -c 32 /dev/urandom | base64 | tr -d '\n' > "$KEY_FILE"
    echo "· generated cursor key at $KEY_FILE"
  fi
  ZUGZUG_CURSOR_KEY="$(cat "$KEY_FILE")"
  export ZUGZUG_CURSOR_KEY
fi

# Auto-generate the webhook master key on first boot if none supplied.
# Persisted in the mounted data volume so it MUST survive restarts: losing it
# would invalidate every stored webhook signing secret (AES-256-GCM encrypted
# with this key), making all webhooks fail to dispatch. Unlike the cursor key,
# regeneration here is destructive — always read from the persisted file.
if [ -z "$ZUGZUG_WEBHOOK_MASTER_KEY" ] && [ -z "$ZUGZUG_WEBHOOK_MASTER_KEY_FILE" ]; then
  WEBHOOK_KEY_FILE="${ZUGZUG_DATA_DIR:-/data}/webhook-master.key"
  mkdir -p "$(dirname "$WEBHOOK_KEY_FILE")"
  if [ ! -f "$WEBHOOK_KEY_FILE" ]; then
    head -c 32 /dev/urandom | base64 | tr -d '\n' > "$WEBHOOK_KEY_FILE"
    echo "· generated webhook master key at $WEBHOOK_KEY_FILE"
  fi
  ZUGZUG_WEBHOOK_MASTER_KEY="$(cat "$WEBHOOK_KEY_FILE")"
  export ZUGZUG_WEBHOOK_MASTER_KEY
fi

if [ "$SEED_DEMO" = "true" ]; then
  echo "· bootstrapping (migrations + demo seed)…"
  bun run bootstrap -- --seed
else
  echo "· running migrations…"
  bun run drizzle/migrate.ts
fi

echo "· starting server…"
exec bun run start
