#!/usr/bin/env sh
set -e
echo "· running migrations…"
bun run drizzle/migrate.ts
echo "· starting server…"
exec bun run start
