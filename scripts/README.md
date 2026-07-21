# scripts/

Operational scripts — mostly license/attribution tooling enforced in CI.

## Ongoing (CI-enforced)

| Script | When it runs | What it does |
|---|---|---|
| `run-license-check.sh <workspace>` | CI + ad-hoc | Runs license-checker against the named workspace (`app`/`server`) with the deny-list + `licenses.allowlist.json` exceptions. |
| `generate-notice.sh` | When deps change | Regenerates `NOTICE.md` from license-checker output. CI fails if `NOTICE.md` drifts. |
| `check-license-placeholder.sh` | CI | Guards `LICENSE` against a `<COPYRIGHT_HOLDER>` placeholder regressing back in. |

## One-time launch tooling (kept for reference)

These were used once to prepare the repository for its public release and are not
part of normal development:

- `audit-history.sh` — gitleaks + string audit over history.
- `scrub-history.sh` — history rewrite via `git-filter-repo` (see `replacements.txt`).
- `deploy-pr5-cutover.sh` — the multi-tenant cutover migration runner.
