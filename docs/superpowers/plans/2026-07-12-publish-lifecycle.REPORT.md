# Publish Lifecycle — Execution Report

Branch: `publish-lifecycle`, 23 commits on top of `main` @ dba10c5. **Not merged, not pushed** — per agreement, this branch waits for the maintainer.
Final whole-branch review (Fable): **READY WITH FOLLOW-UPS**; its two recommended pre-merge items plus one hygiene fix landed in `6d4c295`. Final bar: app typecheck/lint clean + 79 test files green; server **558 tests / 0 failures**; glossary sweep clean.

## What shipped (spec: docs/superpowers/specs/2026-07-12-publish-lifecycle-design.md)

- **Snapshot per publish** — `dimension_version` (migration 0036, house RLS pattern with super-admin bypass) written *inside* the commit transaction with the same version counter as the outbound event; captures dynamic attribute columns via `to_jsonb`. Rollback-of-rollback works because every publish, including rollbacks, snapshots itself.
- **Draft-scoped commit** — `commit(dimId, userId, tenantId, draftKeys?, opts?)`: validation-first (400 naming unknown keys, nothing folded), all 10 fold statements scope-audited by opus review, `draftKeys: []` = record-state-only publish (tested), four-eyes gate narrows to the folded set. Both publish previews now commit **exactly the drafts they displayed** (pruned dialog state, race verified closed).
- **Reject with reason** — drafts gain `rejected` status + reason + reviewer; re-staging clears it; rejected rows excluded from every fold path. Author sees a danger badge with the reason in Triage *and* match mode, with Re-stage (author-only) and Discard as the only actions; accept/skip/map/bulk paths guard rejected rows at the handler level on both surfaces.
- **Awaiting-review inbox** — others' staged drafts (system rescan drafts included under "System (rescan)"), grouped table → author, select-and-publish through the existing preview dialog (scoped commit; four-eyes passes naturally) or reject-with-required-reason with per-table partial-failure outcomes. Viewers read-only; self-contained identity guard.
- **Rollback** — admin-only (route `requireAdmin` + UI `table.rollback`), typed confirmation (`v{n}`), one-transaction restore (schema-drift-tolerant column intersection, injection-safe via live-column intersection + qid), canonical_version bookkeeping that keeps OCC sound and makes the restore visible to publish-state, then republish with `kind='rollback'`/`restores_version`. Version-history panel with counts, publisher, and in-flight button disabling.
- **Honest warehouse semantics** — writable-mode rollback reports `synced-additive` (the adapter's MERGE cannot delete rows the reverted version added) with an audit warning recommending manual resync; commit's no-op warehouse block is skipped on the rollback path so the real result is never shadowed.
- **Webhooks** — `dimension.committed` gains additive `kind` + `restores_version`; documented in the webhook reference UI: rollbacks arrive as a normal publish, ignorant consumers stay correct.

## Review-loop catches worth knowing (each fixed on-branch)

- The preview-vs-commit race (both surfaces) — closed and re-verified by tracing the keys to the pruned dialog state.
- `warehouseSynced: "synced"` after a rollback that provably leaves stale rows — replaced with `synced-additive` + audit disclosure.
- Match mode letting users map over a rejected draft, silently erasing the rejection (the final Fable review caught that a prior fix had only guarded Triage despite the ledger's claim).
- A non-author Re-stage creating shadowed zombie drafts (per-user draft PK + client dedup) — Re-stage is now author-scoped.
- My own plan's buggy discard snippet (`[] is truthy`) — caught and fixed by an implementer; my plan's `JSON.stringify` into jsonb would have double-encoded — caught against a documented codebase precedent.

## The stability saga (a day of the calendar, honestly told)

Mid-branch, the server suite went from reliably green to chaotic (failure counts varying 9–215 across identical runs). The eventual root causes, after several of my own false leads (dirty-DB theory, a catastrophic per-file preload guard, a wrong sentinel table, a cwd artifact I nearly reported as truth):

1. **A leaked scheduler tick** — a hang-test's in-flight tick survived its file inside an open transaction, colliding with `resetDb()`'s DROP SCHEMA across the rest of the suite. Fixed with drain-then-hard-stop semantics in the scheduler (`stopped` flag; production-grade, reviewed).
2. **bun 1.3.14 applies preload `setDefaultTimeout` only to the first test file** — every later file silently reverted to 5s while schema rebuilds take 7–13s; hooks died mid-rebuild leaving half-built schemas. Fixed via a loader plugin injecting the timeout per file (empirically verified; bunfig's `[test].timeout` is ignored in this version).
3. A **zombie `bun test` process from Saturday** (spend-limit-killed session) amplified everything with load. Killed.
4. App-side: vitest's 5s default flakes suite-wide under parallel load on a busy machine — global `testTimeout: 15000`, rationale documented (per-file scoping proved whack-a-mole across 10 files).

Anti-recurrence: the wipe/migrate/reseed sequence for the Docker test DB is `psql ... DROP/CREATE DATABASE` + `bun -e resetDb` (documented here because `docker compose` v2 isn't on this machine).

## Follow-ups for the maintainer (none merge-blocking; from the final review + ledger)

1. Scheduler hard-stop leaves interrupted `scan_run` rows in `running` — write `aborted` instead.
2. Confirm/document the deliberate boundary: **four-eyes governs mapping drafts only**; record-state publishes are self-publishable (ADR-0002's instant-edit model). One doc line.
3. Deletion-capable warehouse resync (turns rollback's `synced-additive` into a true sync); also the pre-existing INSERT-only limitation on the normal commit path.
4. Crash seam nicety: a publish that recovers an interrupted rollback goes out as plain `kind:"publish"` without `restores_version` (state recoverable, semantics lost); single-tx rework not warranted for admin-rare usage.
5. Friendlier error for concurrent same-dim publishes (unique-constraint 500 today; the constraint itself is correct).
6. Bulk actions silently skip rejected rows in match mode — consider a toast.
7. Test debt: resetDb 7–13s × 24 files (suite wall-clock), 8+ vi.doMock-heavy app test files, audit action-string casing unification, `rejectDrafts` rejects all authors' drafts for a raw under one reason (raw-keyed model — note, not bug).

## Process notes

11 plan tasks; sonnet/haiku implementers, opus gates on every governance diff, Fable final review. Two spend-limit casualties (one task salvaged from a dead agent's verified work, one required a re-dispatched fixer). Two controller shell mistakes are on the record in the ledger (`.superpowers/sdd/progress-publish.md`): a commit that landed before its green gate (validated after the fact) and a cwd-relative path check that nearly produced a false root cause. The ledger is the full audit trail.
