***REMOVED*** scripts/

Operational scripts for Phase 5/6 OSS launch readiness.

***REMOVED******REMOVED*** Per-script reference

| Script | When to run | What it does |
|---|---|---|
| `check-license-placeholder.sh` | CI (auto) | Fails if `<COPYRIGHT_HOLDER>` is still in LICENSE. Intentionally failing during Phase 5. |
| `run-license-check.sh <workspace>` | CI (auto) + ad-hoc | Runs license-checker against the named workspace with the deny-list + allowlist exceptions. |
| `generate-notice.sh` | When deps change | Regenerates NOTICE.md from license-checker output. CI fails if NOTICE.md drifts. |
| `audit-history.sh` | Pre-Phase-6 (manual) | Runs gitleaks + greps for BC-internal strings. Reports findings. |
| `scrub-history.sh` | Phase 6 only (manual, against mirror clone) | Rewrites history using `git-filter-repo`. Refuses to run against the upstream repo. |

***REMOVED******REMOVED*** Phase 6 runbook

When BC legal signs off and we're ready for the public push:

```bash
***REMOVED*** 1. Clone the repo as a bare mirror to a fresh working dir
git clone --mirror https://github.com/Fredehagelund92/zugzug zugzug-mirror
cd zugzug-mirror

***REMOVED*** 2. Run the scrub (rewrites history per scripts/replacements.txt + re-audits)
../zugzug/scripts/scrub-history.sh

***REMOVED*** 3. Verify the audit passes cleanly
../zugzug/scripts/audit-history.sh

***REMOVED*** 4. Update LICENSE: swap <COPYRIGHT_HOLDER> for the real value
sed -i.bak 's/<COPYRIGHT_HOLDER>/<actual-holder>/' LICENSE

***REMOVED*** 5. Confirm placeholder check passes
bash ../zugzug/scripts/check-license-placeholder.sh

***REMOVED*** 6. Point at the new public remote and force-push
git remote set-url origin <PUBLIC_REPO_URL>
git push --mirror

***REMOVED*** 7. Tag v1.0.0 on the new public repo
cd ../<new-public-clone>
git tag v1.0.0
git push origin v1.0.0
```
