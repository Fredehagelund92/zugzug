***REMOVED***!/usr/bin/env bash
***REMOVED*** Wraps `license-checker` for one workspace, reading exceptions from
***REMOVED*** licenses.allowlist.json at the repo root.
***REMOVED***
***REMOVED*** Usage: scripts/run-license-check.sh <workspace-dir>
***REMOVED***   e.g. scripts/run-license-check.sh server
***REMOVED***        scripts/run-license-check.sh app

set -euo pipefail

WORKSPACE="${1:-}"
if [ -z "$WORKSPACE" ]; then
  echo "usage: $0 <workspace-dir>" >&2
  exit 2
fi

ALLOWLIST_FILE="$(cd "$(dirname "$0")/.." && pwd)/licenses.allowlist.json"

***REMOVED*** Default accepted license set. Conservative; project-level copyleft excluded.
DEFAULT_ALLOWED="MIT;BSD-2-Clause;BSD-3-Clause;Apache-2.0;ISC;CC-BY-4.0;CC0-1.0;0BSD;Unlicense;Python-2.0;BlueOak-1.0.0"

***REMOVED*** Append additions from the allowlist file (if any).
EXTRA_ALLOWED=""
if [ -f "$ALLOWLIST_FILE" ]; then
  EXTRA_ALLOWED=$(node -e "
    const fs = require('fs');
    const a = JSON.parse(fs.readFileSync('$ALLOWLIST_FILE','utf8'));
    process.stdout.write((a.allowedLicenseAdditions||[]).join(';'));
  ")
fi

ACCEPTED="$DEFAULT_ALLOWED"
if [ -n "$EXTRA_ALLOWED" ]; then
  ACCEPTED="$DEFAULT_ALLOWED;$EXTRA_ALLOWED"
fi

***REMOVED*** Per-package exceptions: build an --excludePackages list from the allowlist.
EXCLUDE_PACKAGES=$(node -e "
  const fs = require('fs');
  const a = JSON.parse(fs.readFileSync('$ALLOWLIST_FILE','utf8'));
  const exc = a.perPackageExceptions || {};
  process.stdout.write(Object.keys(exc).join(';'));
")

cd "$WORKSPACE"

CMD=(npx --yes license-checker --excludePrivatePackages --onlyAllow "$ACCEPTED")
if [ -n "$EXCLUDE_PACKAGES" ]; then
  CMD+=(--excludePackages "$EXCLUDE_PACKAGES")
fi

echo "Running: ${CMD[*]}"
"${CMD[@]}"
