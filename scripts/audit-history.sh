#!/opt/homebrew/bin/bash
# Manual audit of git history for:
#   1. Credentials (via gitleaks)
#   2. BC-internal strings (via grep)
#
# Run before any public push. Does not modify the repo.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PASS=0
FAIL=0

echo "==> Audit: gitleaks (full history)"
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "  ERROR: gitleaks not installed. brew install gitleaks (or download from GitHub releases)" >&2
  exit 3
fi

GL_REPORT="/tmp/zugzug-gitleaks.json"
if gitleaks detect --redact --report-format json --report-path "$GL_REPORT" --no-banner 2>/tmp/zugzug-gitleaks-stderr; then
  echo "  PASS: no credential findings in history"
  PASS=$((PASS+1))
else
  echo "  FAIL: gitleaks found credential candidates"
  echo "  Report: $GL_REPORT"
  echo "  Stderr: /tmp/zugzug-gitleaks-stderr"
  FAIL=$((FAIL+1))
fi

echo ""
echo "==> Audit: project-specific strings (full history)"

# Each pattern is described inline so the script is self-documenting.
declare -A PATTERNS=(
  ["bc_email"]='@bettercollective\.com'
  ["bc_hostname"]='\bbettercollective\.com\b'
  ["bc_name"]='Better Collective'
  ["repo_codename"]='trust-me-bro'
  ["sentry_org_url"]='sentry\.io/[0-9]+'
)

for key in "${!PATTERNS[@]}"; do
  pattern="${PATTERNS[$key]}"
  count=$(git log --all -p --no-color 2>/dev/null | grep -ciE "$pattern" || true)
  if [ "$count" -eq 0 ]; then
    echo "  PASS: $key ($pattern) — zero matches"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $key ($pattern) — $count matches"
    FAIL=$((FAIL+1))
  fi
done

echo ""
echo "============================================"
echo "Audit summary: $PASS pass, $FAIL fail"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "NOTE: During Phase 5, the project-string checks are EXPECTED to fail."
  echo "Phase 6 runs scripts/scrub-history.sh to clean these up, then re-runs"
  echo "this audit and expects a full PASS."
  exit 1
fi

exit 0
