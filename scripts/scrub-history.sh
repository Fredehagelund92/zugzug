#!/usr/bin/env bash
# Rewrites git history to replace BC-internal strings per scripts/replacements.txt.
# Uses git-filter-repo (the modern replacement for git-filter-branch).
#
# SAFETY: This script refuses to run against the canonical Fredehagelund92/zugzug
# repo. To run a scrub:
#   1. Clone the repo to a fresh working dir: git clone --mirror <upstream> mirror
#   2. cd mirror
#   3. Invoke this script
#   4. Inspect the result with scripts/audit-history.sh
#   5. Phase 6 only: git push --mirror to the new public destination

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPLACEMENTS="$REPO_ROOT/scripts/replacements.txt"

# === Safety check: refuse to rewrite the live source-of-truth repo ===
ORIGIN_URL=$(git config --get remote.origin.url || echo "")
if [[ "$ORIGIN_URL" == *"Fredehagelund92/zugzug"* ]] && [[ "$ORIGIN_URL" != *"-mirror"* ]]; then
  echo "REFUSING to scrub the live upstream repo." >&2
  echo "remote.origin.url = $ORIGIN_URL" >&2
  echo "" >&2
  echo "To run a scrub safely:" >&2
  echo "  1. Clone to a fresh working dir: git clone --mirror <upstream> zugzug-mirror" >&2
  echo "  2. cd zugzug-mirror" >&2
  echo "  3. Re-invoke this script" >&2
  exit 2
fi

# === Tool check ===
if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "ERROR: git-filter-repo not installed." >&2
  echo "  brew install git-filter-repo  (mac)" >&2
  echo "  pip install git-filter-repo   (cross-platform)" >&2
  exit 3
fi

# === Replacements file ===
if [ ! -f "$REPLACEMENTS" ]; then
  echo "ERROR: $REPLACEMENTS missing" >&2
  exit 4
fi

echo "==> Running git-filter-repo --replace-text $REPLACEMENTS"
git-filter-repo --replace-text "$REPLACEMENTS"

echo ""
echo "==> Rewrite complete. Re-running audit..."
echo ""

if bash "$REPO_ROOT/scripts/audit-history.sh"; then
  echo ""
  echo "SUCCESS: scrub complete, audit clean."
  exit 0
else
  echo ""
  echo "WARNING: audit still reports findings after scrub." >&2
  echo "Inspect the audit output, update replacements.txt, and re-run." >&2
  exit 1
fi
