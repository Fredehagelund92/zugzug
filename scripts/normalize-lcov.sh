#!/usr/bin/env bash
# Rewrite lcov SF: paths to repo-root-relative so diff-cover can string-match
# them against the PR's git diff. Usage: normalize-lcov.sh <lcov-file> <workspace>
# where <workspace> is "app" or "server".
#
#   local   : "SF:src/api.ts"                 -> prefix workspace  -> "SF:app/src/api.ts"
#   cross   : "SF:../app/src/lib/palette.ts"  -> strip "../"       -> "SF:app/src/lib/palette.ts"
#
# Idempotent: a path already starting with app/ or server/ is left alone.
# Uses a temp file (not sed -i) so it works with both GNU and BSD sed.
set -euo pipefail
file="$1"; prefix="$2"
tmp="$(mktemp)"
sed -E \
  -e 's#^SF:(\.\./)+#SF:#' \
  -e '/^SF:(app|server)\//! s#^SF:#SF:'"$prefix"'/#' \
  "$file" > "$tmp"
mv "$tmp" "$file"
