# Cleanup & Hardening — Design

Sub-project A of the post-UX-review follow-up work (A: cleanup/hardening → B: publish lifecycle → C: settings IA). Scoped and approved 2026-07-12.

## Goal

After this branch merges, the repo's quality floor rises from "known-red baselines" to zero: both test suites green, lint clean, all docs speaking the same plain language as the UI, and five known hardening gaps closed.

## Success criteria (the merge bar)

- `cd app && bun run typecheck && bun run test && bun run lint` — all exit 0.
- `cd server && bun test` — exit 0.
- A JSX-text-aware vocabulary sweep over `app/src` and repo docs finds no user-facing avoid-terms (canonical, raw value, triage, master, golden, commit-as-noun, inbox, reconciliation, tenant, matching).
- README/ROADMAP/docs read plainly to a non-technical, non-native-English reader; pitch and quickstart structure preserved.

## Work items

### A1 — README/ROADMAP/docs full plain-language pass
Rewrite sentences that lean on canonical/raw/master/MDM/triage vocabulary in `README.md` (5 known hits), `ROADMAP.md`, and `docs/` (3 known hits), to the CONTEXT.md glossary: **record**, **source value**, **Review**, **table**, **mapping**, **publish**. Rules: keep the pitch structure and all quickstart commands byte-identical; keep dbt-facing `dim_`/`map_` names; prefer a concrete example ('US', 'USA', 'United States' → one record) over an abstract term; "MDM" may appear once as a positioning comparison ("existing MDM tools…") but not as the product's self-description. Final copy is written into the implementation plan by the planner (Fable) and transcribed by the implementer.

### A2 — UI vocabulary long tail
Known survivors (from the whole-branch review): `integrations/Webhooks.tsx:70`, `integrations/CreateWebhookModal.tsx:21`, `integrations/PullApi.tsx:150,218` ("Last commit", "canonical records"), `settings/Warehouse.tsx:147,175` ("master records", "writes canonical"), `admin/Workspaces.tsx:99,123`, `datagrid/ShortcutsOverlay.tsx:53` ("Review inbox"), `AddFieldPopover.tsx:571` ("pick a dimension"). Fix per glossary; then verify with a sweep that also matches JSX text nodes (not only quoted string literals — the blind spot that let "Nothing to triage yet." survive three sweeps). Internal identifiers, route paths, API field names stay.

### A3 — App tests fix-to-green
7 failing files (31 tests): dashboard-helpers, database-table, audit-route, login-copy, dashboard-remap-staged, settings-sidebar, triage-commit-copy. Policy (user-approved, full authority): investigate each — stale assertion → update to current intended behavior; real bug caught → fix the code; genuinely obsolete → delete with justification logged in the task report. If a failure is environmental (needs external services), convert to an explicit `it.skip` with a reason comment rather than leaving it red.

### A4 — Server tests fix-to-green
20 failures, cause unknown. Same policy as A3, with one extra step first: classify env-dependent failures (DB state, missing tokens, MotherDuck attachment) vs code/test issues before changing anything. Env-dependent → explicit skip-with-reason gated on the missing precondition; code/test issues → fix.

### A5 — Lint-to-green
9 errors, 10 warnings, all pre-existing. Fix; suppressions (`eslint-disable`) only with a justifying comment, and never for the `errors` tier.

### A6 — OIDC first-admin advisory lock
Port the transaction + advisory-lock pattern from `server/src/auth-password.ts` to `server/src/auth-oidc.ts:197-218` (count read + user INSERT + membership INSERT inside `pgTx`; delete the stale race NOTE). **Must use the same lock key** (`hashtext('zz:first-admin')`) so password and OIDC first-signups serialize against *each other*, not just within their own path. Add a test mirroring `auth.test.ts`'s two-signups→admin-then-editor shape in the OIDC harness (or, if the OIDC path has no test harness, a repo-level test of the shared role-decision path — investigate first).

### A7 — Merge confirmation for all multi-record merges
Remove the `sel.length >= 5` gate in `app/src/components/TablePane.tsx` (~line 1460) so the existing blast-radius ConfirmDialog covers every multi-record merge (2+). No new dialog; Undo unchanged.

### A8 — Publish-failure styling unification
TablePane's `doPublish` failure currently surfaces via the accent-styled info `flash` — visually a success notice. Give it danger treatment consistent with Review's error banner. Mechanism: extend the existing flash with a tone parameter if that is a small change; otherwise reuse whatever error-banner primitive TablePane already renders (conflict banner styling) — smallest honest change, no new banner infrastructure.

### A9 — Polish batch
- `aria-describedby`: FormField already generates a hint id when `htmlFor` is set but nothing references it. Chosen mechanism: when `htmlFor` is set, hint exists, and the child is a single React element, FormField clones the child with `aria-describedby={hintId}`. Call sites with multiple/opaque children are skipped (no cloning heuristics beyond the single-element case).
- Button-inside-Link (invalid `<a><button>` nesting): `Sources.tsx` setup card and `NoTablesYet.tsx` — replace the Link wrapper with `useNavigate` on the Button's onClick.
- `import { type FieldDiff }` in TablePane.
- Merge flash copy aligned with the dialog's timing framing: "… re-pointed · applies on next publish".

## Explicitly excluded (wontfix here)

- CSV preview date-format edge (JS `Date` vs Postgres `::date` for non-ISO formats): the client cannot know the server's DateStyle; the server already fails honestly. Revisit only if users hit it.
- Anything belonging to sub-project B (publish lifecycle: rollback, review inbox, commit-by-draft-list) or C (settings IA).

## Risk & escalation policy

A3/A4/A5 are investigation work. Contract for implementers: if a red test reveals a genuine bug whose fix is non-trivial (touches publish semantics, auth, or data integrity, or exceeds ~30 lines of production code), STOP and report BLOCKED with the diagnosis — the controller decides fix-here vs file-to-B. Never hack a test green (weakening an assertion to pass is a review-rejectable offense). Every deleted test needs a one-line justification in the task report.

## Orchestration

Branch `cleanup-hardening` off main. Same subagent-driven machinery as the previous run: haiku implementers for transcription tasks (A1, A2, A7, parts of A9), sonnet for investigation/logic (A3–A6, A8), sonnet/opus reviewers scaled to risk, Fable as controller/judge, ledger at `.superpowers/sdd/`, per-task commits, final whole-branch review on the most capable model. Not merged or pushed without the maintainer (merge pre-authorization may be granted at plan approval).

## Testing/verification

Each task carries its own verification (suite runs, sweep greps). The final task re-runs everything against the new zero bar and produces a short report listing: per-test dispositions from A3/A4 (fixed test / fixed code / deleted+why / skipped+why), and the vocabulary sweep output.
