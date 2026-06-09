# Phase 5 — Legal + scrub prep implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the legal documents, license-deny CI gate, history-audit tooling, and dry-runnable history-scrub script so the OSS launch is unblocked except for BC legal sign-off + the public push (both in Phase 6).

**Architecture:** All work is self-contained: docs at repo root, scripts under `scripts/`, CI additions to `.github/workflows/ci.yml`. No production code changes.

**Spec:** `docs/superpowers/specs/2026-06-09-phase5-legal-scrub-prep-design.md`

**Branch:** `phase5-legal-scrub-prep` off main.

**Important style note for agentic workers:** When this plan tells you to "use the canonical text," download the text from the cited source at implementation time. Do NOT paste large bodies of legal text from memory — the canonical source is the source of truth. Always verify the file you create matches what was downloaded.

---

## File structure (post-phase)

```
zugzug/
├── LICENSE                              # MIT, "<COPYRIGHT_HOLDER>" placeholder
├── NOTICE.md                            # Auto-generated dep attribution
├── CONTRIBUTING.md                      # DCO 1.1 + Signed-off-by convention
├── SECURITY.md                          # GHSA-only disclosure flow
├── CODE_OF_CONDUCT.md                   # Contributor Covenant 2.1 by reference
├── licenses.allowlist.json              # Escape hatch for license-checker exceptions
├── .gitleaksignore                      # Known-acceptable matches (test fixtures, etc.)
├── scripts/
│   ├── README.md                        # How to use each script + Phase 6 runbook
│   ├── check-license-placeholder.sh     # CI step; fails until <COPYRIGHT_HOLDER> swapped
│   ├── run-license-check.sh             # Wrapper around license-checker
│   ├── generate-notice.sh               # Regenerates NOTICE.md
│   ├── audit-history.sh                 # gitleaks + project-string grep (manual)
│   ├── scrub-history.sh                 # git-filter-repo (manual; refuses on live repo)
│   └── replacements.txt                 # Exact from===>to mappings for scrub
├── .github/workflows/ci.yml             # Adds license-check + placeholder-check + notice-up-to-date
└── ROADMAP.md                           # Updated: Phase 5 done; Phase 6 blockers listed
```

---

## Verification gate (must all pass at end of phase)

Run from repo root unless noted:

1. All listed files exist and are committed to main.
2. `cd server && npx --yes license-checker --excludePrivatePackages --failOn 'GPL;AGPL;LGPL;SSPL;CC-BY-NC;CC-BY-SA;UNKNOWN'` → exits 0 (after wiring `licenses.allowlist.json` exceptions if needed).
3. `cd app && npx --yes license-checker --excludePrivatePackages --failOn 'GPL;AGPL;LGPL;SSPL;CC-BY-NC;CC-BY-SA;UNKNOWN'` → exits 0.
4. `bash scripts/check-license-placeholder.sh` → exits **1** (expected — LICENSE still contains the placeholder until Phase 6 swap).
5. `bash scripts/generate-notice.sh && git diff --exit-code NOTICE.md` → exits 0 (snapshot is current).
6. `bash scripts/audit-history.sh` runs without internal errors; produces a report; the report lists the expected BC strings (still present in history; scrub hasn't run yet).
7. `bash scripts/scrub-history.sh` against the live repo refuses to run (exits non-zero with safety message).
8. `bash scripts/scrub-history.sh` against a separate clone (manual dry-run) rewrites history and the post-scrub `audit-history.sh` reports zero project-string matches.
9. CI on main shows: `app` job green · `server` job green · `license-check` (app + server) green · `notice-up-to-date` green · `license-placeholder-check` **failing with the expected warn message**.
10. `ROADMAP.md` reflects Phase 5 completion + Phase 6 blockers.

---

## Task 1: Legal documents (LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT)

**Files:**
- Create: `LICENSE`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `CODE_OF_CONDUCT.md`

### Step 1: Create LICENSE

Create `/Users/fhagelund/Documents/GitHub/zugzug/LICENSE` with the standard MIT license text. Download the canonical template from <https://opensource.org/license/mit/> (or copy from any reliable MIT reference such as an existing well-known OSS project's LICENSE file). Use this header line:

```
MIT License

Copyright (c) 2026 <COPYRIGHT_HOLDER>
```

The rest of the file is the standard MIT body ("Permission is hereby granted..."). `<COPYRIGHT_HOLDER>` is a **deliberate placeholder** — Task 2's CI gate will keep it from being missed before the public push.

After writing the file, verify with `grep "<COPYRIGHT_HOLDER>" LICENSE` returns one match.

### Step 2: Create CONTRIBUTING.md

The file's structure:

```markdown
# Contributing to Zugzug

Thanks for your interest in contributing! This project uses the
[Developer Certificate of Origin (DCO)](https://developercertificate.org/)
to manage contributions.

## DCO sign-off

Every commit must include a `Signed-off-by:` line that certifies you
wrote the code or have the right to contribute it under the project's
license:

    Signed-off-by: Your Name <your.email@example.com>

Add it automatically with:

    git commit -s -m "your message"

The full DCO 1.1 text is available at <https://developercertificate.org/>.

## Filing issues

Use GitHub Issues. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment (OS, Bun version, Postgres version)

For security issues, please follow the disclosure flow in [SECURITY.md](./SECURITY.md) instead.

## Filing pull requests

1. Open an issue first if the change is substantial — saves rework
2. Fork the repo and create a topic branch
3. Make your changes; add tests
4. Sign your commits (`git commit -s`)
5. Run `bun run typecheck && bun run lint && bun run format:check && bun run test` in both `server/` and `app/` workspaces
6. Open the PR

## Development setup

See the [README](./README.md) for getting started.

## Code of conduct

This project follows the [Contributor Covenant v2.1](./CODE_OF_CONDUCT.md).
```

Write the file at `/Users/fhagelund/Documents/GitHub/zugzug/CONTRIBUTING.md` with the content above verbatim.

### Step 3: Create SECURITY.md

```markdown
# Security policy

## Reporting vulnerabilities

Report security issues via [GitHub Security Advisories](https://github.com/Fredehagelund92/zugzug/security/advisories/new) using GitHub's private disclosure flow.

**Do not file a public issue for security reports.**

When you submit an advisory, we'll:
- Acknowledge receipt within 5 business days
- Investigate and provide a status update within 30 days
- Issue a CVE if the issue qualifies
- Credit you in the advisory (unless you prefer to remain anonymous)
- Aim to disclose publicly within 90 days

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Out of scope

- Issues that require physical access to the user's machine
- Self-hosted deployments with non-default authentication disabled
- Dependencies with known issues we've documented as accepted risk in `NOTICE.md`
```

Write at `/Users/fhagelund/Documents/GitHub/zugzug/SECURITY.md`.

The repo URL in the advisory link assumes the current `Fredehagelund92/zugzug` location. Phase 6 may rename — if so, that URL gets updated then. For now, this is correct.

### Step 4: Create CODE_OF_CONDUCT.md

Use the by-reference pattern — short file that points to the canonical Contributor Covenant v2.1 hosted by the Contributor Covenant project. Do NOT inline the full text (a) to avoid drift if the covenant updates and (b) to keep this file short. Most major OSS projects adopt this pattern.

```markdown
# Code of conduct

This project adopts the **Contributor Covenant v2.1** without modification.

Read the full text: <https://www.contributor-covenant.org/version/2/1/code_of_conduct/>

## Reporting concerns

If you experience or witness conduct that violates the Code of Conduct, report it via [GitHub Security Advisories](https://github.com/Fredehagelund92/zugzug/security/advisories/new). Mark the advisory title with the prefix `[CoC]` so we can triage appropriately.

Reports are handled confidentially. We aim to acknowledge within 5 business days.

## Enforcement

Project maintainers may take any action they deem appropriate, up to and including permanent bans, in response to violations.
```

Write at `/Users/fhagelund/Documents/GitHub/zugzug/CODE_OF_CONDUCT.md`.

### Step 5: Verify + commit

- [ ] Run: `ls -la LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md`
- [ ] Confirm: `grep -c "<COPYRIGHT_HOLDER>" LICENSE` returns `1`
- [ ] Commit:

```bash
git add LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md
git commit -m "docs: legal — LICENSE (MIT, placeholder), CONTRIBUTING (DCO), SECURITY (GHSA), CoC"
```

---

## Task 2: Placeholder safety check script + CI step

**Files:**
- Create: `scripts/check-license-placeholder.sh`
- Modify: `.github/workflows/ci.yml`

### Step 1: Create the script

`/Users/fhagelund/Documents/GitHub/zugzug/scripts/check-license-placeholder.sh`:

```bash
#!/usr/bin/env bash
# Fails if LICENSE still contains the <COPYRIGHT_HOLDER> placeholder.
# This is a deliberate gate to prevent accidentally publishing the OSS repo
# before the copyright holder is decided and swapped in.
#
# Expected to fail during Phase 5. Will start passing pre-Phase-6.

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
```

Make it executable:
```bash
chmod +x scripts/check-license-placeholder.sh
```

### Step 2: Add CI step

In `.github/workflows/ci.yml`, add a new job at the bottom (after the `server:` job). It runs unconditionally and is expected to fail during Phase 5:

```yaml
  license-placeholder-check:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - name: Check LICENSE placeholder
        run: bash scripts/check-license-placeholder.sh
```

The `continue-on-error: true` means the OVERALL workflow status stays green even when this job fails — the failure is informational. The job's red mark in the GitHub Checks UI is the visible signal that the placeholder is still in place.

### Step 3: Verify locally

- [ ] Run: `bash scripts/check-license-placeholder.sh` → exits 1 with the warning message (expected).
- [ ] Run: `bash scripts/check-license-placeholder.sh /dev/null` → exits 2 (file-not-found case).

### Step 4: Commit

```bash
git add scripts/check-license-placeholder.sh .github/workflows/ci.yml
git commit -m "ci: license placeholder gate (intentionally failing until Phase 6 swap)"
```

---

## Task 3: license-checker CI gate per workspace

**Files:**
- Create: `licenses.allowlist.json`
- Create: `scripts/run-license-check.sh`
- Modify: `.github/workflows/ci.yml`

### Step 1: Probe the actual dep license situation

Before wiring CI, find out what licenses are actually present in both workspaces. This step shows us whether `licenses.allowlist.json` will need entries.

- [ ] Run from repo root:
  ```bash
  cd server && npx --yes license-checker --summary && cd ..
  cd app && npx --yes license-checker --summary && cd ..
  ```
- [ ] Note any licenses that fall outside `MIT;BSD-2-Clause;BSD-3-Clause;Apache-2.0;ISC;CC-BY-4.0;CC0-1.0;0BSD;Unlicense;Python-2.0;BlueOak-1.0.0`. Common ones to expect: `MPL-2.0` (Mozilla — okay to allow; copyleft scope is file-level only, not project-level), `(Apache-2.0 OR MIT)` style dual-license declarations.
- [ ] Note any `UNKNOWN` license entries — those are deps with missing metadata.

This step's output drives the allowlist content in Step 2.

### Step 2: Create the allowlist file

`/Users/fhagelund/Documents/GitHub/zugzug/licenses.allowlist.json`:

```json
{
  "$schema": "Curated list of license exceptions. Each entry needs a rationale.",
  "allowedLicenseAdditions": [],
  "perPackageExceptions": {}
}
```

Where:
- `allowedLicenseAdditions` is a string array of license identifiers to add to the default allowlist (e.g., `"MPL-2.0"` if Step 1 surfaced MPL deps we accept).
- `perPackageExceptions` maps `package-name@version` to `{license, rationale, added}` for one-off acceptances (typically for `UNKNOWN` deps where upstream confirmed the actual license in their README).

If Step 1 surfaced `MPL-2.0` deps, add `"MPL-2.0"` to the `allowedLicenseAdditions` array. If Step 1 surfaced `UNKNOWN` deps, add each one to `perPackageExceptions` with a brief rationale.

If neither happens (everything is in the default allowlist), the file stays empty — but commit it anyway so the schema is documented for future contributors.

### Step 3: Create the wrapper script

`/Users/fhagelund/Documents/GitHub/zugzug/scripts/run-license-check.sh`:

```bash
#!/usr/bin/env bash
# Wraps `license-checker` for one workspace, reading exceptions from
# licenses.allowlist.json at the repo root.
#
# Usage: scripts/run-license-check.sh <workspace-dir>
#   e.g. scripts/run-license-check.sh server
#        scripts/run-license-check.sh app

set -euo pipefail

WORKSPACE="${1:-}"
if [ -z "$WORKSPACE" ]; then
  echo "usage: $0 <workspace-dir>" >&2
  exit 2
fi

ALLOWLIST_FILE="$(cd "$(dirname "$0")/.." && pwd)/licenses.allowlist.json"

# Default accepted license set. Conservative; project-level copyleft excluded.
DEFAULT_ALLOWED="MIT;BSD-2-Clause;BSD-3-Clause;Apache-2.0;ISC;CC-BY-4.0;CC0-1.0;0BSD;Unlicense;Python-2.0;BlueOak-1.0.0"

# Append additions from the allowlist file (if any).
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

# Per-package exceptions: build an --excludePackages list from the allowlist.
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
```

Make executable:
```bash
chmod +x scripts/run-license-check.sh
```

Note: this uses `--onlyAllow` (a deny-by-default whitelist) rather than `--failOn` (a blacklist). `--onlyAllow` is safer — any new license that appears (e.g. when a transitive dep changes) fails closed instead of silently passing.

### Step 4: Verify locally

- [ ] Run: `bash scripts/run-license-check.sh server` → exits 0.
- [ ] Run: `bash scripts/run-license-check.sh app` → exits 0.
- [ ] If either fails, iterate on `licenses.allowlist.json` until both pass. Each new addition must include a rationale comment in the JSON's `perPackageExceptions` or be justifiable as a generic license-family acceptance in `allowedLicenseAdditions`.

### Step 5: Add CI steps

In `.github/workflows/ci.yml`, add a `license-check` step to BOTH the `app` and `server` jobs, right after the existing `bun run test` step:

For the `app:` job:
```yaml
      - name: License check (app deps)
        run: bash ../scripts/run-license-check.sh app
        working-directory: .
```

Wait — `defaults.run.working-directory` is set to `app`, so the cd happens automatically. The wrapper script needs to know the absolute path. Adjust:

```yaml
      - name: License check (app deps)
        run: |
          cd "$GITHUB_WORKSPACE"
          bash scripts/run-license-check.sh app
```

For the `server:` job, same pattern:
```yaml
      - name: License check (server deps)
        run: |
          cd "$GITHUB_WORKSPACE"
          bash scripts/run-license-check.sh server
```

### Step 6: Commit

```bash
git add licenses.allowlist.json scripts/run-license-check.sh .github/workflows/ci.yml
git commit -m "ci: license-checker deny-list (GPL/AGPL/LGPL/SSPL + fail-on-UNKNOWN)"
```

---

## Task 4: NOTICE.md generator + initial snapshot + CI check

**Files:**
- Create: `scripts/generate-notice.sh`
- Create: `NOTICE.md`
- Modify: `.github/workflows/ci.yml`

### Step 1: Create the generator

`/Users/fhagelund/Documents/GitHub/zugzug/scripts/generate-notice.sh`:

```bash
#!/usr/bin/env bash
# Regenerates NOTICE.md by listing all direct + transitive deps in both
# workspaces with their license. Commit the resulting NOTICE.md alongside
# code changes so it stays in sync.

set -euo pipefail

OUTPUT="${1:-NOTICE.md}"

generate_section() {
  local workspace="$1"
  echo "## $workspace dependencies"
  echo ""
  echo "| Package | Version | License |"
  echo "|---------|---------|---------|"
  (cd "$workspace" && npx --yes license-checker --json --production --excludePrivatePackages) \
    | node -e "
      const data = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const rows = Object.entries(data)
        .map(([k,v]) => {
          const m = k.match(/^(.+)@([^@]+)$/);
          return { name: m[1], version: m[2], license: v.licenses };
        })
        .sort((a,b) => a.name.localeCompare(b.name));
      for (const r of rows) {
        const lic = Array.isArray(r.license) ? r.license.join(' OR ') : (r.license || 'UNKNOWN');
        process.stdout.write(\`| \${r.name} | \${r.version} | \${lic} |\n\`);
      }
    "
  echo ""
}

{
  echo "# NOTICE"
  echo ""
  echo "This file lists third-party dependencies bundled or referenced by Zugzug."
  echo "Auto-generated by \`scripts/generate-notice.sh\`. Do not edit by hand."
  echo ""
  echo "Generated: $(date -u +'%Y-%m-%d')"
  echo ""
  generate_section "server"
  generate_section "app"
} > "$OUTPUT"

echo "Wrote $OUTPUT"
```

Make executable:
```bash
chmod +x scripts/generate-notice.sh
```

### Step 2: Generate the initial NOTICE.md

- [ ] Run: `bash scripts/generate-notice.sh`
- [ ] Inspect: `head -30 NOTICE.md` — confirm it has the markdown table headers and at least the top few rows for each workspace.

The file will likely be a few hundred lines (transitive deps add up). That's fine — it's machine-generated and inspected only by license auditors.

### Step 3: Add CI check that NOTICE.md stays current

In `.github/workflows/ci.yml`, add a new job:

```yaml
  notice-up-to-date:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Install deps (server)
        working-directory: server
        run: bun install --frozen-lockfile
      - name: Install deps (app)
        working-directory: app
        run: bun install --frozen-lockfile
      - name: Regenerate NOTICE.md
        run: bash scripts/generate-notice.sh
      - name: Check NOTICE.md is current
        run: git diff --exit-code NOTICE.md
```

If a contributor adds a dep without regenerating, this job fails with a clear diff.

### Step 4: Verify locally

- [ ] Run: `bash scripts/generate-notice.sh && git diff --exit-code NOTICE.md` → exits 0 (just generated, so no diff).

### Step 5: Commit

```bash
git add scripts/generate-notice.sh NOTICE.md .github/workflows/ci.yml
git commit -m "ci: NOTICE.md generator + drift check"
```

---

## Task 5: History audit (gitleaks + project-string grep)

**Files:**
- Create: `scripts/audit-history.sh`
- Create: `.gitleaksignore`

### Step 1: Install gitleaks for local invocation

The script delegates to gitleaks; users running it locally need it installed. Recommend Homebrew (mac) or GitHub releases. Document in the script's preamble.

No project-level dep changes — gitleaks runs as an external tool.

### Step 2: Create `.gitleaksignore`

`/Users/fhagelund/Documents/GitHub/zugzug/.gitleaksignore`:

```
# .gitleaksignore — one fingerprint per line. Each fingerprint allow-lists
# a specific finding by its <commit-sha>:<path>:<rule-id>:<line-number> shape.
#
# Add a comment above each entry explaining why it's safe to ignore.
# Format: lines starting with # are comments.
#
# Test fixtures with intentionally-fake tokens should be the only entries
# here. Real leaked credentials must be revoked + rewritten, not ignored.
```

Start empty. Step 5 may add entries after the first audit run surfaces false positives.

### Step 3: Create the audit script

`/Users/fhagelund/Documents/GitHub/zugzug/scripts/audit-history.sh`:

```bash
#!/usr/bin/env bash
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
```

Make executable:
```bash
chmod +x scripts/audit-history.sh
```

### Step 4: Run the audit

- [ ] Confirm gitleaks is installed: `gitleaks version`
- [ ] Run: `bash scripts/audit-history.sh`
- [ ] Read the output. Expected:
  - gitleaks: PASS (we expect no real credentials in history; if it fails, see Step 5)
  - bc_email: FAIL (the recon in the spec confirmed several matches)
  - bc_hostname: probably FAIL (URL normalisation test data)
  - bc_name: probably FAIL (UI copy from earlier phases)
  - repo_codename: depends — check if `trust-me-bro` appears in history beyond CLAUDE.md
  - sentry_org_url: probably PASS (the Sentry DSN is env-injected, not committed)

Per Phase 5's gate, the project-string failures are EXPECTED. The script's exit code being non-zero is OK at this stage.

### Step 5: Handle gitleaks findings (if any)

If gitleaks reports a credential finding:
- Read `/tmp/zugzug-gitleaks.json`
- For each finding:
  - If it's a **real credential**: revoke it externally (rotate the key) AND mark for scrub in Phase 6 (add to `scripts/replacements.txt` or `scripts/paths-to-delete.txt`).
  - If it's a **false positive** (test fixture, example string, intentionally-fake token): add its fingerprint to `.gitleaksignore` with a comment explaining why.
- Re-run `bash scripts/audit-history.sh`. gitleaks should now PASS.

The fingerprint format is `<commit-sha>:<path>:<rule-id>:<line-number>` — gitleaks prints it in the JSON report.

### Step 6: Commit

```bash
git add scripts/audit-history.sh .gitleaksignore
git commit -m "audit: gitleaks + project-string history audit script"
```

---

## Task 6: Scrub script + replacements.txt + scripts/README

**Files:**
- Create: `scripts/scrub-history.sh`
- Create: `scripts/replacements.txt`
- Create: `scripts/README.md`

### Step 1: Create replacements.txt

`/Users/fhagelund/Documents/GitHub/zugzug/scripts/replacements.txt`:

```
# git-filter-repo --replace-text format: one pattern per line.
# Syntax: <find>==><replace>
# Lines starting with # are comments.
#
# These mappings rewrite BC-internal strings to generic equivalents.
# Adjust before Phase 6 if specific strings need different replacements.

@bettercollective.com==>@example.com
bettercollective.com==>example.com
Better Collective==>Zugzug
trust-me-bro==>zugzug
```

Note the order: more-specific patterns first (`@bettercollective.com` before `bettercollective.com`) so the email-shaped form gets the email-shaped replacement.

The Sentry org URL pattern isn't here yet — Step 5 of Task 5's audit may surface specific URLs to add. If so, append entries like `sentry.io/1234567==>sentry.io/PROJECT_ID` per finding.

### Step 2: Create the scrub script

`/Users/fhagelund/Documents/GitHub/zugzug/scripts/scrub-history.sh`:

```bash
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
```

Make executable:
```bash
chmod +x scripts/scrub-history.sh
```

### Step 3: Verify the safety check works

- [ ] Run from the live repo: `bash scripts/scrub-history.sh`
- [ ] Confirm it exits 2 with the "REFUSING" message.

### Step 4: Create scripts/README.md

`/Users/fhagelund/Documents/GitHub/zugzug/scripts/README.md`:

```markdown
# scripts/

Operational scripts for Phase 5/6 OSS launch readiness.

## Per-script reference

| Script | When to run | What it does |
|---|---|---|
| `check-license-placeholder.sh` | CI (auto) | Fails if `<COPYRIGHT_HOLDER>` is still in LICENSE. Intentionally failing during Phase 5. |
| `run-license-check.sh <workspace>` | CI (auto) + ad-hoc | Runs license-checker against the named workspace with the deny-list + allowlist exceptions. |
| `generate-notice.sh` | When deps change | Regenerates NOTICE.md from license-checker output. CI fails if NOTICE.md drifts. |
| `audit-history.sh` | Pre-Phase-6 (manual) | Runs gitleaks + greps for BC-internal strings. Reports findings. |
| `scrub-history.sh` | Phase 6 only (manual, against mirror clone) | Rewrites history using `git-filter-repo`. Refuses to run against the upstream repo. |

## Phase 6 runbook

When BC legal signs off and we're ready for the public push:

```bash
# 1. Clone the repo as a bare mirror to a fresh working dir
git clone --mirror https://github.com/Fredehagelund92/zugzug zugzug-mirror
cd zugzug-mirror

# 2. Run the scrub (rewrites history per scripts/replacements.txt + re-audits)
../zugzug/scripts/scrub-history.sh

# 3. Verify the audit passes cleanly
../zugzug/scripts/audit-history.sh

# 4. Update LICENSE: swap <COPYRIGHT_HOLDER> for the real value
sed -i.bak 's/<COPYRIGHT_HOLDER>/<actual-holder>/' LICENSE

# 5. Confirm placeholder check passes
bash ../zugzug/scripts/check-license-placeholder.sh

# 6. Point at the new public remote and force-push
git remote set-url origin <PUBLIC_REPO_URL>
git push --mirror

# 7. Tag v1.0.0 on the new public repo
cd ../<new-public-clone>
git tag v1.0.0
git push origin v1.0.0
```
```

### Step 5: Commit

```bash
git add scripts/scrub-history.sh scripts/replacements.txt scripts/README.md
git commit -m "scrub: dry-runnable git-filter-repo + Phase 6 runbook"
```

---

## Task 7: Dry-run the scrub against a mirror clone (verification)

This task produces no committed artifacts — it verifies the scrub script works end-to-end.

### Step 1: Create the mirror clone

In a temporary working dir (outside the project):

- [ ] Run:
  ```bash
  TMPDIR=$(mktemp -d)
  cd "$TMPDIR"
  git clone --mirror https://github.com/Fredehagelund92/zugzug zugzug-mirror
  cd zugzug-mirror
  ```

### Step 2: Run the scrub

- [ ] Run: `bash /Users/fhagelund/Documents/GitHub/zugzug/scripts/scrub-history.sh`

Expected:
- git-filter-repo runs without errors
- Re-audit prints `PASS` for all five project-string patterns
- Script exits 0

### Step 3: Sanity-check the rewrite

- [ ] Run:
  ```bash
  git log --all -p --no-color | grep -iE '@bettercollective\.com|trust-me-bro' | head -5
  ```
- [ ] Confirm zero matches.

### Step 4: Clean up

- [ ] Run: `rm -rf "$TMPDIR"`

No commit — this is a verification-only task. If the dry-run surfaces a problem (e.g., a replacement pattern that didn't catch something, or audit still failing), iterate on `scripts/replacements.txt` on the main branch and re-run.

---

## Task 8: ROADMAP update

**Files:**
- Modify: `ROADMAP.md`

### Step 1: Read the current state

- [ ] Run: `head -50 ROADMAP.md` to see the current section structure.

### Step 2: Update the OSS-pivot section

Find the existing Phase 5 entry. Update it to reflect completion. Find the Phase 6 entry and expand its blockers section.

Example diff (adjust to actual file structure):

```markdown
- ### Phase 5 — Legal + scrub (~week 11)
- BC legal written sign-off on IP assignment + MIT release. `git-filter-repo` pass against full history (tokens, hostnames, customer names, `trust-me-bro` substrings). LICENSE (MIT) + NOTICE + CONTRIBUTING.md (DCO) + SECURITY.md drafted. GitHub repo rename. `license-checker` in CI with deny-list for GPL/AGPL/SSPL.
+ ### Phase 5 — Legal + scrub prep (DONE 2026-06-09)
+ Shipped: LICENSE (MIT with `<COPYRIGHT_HOLDER>` placeholder), NOTICE.md (auto-generated), CONTRIBUTING.md (DCO), SECURITY.md (GHSA), CODE_OF_CONDUCT.md (Contributor Covenant 2.1), license-checker CI per workspace (deny GPL/AGPL/LGPL/SSPL + UNKNOWN), `scripts/audit-history.sh` (gitleaks + project-string grep), `scripts/scrub-history.sh` (dry-runnable git-filter-repo with safety refusal against live repo). See `docs/superpowers/specs/2026-06-09-phase5-legal-scrub-prep-design.md`.

+ **Blocked on Phase 6:** actual scrub execution, `<COPYRIGHT_HOLDER>` swap, public repo creation, force-push, v1.0.0 tag.
```

And for Phase 6:

```markdown
- ### Phase 6 — Public push + v1.0 (~week 12)
- Force-push scrubbed history to fresh public repo. Tag `v1.0.0`. Launch post...
+ ### Phase 6 — Public push + v1.0 (BLOCKED — awaiting BC legal)
+
+ **Pre-flight checklist** (resolve before Phase 6 starts):
+ - [ ] BC legal sign-off on IP assignment + MIT release (written)
+ - [ ] Decision: copyright holder — `Better Collective A/S and contributors` vs `Frederik Hagelund and contributors` vs both
+ - [ ] Decision: public GitHub destination — `Fredehagelund92/zugzug` vs new org
+ - [ ] Confirmation: `trust-me-bro` rewrite scope (CLAUDE.md, internal-process docs)
+ - [ ] Specific Sentry org URL to scrub (if any)
+
+ **Runbook:** `scripts/README.md` — clone mirror, run scrub, swap `<COPYRIGHT_HOLDER>`, point at public remote, force-push, tag v1.0.0.
+
+ **Launch post:** HN, dbt Slack, r/dataengineering — locked positioning. Issue templates for "add adapter for X."
```

### Step 3: Commit

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): Phase 5 done; Phase 6 blockers + runbook pointer"
```

---

## Task 9: Verification gate run

This task is the final pass-or-iterate before shipping the PR.

### Step 1: Run every gate item

Execute each item from the "Verification gate" section at the top of this plan.

- [ ] Gate 1: `ls LICENSE NOTICE.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md licenses.allowlist.json .gitleaksignore` — all exist.
- [ ] Gate 2: `bash scripts/run-license-check.sh server` exits 0.
- [ ] Gate 3: `bash scripts/run-license-check.sh app` exits 0.
- [ ] Gate 4: `bash scripts/check-license-placeholder.sh` exits 1 (with the expected warning).
- [ ] Gate 5: `bash scripts/generate-notice.sh && git diff --exit-code NOTICE.md` exits 0.
- [ ] Gate 6: `bash scripts/audit-history.sh` runs without internal errors; lists the expected BC strings as findings.
- [ ] Gate 7: `bash scripts/scrub-history.sh` (from the live repo) exits 2 with the safety message.
- [ ] Gate 8: Dry-run scrub against a mirror clone (Task 7) → audit reports zero matches post-scrub.

### Step 2: Push the branch + open PR

- [ ] Push: `git push -u origin phase5-legal-scrub-prep`
- [ ] Open PR with body covering: deliverables, expected CI state (one job intentionally failing), the Phase 6 blocker checklist, plan + spec links.

### Step 3: Verify CI on the PR

- [ ] Check the GitHub Actions tab. Expected:
  - `app` job: green (license-check step added, passing)
  - `server` job: green (license-check step added, passing)
  - `notice-up-to-date`: green
  - `license-placeholder-check`: red with the expected warning (this is fine — `continue-on-error: true` keeps the workflow green overall)

If any unexpected failure: triage and fix on the branch before requesting review.

---

## Self-review summary

**Spec coverage** matrix:

| Spec deliverable | Tasks |
|---|---|
| LICENSE (MIT + placeholder) | Task 1 ✓ |
| CONTRIBUTING (DCO) | Task 1 ✓ |
| SECURITY (GHSA) | Task 1 ✓ |
| CODE_OF_CONDUCT (CoC 2.1 by reference) | Task 1 ✓ |
| NOTICE (auto-generated) | Task 4 ✓ |
| Placeholder safety CI gate | Task 2 ✓ |
| license-checker per workspace | Task 3 ✓ |
| `licenses.allowlist.json` escape hatch | Task 3 ✓ |
| `scripts/audit-history.sh` (gitleaks + grep) | Task 5 ✓ |
| `.gitleaksignore` | Task 5 ✓ |
| `scripts/scrub-history.sh` (refuse on live repo) | Task 6 ✓ |
| `scripts/replacements.txt` | Task 6 ✓ |
| `scripts/README.md` (Phase 6 runbook) | Task 6 ✓ |
| Dry-run verification | Task 7 ✓ |
| ROADMAP update | Task 8 ✓ |
| Full gate | Task 9 ✓ |

**Placeholder scan:** no TBDs in tasks themselves. `<COPYRIGHT_HOLDER>` is intentional, documented as such.

**Type/path consistency:** all file paths use absolute or repo-relative form; script names consistent across tasks; CI job names match across Task 2/3/4/9.

**Risks worth flagging:**

- **Step 1 of Task 3 (`license-checker --summary`) may surface unexpected licenses** in transitive deps. If it does, the implementer needs to make a real call (allowlist with rationale, or replace the dep). Plan budgets time for this iteration; if it escalates beyond a few entries, escalate to the user.

- **Step 4 of Task 5 will find BC strings in history** — this is expected during Phase 5 and the audit script makes this explicit in its output. Don't "fix" the failure by removing patterns from the audit; that defeats the gate.

- **`continue-on-error: true` on the placeholder check job** means the overall CI status stays green. Some teams prefer to see workflow-level red as a wake-up signal. If you (controller) want the alternative — let the workflow go red but document it loudly in PR templates — say so; the swap is a one-line change.

- **The scrub dry-run (Task 7) clones the upstream repo** — this is read-only against upstream but the local mirror clone is a full copy of history. Make sure you run it in `mktemp -d`, not your normal working dir, and clean up afterward.
