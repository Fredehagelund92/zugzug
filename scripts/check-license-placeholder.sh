***REMOVED***!/usr/bin/env bash
***REMOVED*** Fails if LICENSE still contains the <COPYRIGHT_HOLDER> placeholder.
***REMOVED*** This is a deliberate gate to prevent accidentally publishing the OSS repo
***REMOVED*** before the copyright holder is decided and swapped in.
***REMOVED***
***REMOVED*** Expected to fail during Phase 5. Will start passing pre-Phase-6.

set -euo pipefail

LICENSE_PATH="${1:-LICENSE}"

if [ ! -f "$LICENSE_PATH" ]; then
  echo "ERROR: $LICENSE_PATH does not exist" >&2
  exit 2
fi

if grep -q '<COPYRIGHT_HOLDER>' "$LICENSE_PATH"; then
  echo "WARNING: $LICENSE_PATH still contains <COPYRIGHT_HOLDER> placeholder." >&2
  echo "         This must be swapped to the real holder before the public push." >&2
  echo "         This failure is expected during Phase 5; it gates Phase 6." >&2
  exit 1
fi

echo "OK: $LICENSE_PATH has no placeholder."
exit 0
