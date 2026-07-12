# Cleanup & Hardening — Execution Report

Branch `cleanup-hardening`, 13 commits, merged to `main` per pre-authorization after a clean re-verification of the final review's prescribed fixes. Not pushed.

## The new quality floor (all verified at merge)

- app: typecheck clean · **397 tests passing, 0 failing** (was 31 failing) · **lint 0 errors, 0 warnings** (was 19 problems)
- server: **545 tests passing, 0 failing** (was 20 failing)
- Living docs (README, app/README, ROADMAP) and all UI copy in the plain-language glossary; remaining sweep hits are internal identifiers only.

## What shipped (Tasks 1–9)

1. **Docs pass** — README/app-README/ROADMAP rewritten to record/source value/Review/publish vocabulary; MDM kept only as the competitor comparison; historical ADRs/audits untouched.
2. **UI long tail** — 10 known sites + 3 sweep catches fixed. One review-caught Critical reverted in-task: the webhook event *label* renders the wire-format name (`canonical.deleted`) and must not be prettified — renaming it would misdocument the API.
3. **App tests fix-to-green** — root causes: fixture shape drift (`values[]`→`counts{}`, 17 tests), incomplete store mocks, stale copy assertions, missing IntersectionObserver stub. Zero production changes, zero deletions. Opus review verdict: **green EARNED** (every assertion re-verified against current source).
4. **Server tests fix-to-green** — RLS count 12→14 (migration 0032 added two RLS'd tables — verified, not bumped), `"15m"`→`"hourly"` (migration 0030), scheduler tests now override `env.attachWarehouse` with save/restore, and one production change: **`qualifyRef`**. The implementer initially made a blanket catalog fallback, misreading a deliberate tightening (commit 5577552) as an accidental revert; the controller re-ruled a scoped version — **throw for MotherDuck (`creds.token`), 2-part fallback for local/in-memory DuckDB** (a documented adapter mode the strict throw had broken). New throw test added. The final Fable review independently concurred after checking `registry.ts` construction paths: the "MotherDuck without token" hole does not exist.
5. **Lint zero** — typographic quotes for the 9 entity errors; deps fixed/restructured where behavior-safe, 4 disables each with a specific true reason; DataGridRow typed via real generics (one justified `any` in the heterogeneous cell registry).
6. **OIDC first-admin lock** — same `pg_advisory_xact_lock(hashtext('zz:first-admin'))` key as the password path so the two auth paths serialize against each other; count+gate+both inserts atomic; ON CONFLICT role semantics preserved; cross-path lock-key pinned by a source-text test (honestly labeled — no OIDC issuer exists in CI).
7. **Merge confirm always** — the `sel.length >= 5` bypass is gone; every multi-record merge gets the blast-radius dialog. (Follow-up single-select no-op guarded in the final fix wave.)
8. **Publish-failure danger flash** — `flash(msg, tone)` with an info default; failures render with the same danger tokens as the conflict banner.
9. **Polish** — FormField clones a single element child with `aria-describedby={hintId}`; Link-wrapped Buttons became `useNavigate` buttons (valid HTML; open-in-new-tab affordance traded away, accepted); `type FieldDiff` import; merge flash says "· applies on next publish".

## Final whole-branch review (Fable)

Initial verdict NEEDS FIXES with one blocker the per-task reviews couldn't see: **a phantom worktree gitlink** (`.claude/worktrees/agent-…`, mode 160000, no .gitmodules) accidentally committed in Task 2 — would have shipped a dangling submodule to every clone. Fixed in `e1cffe2` along with: the pre-existing `fix+warehouse-add-remove` gitlink already on main (same class of dirt), `.claude/worktrees/` added to .gitignore, the README "who approved what" residue, and the single-select merge guard. Green honesty, cross-task seams (TablePane ×3 tasks), and the qualifyRef ruling were all independently confirmed.

## Follow-ups (filed here, none urgent)

- Strengthen `rls-policies.test.ts` from count-only to name-enumerated tables (it's a security test; a count passes even if the wrong table has RLS).
- `DatabaseRow.sourceCount` is a dead field (typed+fixture'd, never rendered).
- `FormField` clone replaces any `aria-describedby` a child already carries; merge instead if a call site ever passes one.
- The OIDC/password advisory lock serializes every login's gate block; only needed until the first admin exists — revisit if login volume ever matters.
- DataGrid.tsx:511 pre-existing bare eslint-disable could gain a reason comment for consistency.

## Next sub-projects (from the approved decomposition)

- **B — Publish lifecycle** (rollback, review inbox, commit-by-draft-list API): needs a design session with the maintainer; do not run unattended.
- **C — Settings IA consolidation**: one architectural choice, then a short plan.
