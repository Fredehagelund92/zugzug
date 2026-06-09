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

# === Safety check: refuse to rewrite the live source-of-truth working tree ===
#
# A `--mirror` clone is bare (no working tree); that's the safe place to scrub.
# A normal checkout of the source-of-truth is the dangerous place. The origin
# URL alone can't tell them apart (both point at the same upstream), so we
# combine it with `git rev-parse --is-bare-repository`.
ORIGIN_URL=$(git config --get remote.origin.url || echo "")
IS_BARE=$(git rev-parse --is-bare-repository 2>/dev/null || echo "")
if [ "$IS_BARE" != "true" ] && [[ "$ORIGIN_URL" == *"Fredehagelund92/zugzug"* ]]; then
  echo "REFUSING to scrub a non-bare checkout of the upstream repo." >&2
  echo "  remote.origin.url = $ORIGIN_URL" >&2
  echo "  is_bare_repository = $IS_BARE" >&2
  echo "" >&2
  echo "To run a scrub safely:" >&2
  echo "  1. Clone as a bare mirror: git clone --mirror <upstream> zugzug-mirror" >&2
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

# === Validate replacements.txt syntax ===
# git-filter-repo treats every non-empty line in the file as a literal pattern.
# Lines without `==>` are silently mapped to ***REMOVED***. This bit us once when
# a stray `#` line redacted every `#` character in the codebase. Refuse to run
# if any non-empty, non-blank line is missing the `==>` separator.
BAD_LINES=$(grep -nE '.' "$REPLACEMENTS" | grep -vE '==>' || true)
if [ -n "$BAD_LINES" ]; then
  echo "ERROR: $REPLACEMENTS contains lines without '==>' separator:" >&2
  echo "$BAD_LINES" >&2
  echo "" >&2
  echo "git-filter-repo redacts these to '***REMOVED***' silently, which corrupts" >&2
  echo "every match in every blob. Remove the offending lines (move comments" >&2
  echo "to scripts/README.md or a separate doc) before re-running." >&2
  exit 5
fi

echo "==> Running git-filter-repo --replace-text + --replace-message $REPLACEMENTS"
# --replace-text rewrites file content; --replace-message rewrites commit messages.
# Both flags accept the same file format (<find>==><replace> per line).
git-filter-repo --replace-text "$REPLACEMENTS" --replace-message "$REPLACEMENTS"

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
