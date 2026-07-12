# Cleanup & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the repo's quality floor to zero — both test suites green, lint clean, all living docs in the plain-language glossary — and close five known hardening gaps (spec: `docs/superpowers/specs/2026-07-12-cleanup-hardening-design.md`).

**Architecture:** Ten sequential tasks on branch `cleanup-hardening`: copy first (Tasks 1–2), then the green-up investigations (3–5), then hardening features (6–9), then final verification + whole-branch review with pre-authorized merge-on-green (10). No new subsystems; every change lands in existing files/patterns.

**Tech Stack:** React+TS+Vite+vitest (`app/`), Bun+Postgres (`server/`), eslint.

## Global Constraints

- Glossary (CONTEXT.md `## Language`): user-facing copy uses **record**, **source value**, **Review**, **table**, **mapping**, **publish**, **workspace**. Never user-facing: canonical, raw value, triage, master, golden, commit (as the publish act), inbox, reconciliation, tenant, matching. Internal identifiers, route paths, env var names, dbt-facing `dim_`/`map_` names are NOT renamed.
- "MDM" may appear once in README as a competitor comparison, never as self-description.
- Historical documents (`docs/adr/*`, `docs/ux-audit/*`) are point-in-time records — do NOT rewrite them.
- Fix-to-green authority (user-approved): stale test → update; real bug → fix code; obsolete test → delete with one-line justification in the task report; environmental dependency → explicit skip gated on the missing precondition, with a reason comment. NEVER weaken an assertion just to pass — review-rejectable.
- Escalation contract: a bug fix that touches publish semantics, auth, or data integrity, or exceeds ~30 lines of production code → STOP, report BLOCKED with the diagnosis.
- The merge bar (Task 10): `cd app && bun run typecheck && bun run test && bun run lint` all exit 0; `cd server && bun test` exit 0; vocabulary sweep clean.
- Commits: conventional, ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Merge-on-green is PRE-AUTHORIZED: if the Task 10 whole-branch review verdict is clean (no Critical/Important), the controller merges to main locally. No push.

---

### Task 1: Living docs plain-language pass `[haiku]`

**Files:**
- Modify: `README.md:7,9,32,34,82`
- Modify: `app/README.md:3,7,49`
- Modify: `ROADMAP.md:26,96`

**Interfaces:** none — copy only. Quickstart commands, tables, links, and issue titles stay byte-identical.

- [ ] **Step 1: README.md replacements** (match on old text, not line numbers):

Line 7, old: `A team curates raw values to canonical IDs via a browser UI; results land in ...`
New (only this sentence changes; the MDM-comparison sentences before it stay):
`A team maps source values to approved records in a browser UI; results land in `dim_<x>` / `map_<x>` tables dbt can join directly.`

Line 9, old sentence fragment: `the canonical Country or Currency list your dashboards and finance close depend on`
New: `the one Country or Currency list your dashboards and finance close depend on`

Line 32, old: `Team members assign each raw value to a canonical record (a `key` + `label` pair). Assignments sit in Postgres as drafts until an approver commits them.`
New: `Team members map each source value to a record (a `key` + `label` pair). Mappings sit in Postgres as drafts until an editor publishes them.`

Line 34, old: `Committing writes `dim_<x>` and `map_<x>` tables. In default mode (Postgres canonical store), results live in Postgres ... If you configure a writable warehouse adapter, commits write directly into your warehouse`
New: `Publishing writes `dim_<x>` and `map_<x>` tables. In default mode (Postgres record store), results live in Postgres and are downloadable as Parquet on demand. If you configure a writable warehouse adapter, publishes write directly into your warehouse`

Line 82, old: `For non-default setups (Snowflake, OIDC, writable canonical store), see`
New: `For non-default setups (Snowflake, OIDC, writable warehouse store), see`

Also scan README for any remaining `raw value`/`canonical`/`commit` prose (e.g. "The UI shows unmapped values" is fine); replace stragglers per glossary, leaving env-var literals and code blocks untouched.

- [ ] **Step 2: app/README.md replacements:**

Line 3: `a master-data layer over a DuckDB warehouse` → `a reference-table layer over a DuckDB warehouse`
Line 7: `canonical/drafts/audit in Postgres` → `records/drafts/audit in Postgres`
Line 49: `typed mock fixtures (master/source tables, mappings)` → `typed mock fixtures (reference/source tables, mappings)`

- [ ] **Step 3: ROADMAP.md replacements:**

Line 26: `**[#17] Triage: bulk Skip action**` → `**[#17] Review: bulk Skip action**`; and `from the original triage bulk spec` → `from the original Review bulk spec`. The issue link text in line 39 (`canonical_history + per-record revert`) names a code identifier and a GitHub issue title — leave it.
Line 96: `version-column conflict detection on canonical row edits` → `version-column conflict detection on record edits`

- [ ] **Step 4: Verify and commit**

```bash
grep -n "raw value\|canonical\|master data\|master-data\| triage" README.md app/README.md ROADMAP.md | grep -v "canonical_history\|MDM tools" && echo CHECK || echo OK
git add README.md app/README.md ROADMAP.md
git commit -m "docs: plain-language pass on living docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Expected: `OK` (any CHECK line must be a code identifier or the allowed MDM comparison — justify in the report).

---

### Task 2: UI vocabulary long tail + JSX-aware sweep `[haiku]`

**Files:**
- Modify: `app/src/routes/integrations/Webhooks.tsx:70`, `app/src/routes/integrations/CreateWebhookModal.tsx:21`, `app/src/routes/integrations/PullApi.tsx:150,218`, `app/src/routes/settings/Warehouse.tsx:147,175`, `app/src/routes/admin/Workspaces.tsx:99,123`, `app/src/components/datagrid/ShortcutsOverlay.tsx:53`, `app/src/components/AddFieldPopover.tsx:571`

**Interfaces:** none — user-facing strings only. Line numbers may drift; anchor on the old text.

- [ ] **Step 1: Apply replacements** (read each site's sentence; keep grammar intact):

| File | Old fragment | New fragment |
|---|---|---|
| Webhooks.tsx:70 | `canonical records` | `records` |
| CreateWebhookModal.tsx:21 | `canonical records` | `records` |
| PullApi.tsx:150 | `Last commit` | `Last publish` |
| PullApi.tsx:218 | `canonical records` | `records` |
| Warehouse.tsx:147 | `master records` | `records` |
| Warehouse.tsx:175 | `writes canonical` (read full sentence, rephrase per glossary, e.g. `writes records`) | per glossary |
| Workspaces.tsx:99 | `reconciliation environments` | `mapping environments` |
| Workspaces.tsx:123 | `canonical tables` | `reference tables` |
| ShortcutsOverlay.tsx:53 | `Review inbox` | `Review` |
| AddFieldPopover.tsx:571 | `— pick a dimension —` | `— pick a table —` |

- [ ] **Step 2: JSX-aware sweep** (catches text nodes, not just quoted literals):

```bash
cd app && grep -rnE '(>[^<>{]*|"[^"]*)\b(canonical|raw value|triage|master (data|record|table)|golden|reconciliation|inbox)\b' src --include="*.tsx" | grep -vi "test\|//" | head -30
```

Judge every hit: internal identifier / comment → keep; user-facing → fix per glossary. List each hit + decision in the report.

- [ ] **Step 3: Verify and commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "fix(copy): vocabulary long tail on secondary surfaces

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: App tests fix-to-green `[sonnet]`

**Files:**
- Modify (as investigation dictates): `app/test/dashboard-helpers.test.ts` (17 failing), `app/test/audit-route.test.tsx` (2), `app/test/database-table.test.tsx` (2), `app/test/dashboard-remap-staged.test.tsx` (6), `app/test/login-copy.test.tsx` (1), `app/test/settings-sidebar.test.tsx` (1), `app/test/triage-commit-copy.test.tsx` (2), plus production files only within the escalation contract.

**Interfaces:** none new. Production behavior changes only via the fix-to-green authority + escalation contract in Global Constraints.

- [ ] **Step 1: Reproduce and classify.** Run `cd app && bun run test 2>&1 | grep -A8 "FAIL"` and, for each of the 7 files, read the test and the code under test. Classify each failure: (a) stale assertion (asserts pre-rename copy or pre-refactor shape), (b) broken test infrastructure (incomplete store mock — known for audit-route), (c) real production bug, (d) environmental. Note: `dashboard-helpers` failing 17 pure-function tests suggests a broken import or an intentional helper change — diagnose before touching assertions; `triage-commit-copy` asserts CURRENT button text ("Publish to warehouse") yet fails — likely mock/timing, not copy.
- [ ] **Step 2: Fix per classification.** Stale → update to current intended behavior (the intended copy is what the app renders today, post-glossary). Mock gaps → complete the mock (the store's shape is in `app/src/store.ts`). Real bug → fix if within contract, else BLOCKED. Obsolete → delete with justification.
- [ ] **Step 3: Verify the whole suite**

Run: `cd app && bun run test`
Expected: exit 0, `Test Files 0 failed`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(app): fix-to-green — repair stale assertions and mocks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Report must contain a disposition table: file → test → classification → action (updated/fixed-code/deleted+why/skipped+why).

---

### Task 4: Server tests fix-to-green `[sonnet]`

**Files:**
- Modify (as investigation dictates): the failing test files + production files within the contract.

**Interfaces:** none new.

- [ ] **Step 1: Classify env vs code FIRST.** The 20 failures cluster: (1) tenant/preferences/RLS ×4 (`GET /api/t/:slug/preferences`, `11 scoped tables have RLS enabled`, `tenant_iso policy`, `tenant A/B preferences independent`); (2) warehouse read adapter ×10 (`qualifyRef`, `tableExists`, `listColumns`, `distinctValues`, `topValuesByFrequency`, `columnStats`, `nameResolution` ×3, `distinctValuesWithProvenance`); (3) `DuckDbWritableAdapter` ×4; (4) scheduler jobs ×2 (`no-op when ATTACH_WAREHOUSE is false`). For each cluster read the failure output: does it need a DuckDB attachment / MotherDuck token / migration state the local env lacks (→ env), or is it a code/test drift (→ fix)? The RLS cluster may just need migrations applied to the test DB — check how the harness provisions schema before concluding "env". The scheduler no-op tests failing in <10ms smell like code/test drift, not env.
- [ ] **Step 2: Fix per classification.** Env-dependent → explicit skip gated on the precondition, e.g.:

```ts
const hasWarehouse = process.env.MOTHERDUCK_TOKEN !== undefined && process.env.ATTACH_WAREHOUSE === "true";
it.skipIf(!hasWarehouse)("distinctValues returns trimmed-non-empty distinct strings", async () => { ... });
```

(Check bun test supports `skipIf` — it does via `test.skipIf`; otherwise `if (!hasWarehouse) { it.skip(...) }` following any existing pattern in the suite.) Code/test drift → fix within the contract.
- [ ] **Step 3: Verify** — `cd server && bun test` → exit 0, 0 fail.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(server): fix-to-green — env-gated skips and repaired drift

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Report: disposition table as in Task 3, with the env-vs-code evidence per cluster.

---

### Task 5: Lint-to-green `[sonnet]`

**Files:**
- Modify: `app/src/components/CreateTableModal.tsx:295-296` (6 errors), `app/src/components/warehouse/DatabaseTable.tsx:35` (2), `app/src/routes/integrations/PullApi.tsx:141` (1), plus the warning sites: `AppShell.tsx:365`, `ComboSelect.tsx:133`, `datagrid/DataGrid.tsx:521,1168`, `datagrid/DataGridRow.tsx:22,31,39` (4× no-explicit-any), `datagrid/cells/BooleanCell.tsx:36`, `datagrid/useGridCursor.ts:219`.

- [ ] **Step 1: Fix the 9 errors** — all `react/no-unescaped-entities`. Replace straight quotes in JSX text with typographic quotes (reads better than HTML entities): `'USA'` → `'USA'`, `"..."` → `"..."` at DatabaseTable:35. Copy meaning unchanged.
- [ ] **Step 2: Fix the 10 warnings.** `no-explicit-any` in DataGridRow → type properly against the generic Row/ColumnDef types in `datagrid/types.ts`. `exhaustive-deps` → fix the dep array ONLY where doing so provably cannot change behavior (stable function identities); where adding the dep risks re-run loops (e.g. `props` in a memo, callbacks recreated per render), prefer the ESLint-recommended restructure (destructure/useCallback at the source); if neither is safe within ~10 lines, use `// eslint-disable-next-line react-hooks/exhaustive-deps -- <reason>` (allowed for warnings tier only, per spec).
- [ ] **Step 3: Verify** — `cd app && bun run lint` → exit 0; `bun run test` still exit 0 (deps changes can alter behavior — the suite guards).
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore(lint): zero errors and warnings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: OIDC first-admin advisory lock `[sonnet]`

**Files:**
- Modify: `server/src/auth-oidc.ts:196-235` (count read, gate check, role decision, user INSERT, membership INSERT)
- Reference: `server/src/auth-password.ts` (the shipped pattern), `server/src/pg.ts` (`pgTx`)
- Test: `server/src/auth.test.ts` or the OIDC test harness (investigate: `grep -rln "oidc" server/src/*.test.ts server/test 2>/dev/null`)

**Interfaces:**
- Consumes: `pgTx(fn)` from pg.ts (single-connection transaction; helpers `tx.get/all/run`).
- Produces: nothing new — same HTTP behavior, race closed.

- [ ] **Step 1: Read the full OIDC callback region** (auth-password.ts's locked block is the template). Wrap in one `pgTx`: `SELECT pg_advisory_xact_lock(hashtext('zz:first-admin'))` — **the SAME key as auth-password.ts**, so password and OIDC first-signups serialize against each other — then the `userCount` read, the allowlist gate check, the users INSERT (keep its `ON CONFLICT (id) DO UPDATE` — repeat logins must not reset role), and the tenant_member INSERT. The `loginErrorRedirect("not_allowed", ...)` denial must still occur AFTER the tx unwinds without inserting (return a sentinel from the tx like auth-password.ts's `{denied: true}` pattern). Delete the stale `NOTE: userCount===0 is race-vulnerable` comment.
- [ ] **Step 2: Failing test.** If an OIDC harness exists, mirror auth.test.ts's two-signups→admin-then-editor test through it. If none exists (likely — OIDC needs an issuer), test at the seam that IS reachable: extract nothing new, but add a test to auth.test.ts proving cross-path serialization intent is documented — concretely: assert the same lock key literal appears in both files:

```ts
it("password and OIDC first-admin paths share one advisory lock key", async () => {
  const pw = await Bun.file("src/auth-password.ts").text();
  const oidc = await Bun.file("src/auth-oidc.ts").text();
  const key = "hashtext('zz:first-admin')";
  expect(pw).toContain(key);
  expect(oidc).toContain(key);
});
```

(A source-text assertion is a smell in general; here it is the honest cheap guard for a cross-file invariant that no integration test can reach without an OIDC issuer. Keep it, with this comment.)
- [ ] **Step 3: Run** — `cd server && bun test` → exit 0 (Tasks 4 ordering guarantees the baseline is already green).
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "fix(auth): OIDC first-admin race closed with shared advisory lock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Merge confirmation for all multi-record merges `[haiku]`

**Files:**
- Modify: `app/src/components/TablePane.tsx` (~line 1455-1470 — anchor on `sel.length >= 5`)

- [ ] **Step 1:** Find the merge trigger: it branches `sel.length >= 5` → confirm dialog, else → `void merge(survivorLabel)` directly. Remove the size gate so ALL merges route through the confirm path (the blast-radius dialog + survivorKey guard shipped earlier). Delete the now-dead direct-merge else-branch. Do not touch the dialog itself.
- [ ] **Step 2:** `cd app && bun run typecheck && bun run test` → both clean.
- [ ] **Step 3: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "fix(grid): every multi-record merge gets the blast-radius confirmation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Publish-failure danger styling `[sonnet]`

**Files:**
- Modify: `app/src/components/TablePane.tsx:446` (`flash`) and the `doPublish` catch that calls it

**Interfaces:**
- Produces: `flash(m: string, tone?: "info" | "danger")` — default `"info"` keeps every existing call site unchanged.

- [ ] **Step 1: Read `flash`'s implementation** (TablePane.tsx:446 + wherever the flash banner renders). Add the optional `tone` param; `"danger"` renders the banner with the danger tokens already used by the conflict banner (`border-danger/40 bg-danger-soft text-danger` — verify against ConflictBanner.tsx's actual classes and reuse them). If flash state is a plain string, widen to `{ msg: string; tone: "info" | "danger" }`.
- [ ] **Step 2:** In `doPublish`'s catch (and any other failure `flash` in the publish path — grep `Publish failed` in TablePane), pass `"danger"`.
- [ ] **Step 3:** `cd app && bun run typecheck && bun run test` → clean.
- [ ] **Step 4: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "fix(publish): failure flash uses danger styling, matching Review

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Polish batch `[sonnet]`

**Files:**
- Modify: `app/src/components/FormField.tsx`, `app/src/components/NoTablesYet.tsx`, `app/src/routes/Sources.tsx`, `app/src/components/TablePane.tsx` (FieldDiff import + merge flash copy)

- [ ] **Step 1: FormField aria-describedby.** When `htmlFor` is set, `hint` exists, and `children` is a single React element, clone it with the hint id:

```tsx
import { Children, cloneElement, isValidElement, useId, type ReactNode } from "react";
// inside the component, replacing the bare `{children}` in the body fragment:
const child =
  htmlFor && hint && Children.count(children) === 1 && isValidElement(children)
    ? cloneElement(children as React.ReactElement<{ "aria-describedby"?: string }>, {
        "aria-describedby": hintId,
      })
    : children;
```

and render `{child}` where `{children}` was. Multiple/opaque children pass through untouched (spec-mandated limit).
- [ ] **Step 2: Button-inside-Link.** In `Sources.tsx` (setup card "Warehouse settings") and `NoTablesYet.tsx` (any `<Link><Button/></Link>`), replace with `useNavigate`: `<Button variant="secondary" onClick={() => navigate(target)}>...</Button>`, importing `useNavigate` from react-router-dom where missing. Same visual, valid HTML.
- [ ] **Step 3: FieldDiff type import.** TablePane: `import { ConflictBanner, FieldDiff }` → `import { ConflictBanner, type FieldDiff }`.
- [ ] **Step 4: Merge flash tense.** Find the post-merge flash in TablePane (grep `re-pointed`); align with the dialog: `... re-pointed · applies on next publish`.
- [ ] **Step 5:** `cd app && bun run typecheck && bun run test && bun run lint` → all clean.
- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "fix(polish): aria-describedby wiring, valid link buttons, type import, merge copy tense

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Final verification, whole-branch review, merge-on-green `[controller + fable judge]`

- [ ] **Step 1: Full bar** — `cd app && bun run typecheck && bun run test && bun run lint` all exit 0; `cd server && bun test` exit 0; Task 2's sweep re-run returns clean. Any failure → reopen the owning task.
- [ ] **Step 2: Whole-branch review** (most capable model) over `git merge-base main HEAD..HEAD` via review-package: cross-task consistency, no stepped-on changes, dispositions from Tasks 3–4 spot-checked against the no-assertion-weakening rule (this is the review's sharpest duty: verify green was earned, not faked).
- [ ] **Step 3: Report** — `docs/superpowers/plans/2026-07-12-cleanup-hardening.REPORT.md`: per-test disposition tables, sweep output, review verdict, anything escalated. Commit it.
- [ ] **Step 4: Merge-on-green (pre-authorized).** If and only if the review verdict is clean (no Critical/Important findings): `git checkout main && git merge cleanup-hardening --no-edit && git branch -d cleanup-hardening`, then re-run the app suite once on main as a post-merge sanity check. Otherwise: stop at the report, leave the branch. Never push.
