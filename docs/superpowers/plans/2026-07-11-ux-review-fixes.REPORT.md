# UX Review Fixes — Overnight Execution Report

Branch: `ux-review-fixes` (34 commits on top of `main` @ e4f9080). **Not merged, not pushed** — review and merge at your discretion.
Final whole-branch review verdict (Fable judge): **READY WITH FOLLOW-UPS** — the two pre-merge Importants it raised were fixed in `f1891f4`.

## What shipped

All 25 plan tasks completed. Every task passed an independent spec+quality review (sonnet/opus reviewers, Fable adjudication); Critical/Important findings were fixed and re-reviewed before the next task started.

**Vocabulary (Tasks 1–3, 25):** CONTEXT.md Language section rewritten to the plain-language glossary you chose — **record** (unqualified), **source value**, **Review**, **table**, mapping/publish/draft/workspace/source. CLAUDE.md gained a vocabulary rule. All user-facing strings swept: nav ("Workbench"→"Review"), "Matching defaults"→"Mapping defaults" (route `settings/mapping` + redirect), "Master data" kickers, palette keywords, first-run copy de-jargoned with concrete examples ('US'/'USA'/'United States'), plus a final sweep catching 12 more strings including JSX text nodes.

**Accessibility (Tasks 4–6):** per-route `document.title` (usePageTitle hook, tested), skip link + `id="main"`, 24px color swatches with radiogroup semantics, labeled icon buttons, backdrop `role="presentation"`, FormField explicit `htmlFor` binding.

**Onboarding & roles (Tasks 7–12):** Signup shows the allowed domain upfront; viewers see disabled CTAs with an explanation instead of hidden buttons (Triage also gained the missing canEdit gate); workspace-less landing polls memberships every 30s with Copy-my-email/Check-now (+ clipboard prompt fallback); audit pages got scope labels + `?q=` deep links + per-record "View history" context-menu action; admin "Back to app" returns to the last tenant; Sources got a first-run setup card cross-linking Warehouse settings.

**Publish safety (Tasks 13–21):** Triage bulk publish no longer toasts success before committing — per-table outcomes, persistent failure banner naming failed tables (tested); **PublishPreviewDialog** on both publish surfaces (TablePane and cross-table Review) showing staged mappings with per-draft discard + record-edit counts — `approveAndCommitAll`/`doPublish` are reachable only via the dialog's Confirm (grep-verified); merge/retire dialogs show source-value blast radius with an honest not-loaded fallback; conflict banner shows theirs-vs-yours for label renames with clearer buttons; CSV import preview with per-column remapping — invalid dates **block** import (server `::date` throws; the original "imports empty" copy was a Critical caught in review), number/boolean checks mirror server coercion via a shared tested `fieldMismatch` predicate; grid quick search over labels in the existing filter pipeline; ordering switch offers a pre-destruction CSV export.

**Server governance (Tasks 22–24):** first-admin race fixed with `pg_advisory_xact_lock` in a transaction (tested); **four-eyes gate**: `requireSecondPublisher` preference (migration 0035), commit rejects author-published drafts with typed 403 `SECOND_PUBLISHER_REQUIRED` before any mutation, `u_system` rescan drafts never block (tested alice-can't/bob-can); admin-only "Four eyes on publish" toggle on the Mapping settings page; friendly rejection message on both publish surfaces via a typed `ApiCodeError` (parsed code, not string matching).

## Investigation verdict (Task 21)

The review's hypothesis that **rescans silently consume staged drafts is REFUTED**: rescans stage separate system-authored drafts (`u_system`, `repo-scan.ts:410`); user drafts are distinct rows keyed by `(tenant, dim, raw, user_id)` (`repo-drafts.ts:83`). Rescan toasts now state "· staged drafts untouched".

## Verification

- app: typecheck clean; tests 7 pre-existing failing files (stash-verified identical to main); lint 19 pre-existing problems (stash-verified); **new green tests**: usePageTitle, commit-outcomes (4), conflict-banner diff, csv/fieldMismatch (8), plus updated conflict-banner suite.
- server: 523 pass / 20 pre-existing failures (baseline 522/20 — net +2 new passing: auth race, second-publisher gate).

## Discoveries (pre-existing issues found during review, not from the original UX review)

1. **Merges of 2–4 records bypass the confirmation dialog entirely** (`sel.length >= 5` gate in TablePane) — undercuts the new blast-radius work; recommend extending the dialog to all multi-record merges. *High priority.*
2. **The identical first-admin race exists in the OIDC path** (`auth-oidc.ts:197-218`, still carries the old race NOTE) — port the advisory-lock fix.
3. `audit-route.test.tsx` sits in the pre-existing red baseline (incomplete store mock), so the new Activity-page copy is not protected by a green test.

## Follow-ups to file (triaged by the final review; none block merge)

1. Publish-by-draft-list server API: the preview shows a snapshot-at-open but Confirm commits live drafts — narrow window, real gap. Also filter the TablePane preview to mapped-with-target drafts.
2. Merge-confirm below 5 selections (discovery #1).
3. OIDC advisory lock (discovery #2).
4. Conflict diff beyond label renames — needs the 409 payload to carry field values.
5. `aria-describedby` wiring from FormField hint ids to inputs.
6. Fix the audit-route test mock (discovery #3).
7. Unify publish-failure styling: TablePane failure uses the accent `flash` banner, Review uses the red danger banner.
8. Vocabulary long tail on secondary surfaces: integrations (Webhooks/PullApi "canonical records", "Last commit"), settings/Warehouse ("master records"), admin/Workspaces, ShortcutsOverlay "Review inbox", AddFieldPopover "pick a dimension". Re-sweep with a JSX-text-aware grep.
9. Minor batch: Button-inside-Link nesting (Sources/NoTablesYet), sparse empty-drafts preview group, merge-dialog tense mismatch ("on next publish" vs "re-pointed"), JS-vs-Postgres date-format edge in CSV preview, `type` keyword on the FieldDiff import.

## Deliberately out of scope (per your instruction)

Settings/integrations/account shell consolidation; `MasterTables.tsx` file rename; publish rollback (needs its own attended design); `settings/tokens` and `settings/scans` redirects left in place (they point at real destinations; only the `settings/audit` ghost was removed).

## Process notes

- Implementers: haiku (7 mechanical tasks) / sonnet (18); reviewers: sonnet/opus scaled to risk; final whole-branch review: Fable. Two controller adjudications overruled reviewer findings with code evidence (Task 7 placement — Login parity; Task 11 sessionStorage guard — benign self-correcting, matches existing pattern); both are logged in `.superpowers/sdd/progress.md`.
- One implementer death (connection drop, Task 8) — clean retry, no partial state.
- Task briefs, per-task reports, and review packages are in `.superpowers/sdd/` (git-ignored scratch).
