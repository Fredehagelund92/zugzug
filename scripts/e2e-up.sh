#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f compose.yml -f compose.e2e.yml up --build -d
for i in $(seq 1 90); do
  if curl -fsS http://localhost:8080/api/health 2>/dev/null | grep -q '"ok":true'; then
    echo "stack healthy"; exit 0
  fi
  sleep 2
done
echo "stack did not become healthy" >&2
docker compose logs --no-color | tail -50
exit 1
