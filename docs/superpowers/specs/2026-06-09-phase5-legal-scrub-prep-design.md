# Phase 5 — Legal + scrub prep (design)

**Date:** 2026-06-09
**Parent spec:** `docs/superpowers/specs/2026-06-08-oss-pivot-design.md` (Phase 5 section)
**Status:** Locked. Ready for implementation plan.

---

## Goal

Ship everything that needs to be in place before the OSS launch — legal documents, CI deny-list, history-audit tooling, and a dry-runnable history-scrub script — without executing the scrub or touching the public repo. The public push (force-push to fresh repo, v1.0.0 tag, launch posts) stays in Phase 6 and is blocked on BC legal sign-off.

Two pieces of information remain open: the **MIT copyright holder** (BC vs Frederik vs both) and the **public GitHub destination** (current org vs new). Both come from legal and the user respectively. Phase 5 accommodates them via placeholders.

## Scope

In: docs (LICENSE/NOTICE/CONTRIBUTING/SECURITY/CODE_OF_CONDUCT), license-deny CI, audit script, scrub script, placeholder safety net, ROADMAP update.

Out: actual `git-filter-repo` execution, swapping `<COPYRIGHT_HOLDER>` for the real value, creating the public GitHub repo, force-pushing, tagging v1.0.0, writing launch posts.

## Architecture

Five self-contained work blocks. Each commits independently, each verifiable on its own. No production code changes; nothing in `server/src/` or `app/src/` moves. The placeholder-safety check is the only CI step that's *expected* to fail at the end of Phase 5 (it's the gate that forces an explicit swap before the public push).

```
zugzug/
├── LICENSE                              # MIT, "<COPYRIGHT_HOLDER>" placeholder
├── NOTICE.md                            # Auto-generated from license-checker
├── CONTRIBUTING.md                      # DCO 1.1 + Signed-off-by
├── SECURITY.md                          # Points to GHSA only
├── CODE_OF_CONDUCT.md                   # Contributor Covenant 2.1
├── licenses.allowlist.json              # Escape hatch for legitimate exceptions
├── .gitleaksignore                      # Known-acceptable matches (e.g., test fixtures)
├── scripts/
│   ├── check-license-placeholder.sh     # CI step; fails until placeholder swapped
│   ├── audit-history.sh                 # Manual: gitleaks + project-string grep
│   ├── scrub-history.sh                 # Manual: git-filter-repo (refuses on tracked repo)
│   ├── replacements.txt                 # Exact from===>to mappings for the scrub
│   ├── generate-notice.sh               # Regenerates NOTICE.md from license-checker
│   └── README.md                        # How to invoke each script + Phase 6 runbook
└── .github/workflows/
    └── ci.yml                           # Adds license-checker steps + placeholder check
```

## Design decisions (locked)

### Legal documents

| Doc | Content | Why |
|---|---|---|
| **LICENSE** | MIT, copyright line: `Copyright (c) 2026 <COPYRIGHT_HOLDER>` | One-line swap before public push. `<COPYRIGHT_HOLDER>` is a deliberate placeholder so a CI check can flag it. |
| **NOTICE.md** | Auto-generated from `license-checker --json` for both workspaces, formatted to markdown with sections per workspace. Commit a snapshot; regenerate as part of CI. | Always-current. No drift between actual deps and what we credit. Acknowledges contributions without manual upkeep. |
| **CONTRIBUTING.md** | Standard Linux Foundation DCO 1.1 text. Requires `Signed-off-by: Name <email>` in every commit. Enforcement is social — no CI gate (`--no-verify` exists if needed). Plus sections: how to file an issue, how to file a PR, dev setup pointer (links to root README), code of conduct link. | DCO is locked one-way per parent spec. Skipping CI enforcement keeps friction low for first-time contributors — can add later if we see abuse. |
| **SECURITY.md** | One-channel: GitHub Security Advisories (private disclosure flow). No email fallback. Includes statement on responsible disclosure timeline (90 days), supported versions (v1.x), and credit policy. | GHSA is the modern OSS standard. Adds CVE issuance for free. Email channels go stale unless someone monitors them. |
| **CODE_OF_CONDUCT.md** | Contributor Covenant 2.1 verbatim. Contact: same channel as SECURITY (GHSA — for code-of-conduct violations, file a private security advisory marked "conduct"). | Standard, expected for any modern OSS repo. Light additional artifact. |

### Placeholder safety net

`scripts/check-license-placeholder.sh`:
- Greps `LICENSE` for `<COPYRIGHT_HOLDER>`.
- Exit 0 if absent (real holder filled in), exit 1 if present.
- CI runs it as a separate step named `license-placeholder-check`.
- Phase 5 ships with the placeholder in place → CI step is **expected to fail**. This is documented in the PR description and in `scripts/README.md`. Pre-public-push, the placeholder is swapped and the step starts passing.

The intentional-failure-as-gate pattern is unusual — risk is contributors thinking CI is broken. Mitigation: the failure message reads `WARNING: LICENSE still contains <COPYRIGHT_HOLDER> placeholder — must be swapped before public push. This is expected during Phase 5.` And ROADMAP.md explicitly notes the state.

### license-checker CI gate

Two parallel CI steps (one per workspace), each runs `license-checker --exclude 'MIT;BSD-2-Clause;BSD-3-Clause;Apache-2.0;ISC;CC-BY-4.0;CC0-1.0;0BSD;Unlicense' --failOn 'GPL;AGPL;LGPL;SSPL;CC-BY-NC;CC-BY-SA;UNKNOWN'`.

The `--exclude` is the allow-list (we accept these); `--failOn` is the deny-list. UNKNOWN is in the deny-list — forces an explicit decision in `licenses.allowlist.json` for any dep with missing metadata.

`licenses.allowlist.json` shape:

```json
{
  "exceptions": {
    "some-package@1.2.3": {
      "license": "UNKNOWN",
      "rationale": "Package metadata missing; upstream confirmed MIT in README.",
      "added": "2026-06-09"
    }
  }
}
```

A small wrapper (`scripts/run-license-check.sh`) reads this file and passes the corresponding `--customPath` exclusions to license-checker. If we don't end up needing any allow-listed entries, the wrapper degrades to running `license-checker` directly with no exceptions.

LGPL deliberately included in the deny-list. JavaScript has no real link-step distinction between static and dynamic; LGPL's "dynamic linking only" carve-out doesn't translate. Easier to deny it outright than litigate every transitive dep.

### History audit

`scripts/audit-history.sh` is a manual-invocation gate, not a CI step. Reasons:
- Running gitleaks against full history is expensive (~10–60s for this repo size).
- The result rarely changes — once history is scrubbed in Phase 6, it stays clean.
- A pre-public-push manual run is sufficient.

What the script does:
1. Runs `gitleaks detect --redact --report-format=json --report-path=/tmp/zugzug-gitleaks.json --no-git` (over the working tree) then `gitleaks detect --redact --report-format=json --report-path=/tmp/zugzug-gitleaks-history.json` (over the full history). Reports any findings.
2. Manual grep over full history for the project-specific strings (documented inline in the script for transparency):
   - `@bettercollective\.com`
   - `bettercollective\.com` (bare hostname, word-boundary-anchored)
   - `Zugzug` (case-insensitive, as a phrase)
   - `zugzug`
   - `sentry\.io/[0-9]+` (specific project URLs; the SDK import itself is fine — `@sentry/react` stays)
3. Prints a clear summary: counts per pattern + a verdict (`PASS` / `FAIL` with explanation).

The script has zero side effects — it produces a report, nothing else.

At the end of Phase 5, the audit is **expected to find** the BC strings (they're still in history; scrub hasn't run). That's intentional. Phase 6 runs the scrub, then re-runs the audit, and gates on PASS.

`.gitleaksignore` accepts known false positives — e.g., test fixtures containing fake API keys for OIDC tests. Each entry includes a SHA + path + reason as a comment.

### History scrub (dry-run-able, not executed in Phase 5)

`scripts/scrub-history.sh` uses `git-filter-repo` (the modern replacement for filter-branch).

Behavior:
1. Checks the current working directory is a fresh clone of `zugzug` (refuses if `git config --get remote.origin.url` resolves to `Fredehagelund92/zugzug` — to prevent accidental rewrite of the source-of-truth repo). The user must clone separately, then invoke.
2. Reads `scripts/replacements.txt` (the replacement table) and feeds it to `git-filter-repo --replace-text`.
3. Optionally deletes specific files via `--path` exclusions (`scripts/paths-to-delete.txt` if needed — empty in Phase 5; Phase 6 might add it).
4. After rewrite, re-runs `scripts/audit-history.sh` automatically and gates on PASS.
5. Prints the final commit count and the SHA range that was rewritten.

`scripts/replacements.txt` (committed in Phase 5):

```
# git-filter-repo --replace-text format: <pattern>==><replacement>
# One pattern per line. Lines starting with # are comments.

@example.com==>@example.com
example.com==>example.com
Zugzug==>Zugzug
zugzug==>zugzug
```

(Sentry-org URLs and gitleaks-flagged secrets get appended once Phase 6 audit produces concrete findings.)

`scripts/README.md` documents the Phase 6 invocation explicitly:

```bash
# Phase 6 runbook (DO NOT RUN IN PHASE 5):
git clone --mirror https://github.com/Fredehagelund92/zugzug zugzug-mirror
cd zugzug-mirror
../scripts/scrub-history.sh
# Verify the audit passes:
../scripts/audit-history.sh
# Then point at the new public remote and force-push:
git remote set-url origin <PUBLIC_REPO_URL>
git push --mirror
```

### ROADMAP update

`ROADMAP.md` gets a Phase 5 completion note and a Phase 6 next-steps section explicitly listing the open blockers (BC legal sign-off, `<COPYRIGHT_HOLDER>` decision, public GitHub destination). No structural change to the file — just date-stamping the state.

## Gate (must pass at end of Phase 5)

All of these are run via `bun run` or shell:

1. `LICENSE`, `NOTICE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `licenses.allowlist.json`, `.gitleaksignore` all committed to main.
2. CI green except for `license-placeholder-check` (intentionally failing — documented in CI summary).
3. `cd server && npx license-checker --exclude '...' --failOn '...'` → passes (no problematic licenses).
4. `cd app && npx license-checker --exclude '...' --failOn '...'` → passes.
5. `scripts/audit-history.sh` runs cleanly; report lists the expected BC strings (still present — scrub hasn't run yet).
6. `scripts/scrub-history.sh` exists and refuses to run against the live repo (safety check works).
7. A manual dry-run of the scrub against a local mirror clone produces a rewritten history that passes the tightened audit gate.
8. `ROADMAP.md` updated; Phase 5 marked complete; Phase 6 next-steps + blockers listed.

## Open questions to resolve before Phase 6 starts

- **`<COPYRIGHT_HOLDER>` value** — pending BC legal call (`Zugzug A/S and contributors` vs `Frederik Hagelund and contributors` vs both).
- **Public GitHub destination** — keep `Fredehagelund92/zugzug`, move to a new org, or create `voltagent/zugzug`-style? Affects URL permanently.
- **`zugzug` removal scope** — currently grep-matches in CLAUDE.md (the codename is documented). Confirm we want every occurrence rewritten to `zugzug` (or removed) — including in our own internal-process docs.
- **BC's Sentry project URL** — if there's a specific `sentry.io/<project_id>` to scrub, list it explicitly in `replacements.txt`. Recon shows the SDK is imported but the org-specific URL is gated behind `VITE_SENTRY_DSN` env (never committed).

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| license-checker flags transitive deps with unexpected licenses (e.g., a Bun dep with CC-NC) | Medium | `licenses.allowlist.json` provides escape hatch; each exception requires written rationale. Plan budgets time for this. |
| gitleaks produces false-positive findings against test fixtures (e.g., `zz_AAAA...` mock tokens) | Medium-high | `.gitleaksignore` for each known-acceptable match; reviewed at audit time. |
| The intentionally-failing `license-placeholder-check` step confuses contributors | Low | Failure message + ROADMAP note + PR description all flag the expected state. |
| `git-filter-repo` rewrite produces unintended damage on edge-case files (e.g., binary files containing matched substring patterns) | Low | `--replace-text` defaults to text-only files. Dry-run against mirror clone confirms. |
| BC legal sign-off takes longer than Phase 6's projected start | Medium | Phase 5 is independent — doesn't block on legal. Phase 6 waits as long as needed; nothing rots in Phase 5's deliverables. |

## Out of scope (deferred to Phase 6 or v1.1+)

- Actual `git-filter-repo` execution against history.
- Swapping `<COPYRIGHT_HOLDER>` for the real value.
- Creating the fresh public GitHub repo.
- Force-push to the public repo.
- v1.0.0 tag.
- Launch posts (HN, dbt Slack, r/dataengineering).
- CI enforcement of `Signed-off-by:` (currently social-only).
- Email contact channel for SECURITY (GHSA-only in v1).
- Automated dep-update PRs (Dependabot/Renovate) — separate v1.1 polish.
