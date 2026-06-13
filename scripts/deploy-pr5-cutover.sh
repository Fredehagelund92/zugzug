#!/usr/bin/env bash
# deploy-pr5-cutover.sh — orchestrate the multi-tenant PR5 cutover deploy.
#
# Reads DATABASE_URL from environment (or first arg) and runs migrations 0014-0017
# in order with safety checks. Idempotent: re-running after a partial apply picks
# up where it left off via drizzle's __drizzle_migrations journal.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:port/db ./scripts/deploy-pr5-cutover.sh
#   ./scripts/deploy-pr5-cutover.sh postgres://user:pass@host:port/db
#
# Flags:
#   --skip-backfill-check   Skip the pre-flight check (NOT recommended)
#   --dry-run               Print what would happen, run nothing destructive

set -euo pipefail

DB_URL="${DATABASE_URL:-${1:-}}"
SKIP_BACKFILL_CHECK=0
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --skip-backfill-check) SKIP_BACKFILL_CHECK=1 ;;
    --dry-run)             DRY_RUN=1 ;;
    postgres://*|postgresql://*) DB_URL="$arg" ;;
  esac
done

if [ -z "$DB_URL" ]; then
  echo "error: DATABASE_URL not set and no URL argument provided" >&2
  echo "usage: DATABASE_URL=postgres://... $0" >&2
  exit 2
fi

# Don't echo the password back at the user.
DB_HOST=$(echo "$DB_URL" | sed -E 's|.*@([^/:]+).*|\1|')
echo "▸ Target: ${DB_HOST}"
echo

# Sanity: this script lives in scripts/, server lives in ../server. Resolve repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/server"

if [ ! -d "$SERVER_DIR/drizzle/migrations" ]; then
  echo "error: $SERVER_DIR/drizzle/migrations not found — wrong working dir?" >&2
  exit 2
fi

run_psql() {
  PGPASSWORD="" psql "$DB_URL" -X --quiet --no-psqlrc --tuples-only --no-align "$@"
}

step() { echo; echo "━━ $1 ━━"; }

###############################################################################
step "1/6  Pre-flight: connection check"
###############################################################################
if ! run_psql -c "SELECT 1" > /dev/null 2>&1; then
  echo "error: cannot connect to ${DB_HOST}" >&2
  exit 1
fi
echo "ok"

###############################################################################
step "2/6  Pre-flight: tenant_member backfill check"
###############################################################################
# Any user without a default-tenant membership will lose access when 0016
# drops users.role. The spec PR1 migration backfilled all existing users —
# this check confirms that's still true and any users created since are also
# covered. Expected: 0.
if [ "$SKIP_BACKFILL_CHECK" = "1" ]; then
  echo "skipped (--skip-backfill-check)"
else
  ORPHANS=$(run_psql -c "
    SELECT COUNT(*)
      FROM zugzug_app.users u
     WHERE NOT EXISTS (
       SELECT 1 FROM zugzug_app.tenant_member tm
        WHERE tm.user_id = u.id AND tm.tenant_id = 'default'
     );
  " | tr -d '[:space:]')

  if [ "$ORPHANS" != "0" ]; then
    echo "error: $ORPHANS user(s) lack default-tenant membership." >&2
    echo "       Backfill before applying 0016, e.g.:" >&2
    echo "         INSERT INTO zugzug_app.tenant_member (tenant_id, user_id, role, created_at)" >&2
    echo "         SELECT 'default', id, COALESCE(role, 'editor'), now() FROM zugzug_app.users" >&2
    echo "         ON CONFLICT (tenant_id, user_id) DO NOTHING;" >&2
    echo "       Then re-run this script." >&2
    exit 1
  fi
  echo "ok ($ORPHANS users without default membership)"
fi

###############################################################################
step "3/6  Show currently applied migrations"
###############################################################################
LATEST=$(run_psql -c "SELECT MAX(id) FROM drizzle.__drizzle_migrations" 2>/dev/null | tr -d '[:space:]')
echo "drizzle journal head: $LATEST"

REPO_LATEST=$(ls "$SERVER_DIR/drizzle/migrations" | grep -E '^[0-9]{4}_' | sort | tail -1 | cut -d_ -f1)
echo "repo migrations head: $REPO_LATEST"

###############################################################################
step "4/6  Apply migrations 0014..0017"
###############################################################################
if [ "$DRY_RUN" = "1" ]; then
  echo "(dry-run) would run: cd $SERVER_DIR && DATABASE_URL=... bun run db:migrate"
else
  cd "$SERVER_DIR"
  DATABASE_URL="$DB_URL" bun run db:migrate
fi

###############################################################################
step "5/6  Verify post-cutover state"
###############################################################################
# Sanity-check that the schema is in the expected state. Each assertion exits
# non-zero on failure so a botched migration fails the deploy.

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" != "$expected" ]; then
    echo "FAIL  $label: expected $expected, got $actual" >&2
    exit 1
  fi
  echo "  ok  $label = $actual"
}

# users.role column should be gone
ROLE_COL=$(run_psql -c "
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema='zugzug_app' AND table_name='users' AND column_name='role';
" | tr -d '[:space:]')
assert_eq "users.role dropped" "0" "$ROLE_COL"

# allowed_emails table should be gone
ALLOWED_EMAILS=$(run_psql -c "
  SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema='zugzug_app' AND table_name='allowed_emails';
" | tr -d '[:space:]')
assert_eq "allowed_emails dropped" "0" "$ALLOWED_EMAILS"

# 11 scoped tables should have RLS enabled
RLS_COUNT=$(run_psql -c "
  SELECT COUNT(*) FROM pg_tables
   WHERE schemaname='zugzug_app' AND rowsecurity=true;
" | tr -d '[:space:]')
assert_eq "tables with RLS enabled" "11" "$RLS_COUNT"

# 11 tenant_iso policies should exist
POLICY_COUNT=$(run_psql -c "
  SELECT COUNT(*) FROM pg_policies
   WHERE schemaname='zugzug_app' AND policyname='tenant_iso';
" | tr -d '[:space:]')
assert_eq "tenant_iso policies"    "11" "$POLICY_COUNT"

# tenant_id NOT NULL on the canonical scoped table
DIM_NULLABLE=$(run_psql -c "
  SELECT is_nullable FROM information_schema.columns
   WHERE table_schema='zugzug_app' AND table_name='dimension' AND column_name='tenant_id';
" | tr -d '[:space:]')
assert_eq "dimension.tenant_id NOT NULL" "NO" "$DIM_NULLABLE"

###############################################################################
step "6/6  Cutover complete"
###############################################################################
cat <<EOF

  Schema cutover applied. Code deploy can proceed.

  NEXT STEPS (manual):
    1. Deploy the new server + client code.
    2. Smoke-test: sign in (uses tenant_member-based gate now), open a
       workspace, edit a draft, hit the admin console.
    3. Watch logs for any 'unrecognized configuration parameter "app.tenant_id"'
       errors. If any appear, the BYPASSRLS grace window is masking a code path
       that bypassed pgTxScoped — find and fix before revoking BYPASSRLS.
    4. After ~24h of clean prod operation, revoke BYPASSRLS on the app role:

         psql "\$DATABASE_URL" -c "ALTER ROLE zugzug NOBYPASSRLS;"

       (Replace 'zugzug' with the actual app role name in your env.)

  Rollback note: this cutover is roll-forward only. Recovery requires a
  forward migration that re-adds users.role / allowed_emails — not a git revert.

EOF
