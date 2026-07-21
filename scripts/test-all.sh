#!/usr/bin/env bash
# Runs the full local check matching CI: typecheck, lint, format, tests for
# both the app and server workspaces. Brings the server test DB up first.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== app =="
( cd app && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test )

echo "== server =="
# Ensure a test database is available. `test:db:up` (docker compose up -d --wait)
# is idempotent for the compose-managed DB; if a DB is already bound to the port
# by other means, that's fine — the test run below is the real gate.
( cd server && bun run test:db:up ) || echo "test DB already available; continuing"
( cd server && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test )

echo "All checks passed."
