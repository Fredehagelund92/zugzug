# UX Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 2026-07-11 UX review findings — plain-language vocabulary, publish safety (preview/confirmation/honest feedback), first-run onboarding, accessibility plumbing, and a minimal second-publisher governance gate.

**Architecture:** Frontend-heavy changes to the React app (`app/src`), one Drizzle migration + commit-route check on the Bun server (`server/src`), and a vocabulary rewrite in CONTEXT.md/CLAUDE.md that every copy task references. No IA restructuring: the settings/integrations/account shells and all file names stay as they are.

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind v4, vitest; Bun server, Postgres via raw SQL + Drizzle migrations.

## Orchestration (read before dispatching)

- **Implementer models:** each task is tagged `[haiku]` (pure string/copy swaps, zero logic) or `[sonnet]` (components, logic, tests, server). Dispatch the implementer subagent with that model.
- **Judge:** after each task, dispatch a reviewer subagent on **opus** (or let the Fable orchestrator review inline) with two questions: (1) does the diff match this task's spec exactly, (2) is the code correct and minimal per CLAUDE.md. The judge may reject; the implementer retries at most twice, then the task is skipped and logged for the user.
- **Order:** Task 1 must complete first (all copy tasks reference the glossary). Tasks 2–12 are independent of each other and of 13–21. Task 24 depends on 23. Task 25 (final sweep) runs last.
- **Branch:** all work on `ux-review-fixes` off `main` (create in Task 1, Step 0). One commit per task minimum.
- **Verification commands:** frontend `cd app && bun run typecheck && bun run test && bun run lint`; server `cd server && bun test`. Every task runs typecheck before committing.

## Global Constraints

**The glossary (locked by the maintainer — every user-facing string must comply):**

| Concept | Use | Never use (user-facing) |
|---|---|---|
| A curated list (dim_<x>) | **table** | dimension (except dbt-facing `dim_`/`map_` names), entity, master table |
| An approved row in a table | **record** (qualify only when ambiguous: "approved record") | canonical record, golden record, master record |
| A messy string scanned from the warehouse | **source value** | raw value, dirty value |
| Assigning a source value to a record | **mapping / map** | match, matching, reconcile, merge (for mappings) |
| The cross-table inbox of unmapped source values | **Review** | Triage, Workbench, inbox, queue |
| Folding drafts into a numbered version | **publish** | commit, sync, merge |
| A staged mapping awaiting publish | **draft** | pending mapping |
| A switchable tenant | **workspace** | tenant, organization |
| A registered warehouse column | **source** | — |

Rationale: plain words a non-technical Scandinavian colleague understands without a glossary. "Standard/canonical/raw/triage" are out.

- Internal identifiers (route paths `/triage`, function names `commit()`, `canonical` in code) are **not** renamed in this plan — only strings users see, plus the two docs. Exception: the `settings/matching` route is renamed (Task 2) because the URL is user-visible in the sidebar.
- Do NOT touch: settings/integrations/account shell structure, `MasterTables.tsx` filename, any file under `server/src/warehouse/`.
- Match existing code style exactly (CLAUDE.md: surgical changes, no adjacent "improvements").
- Commit messages: conventional commits, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Vocabulary foundation — CONTEXT.md + CLAUDE.md `[sonnet]`

**Files:**
- Modify: `CONTEXT.md` (the `## Language` section)
- Modify: `CLAUDE.md` (append a section)

**Interfaces:**
- Produces: the glossary table above, canonicalized in CONTEXT.md. Every later copy task cites it.

- [ ] **Step 0: Create the working branch**

```bash
git checkout -b ux-review-fixes main
```

- [ ] **Step 1: Rewrite the CONTEXT.md Language section**

Replace the existing term entries (Dimension, Canonical record, Raw value, Mapping, Reference table, Draft, Working copy, Publish, Unpublished changes, Triage, Workspace, Source, Warehouse adapter) with:

```markdown
## Language

Plain words first: a non-technical teammate — including non-native English
speakers — must understand every label without a glossary.

**Table**:
A curated list (country, channel, partner) with an approved set of records.
Materialized as a `dim_<x>` table for dbt. ("Dimension" survives only in the
dbt-facing `dim_`/`map_` names and in code identifiers.)
_Avoid_: dimension (user-facing), entity, master table

**Record**:
A single approved row in a table — a `key` + `label` pair plus attributes.
The thing source values map *to*. Qualify as "approved record" only where
ambiguity forces it.
_Avoid_: canonical record, golden record, master record

**Source value**:
A distinct string scanned from a registered warehouse column, awaiting
mapping. It comes from a source; hence the name.
_Avoid_: raw value, dirty value

**Mapping**:
The assignment of a source value to a record. Materialized in `map_<x>`
tables.
_Avoid_: match, matching, reconciliation, merge

**Draft**:
A staged mapping awaiting publish. Lives in app state, invisible to dbt.
Record edits are not drafted — they apply instantly to the working copy.

**Working copy**:
The current, editable state of a table (records + mappings + staged drafts)
as seen in the grid. Not yet what dbt consumes.

**Publish**:
The single act that folds staged drafts and record edits into a new numbered
table version (v17 → v18) and materializes it for dbt.
_Avoid_: commit (internal implementation term), merge, sync

**Review**:
The cross-table inbox of unmapped source values, ordered by frequency.
_Avoid_: triage, workbench, inbox, queue

**Workspace**:
A switchable tenant (like a Linear team) holding its own tables, sources,
and members.
_Avoid_: tenant (implementation term), organization

**Source**:
A registered warehouse column that Zugzug scans for distinct source values.

**Warehouse adapter**:
The interface through which Zugzug reads (and optionally writes) a specific
warehouse technology.
```

Keep every other CONTEXT.md section untouched.

- [ ] **Step 2: Append a vocabulary rule to CLAUDE.md**

Append at the end of `CLAUDE.md`:

```markdown
5. Vocabulary
All user-facing strings follow the Language section in CONTEXT.md. Plain
words only: "table", "record", "source value", "mapping", "Review",
"publish", "workspace". Never surface: canonical, raw, triage, master,
golden, commit, sync, tenant, matching. When writing UI copy, prefer a
concrete example over an abstract term.
```

- [ ] **Step 3: Verify and commit**

```bash
grep -c "Source value" CONTEXT.md   # expect ≥ 1
git add CONTEXT.md CLAUDE.md && git commit -m "docs: plain-language vocabulary (record, source value, Review)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: UI terminology sweep `[haiku]`

**Files:**
- Modify: `app/src/components/AppShell.tsx:384,419,438`
- Modify: `app/src/routes/Dashboard.tsx:270,292`
- Modify: `app/src/routes/Audit.tsx:83` (empty-state body)
- Modify: `app/src/routes/settings/Matching.tsx:16-17`
- Modify: `app/src/main.tsx` (route `matching` → `mapping` + redirect)
- Modify: `app/index.html:6`
- Modify: the settings sidebar file that renders the "Matching" label (find it: `grep -rn '"Matching"' app/src/components/settings app/src/routes/settings`)

**Interfaces:**
- Consumes: Task 1 glossary.
- Produces: nothing programmatic — string-only diff.

- [ ] **Step 1: Apply the exact replacements**

| File:line | Old | New |
|---|---|---|
| `AppShell.tsx:384` | `label: "Workbench"` | `label: "Review"` |
| `AppShell.tsx:419` | `keywords: "inbox queue match reconcile mapping triage"` | `keywords: "review unmapped source values mapping"` |
| `AppShell.tsx:438` | `keywords: "master records"` | `keywords: "tables records"` |
| `Dashboard.tsx:270` | `kicker="Master data"` | `kicker="Tables"` |
| `Dashboard.tsx:292` | `kicker="Master data"` | `kicker="Tables"` |
| `Audit.tsx:83` | `body="Drafts, commits, member changes, and other workspace actions will show up here as they occur."` | `body="Drafts, publishes, member changes, and other workspace actions will show up here as they occur."` |
| `Matching.tsx:16` | `title="Matching defaults"` | `title="Mapping defaults"` |
| `Matching.tsx:17` | `hint="How aggressively Zug Zug matches new values when a scan finds them."` | `hint="How aggressively Zug Zug maps new source values when a scan finds them."` |
| `app/index.html:6` | `<title>Zug Zug — master data</title>` | `<title>Zug Zug — reference tables</title>` |

Also change the settings sidebar label `"Matching"` → `"Mapping"` at the location found by the grep in **Files**.

- [ ] **Step 2: Rename the settings route with a redirect**

In `app/src/main.tsx`, replace:

```tsx
<Route path="matching" element={<Matching />} />
```

with:

```tsx
<Route path="mapping" element={<Matching />} />
<Route path="matching" element={<Navigate to="../mapping" replace />} />
```

Then update the sidebar link target `settings/matching` → `settings/mapping` (same file as the label; also `grep -rn "settings/matching" app/src` and update every hit).

- [ ] **Step 3: Verify no user-facing avoid-terms remain in the touched surfaces**

```bash
cd app && bun run typecheck
grep -rn '"Workbench"\|Master data\|Matching defaults' src && echo "FAIL" || echo "OK"
```

Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(copy): terminology sweep — Review, Mapping, Tables

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: De-jargon first-contact copy `[sonnet]`

**Files:**
- Modify: `app/src/routes/Dashboard.tsx:271-273` (empty-state lede), `:255-258` ("Rows at risk" delta)
- Modify: `app/src/components/CreateTableModal.tsx:266-277` (blank helper), `:294-297` (source helper), `:332-335` (external-id warning)
- Modify: `app/src/components/EngineerModeToggle.tsx` (title copy)

- [ ] **Step 1: Dashboard empty state** — replace the lede at `Dashboard.tsx:272`:

Old:
```
lede="Create a master table to start reconciling messy source values to canonical ones. Each table maps a single dimension (countries, regions, post types, …) from your warehouse."
```
New:
```
lede="Create a table for each list you curate — Country, Channel, Partner. Zug Zug maps messy source values ('US', 'USA', 'United States') to one approved record each, so your dashboards all count the same thing."
```

- [ ] **Step 2: "Rows at risk" KPI** — at `Dashboard.tsx:255-258` change the delta string:

Old: `delta: rowsAtRisk > 0 ? "unmapped warehouse rows" : undefined,`
New: `delta: rowsAtRisk > 0 ? "warehouse rows whose source value has no record yet" : "all warehouse rows are mapped",`

(Also change `delta: undefined` → keep as-is elsewhere; only this KPI changes.)

- [ ] **Step 3: CreateTableModal copy** — three replacements:

Blank mode (`:266-277`): replace the two sentences with:
```
Start with an empty list. You name each record; Zug Zug generates a stable ID from the name.
You can add extra columns (region, currency, owner…) from the table view later — nothing is locked in here.
```

Source mode (`:294-296`): replace
`Seed records from a warehouse column. Each distinct value becomes one record, with a slug ID.`
with:
```
Seed records from a warehouse column. Example: a country column with 'USA', 'Canada' and 'United States' becomes records usa, canada and united_states — you can merge and rename them afterwards.
```

External-id warning (`:332-335`): replace the warning text with:
```
⚠ The ID column is permanent — it becomes the join key in your warehouse mapping tables. Pick a column that never changes (a database ID, not a name).
```

- [ ] **Step 4: EngineerModeToggle** — change its `title` attribute from `"Engineer details on/off"` to `"Show engineering details (IDs, wiring, map tables)"`. Find it: `grep -n "Engineer details" app/src/components/EngineerModeToggle.tsx`.

- [ ] **Step 4b: Dead-end message in CreateTableModal.** Both "No warehouse columns available" blocks (source mode at `:299-305` and external-id mode at `:337+`) currently say only "Configure a source first." Replace the text content (keep the markup/link structure) with:

```
No warehouse columns available yet. An admin connects a database under
Settings → Warehouse; then you pick columns on the [Sources] page.
Until then, start with a blank table — you can wire a source later.
```

where `[Sources]` keeps the existing `<a href={nav.sources}>` link.

- [ ] **Step 5: Verify + commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "feat(copy): de-jargon first-run copy with concrete examples

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Page titles + skip link `[sonnet]`

**Files:**
- Create: `app/src/hooks/usePageTitle.ts`
- Test: `app/src/hooks/usePageTitle.test.ts`
- Modify: `app/src/routes/Dashboard.tsx`, `Triage.tsx`, `Sources.tsx`, `MasterTables.tsx`, `Audit.tsx`, `Login.tsx`, `Signup.tsx`, `routes/settings/General.tsx`
- Modify: `app/src/components/AppShell.tsx` (skip link + `id="main"`)

**Interfaces:**
- Produces: `usePageTitle(title: string): void` and `formatPageTitle(title: string): string`.

- [ ] **Step 1: Write the failing test** (`app/src/hooks/usePageTitle.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { formatPageTitle } from "./usePageTitle";

describe("formatPageTitle", () => {
  it("suffixes the app name", () => {
    expect(formatPageTitle("Review")).toBe("Review · Zug Zug");
  });
  it("trims whitespace", () => {
    expect(formatPageTitle("  Tables ")).toBe("Tables · Zug Zug");
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `cd app && bun run test -- usePageTitle` → FAIL (module not found).

- [ ] **Step 3: Implement** (`app/src/hooks/usePageTitle.ts`):

```ts
import { useEffect } from "react";

export function formatPageTitle(title: string): string {
  return `${title.trim()} · Zug Zug`;
}

/** Sets document.title for the route (WCAG 2.4.2) and restores on unmount. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = formatPageTitle(title);
    return () => {
      document.title = prev;
    };
  }, [title]);
}
```

- [ ] **Step 4: Run test, verify pass** — `bun run test -- usePageTitle` → PASS.

- [ ] **Step 5: Apply per route** — add inside each route component body (first line after hooks):
`Dashboard` → `usePageTitle("Home")`; `Triage` → `usePageTitle("Review")`; `Sources` → `usePageTitle("Sources")`; `MasterTables` → `usePageTitle("Tables")`; `Audit` → `usePageTitle("Activity")`; `Login` → `usePageTitle("Sign in")`; `Signup` → `usePageTitle("Sign up")`; `General` → `usePageTitle("Workspace settings")`. Import: `import { usePageTitle } from "../hooks/usePageTitle";` (adjust relative path for `settings/`).

- [ ] **Step 6: Skip link** — in `AppShell.tsx`, locate the `<main` element (`grep -n "<main" app/src/components/AppShell.tsx`). Add `id="main"` and `tabIndex={-1}` to it, and as the very first child of the shell's root element add:

```tsx
<a
  href="#main"
  className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-surface focus:px-3 focus:py-2 focus:text-ink"
>
  Skip to main content
</a>
```

- [ ] **Step 7: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "feat(a11y): per-route page titles and skip link

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: OptionBuilder a11y + modal backdrop roles `[haiku]`

**Files:**
- Modify: `app/src/components/OptionBuilder.tsx:37-45,68-86`
- Modify: `app/src/components/CommandPalette.tsx:174-176`, `CatalogExplorer.tsx:191-193`, `datagrid/ShortcutsOverlay.tsx:87`, `WorkspaceSwitcher.tsx:112`

- [ ] **Step 1: Chip remove button** — at `OptionBuilder.tsx:37-45` add an aria-label:

```tsx
<button
  key={o.label}
  type="button"
  onClick={() => remove(o.label)}
  title="click to remove"
  aria-label={`Remove option ${o.label}`}
  className="transition-opacity hover:opacity-70"
>
```

- [ ] **Step 2: Swatches to 24px with radio semantics** — replace the swatch row (`:68-86`). Wrap in `role="radiogroup" aria-label="Option color"`; each swatch becomes:

```tsx
<div role="radiogroup" aria-label="Option color" className="flex items-center gap-1">
  {PALETTE_NAMES.map((c) => (
    <button
      key={c}
      type="button"
      role="radio"
      aria-checked={color === c}
      aria-label={`Color ${c}`}
      onClick={() => setColor(c)}
      title={c}
      className={`h-6 w-6 shrink-0 rounded-sm ${color === c ? "ring-1 ring-ink" : ""}`}
      style={{ background: PALETTE[c].bg }}
    />
  ))}
  <button
    type="button"
    role="radio"
    aria-checked={color === null}
    aria-label="No color"
    onClick={() => setColor(null)}
    title="no color"
    className={`h-6 w-6 shrink-0 rounded-sm border border-line-2 ${color === null ? "ring-1 ring-ink" : ""}`}
  />
</div>
```

(This replaces the existing inner `<div className="flex items-center gap-1">` wrapper.)

- [ ] **Step 3: Backdrop divs** — in each of the four files, add `role="presentation"` to the backdrop `<div>` that carries `onClick={onClose}` (or equivalent). Do not add tabIndex or key handlers — Escape already closes these.

- [ ] **Step 4: Verify + commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "fix(a11y): 24px color swatches with radio semantics, labeled remove, backdrop roles

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: FormField label association `[sonnet]`

**Files:**
- Modify: `app/src/components/FormField.tsx`

- [ ] **Step 1: Add optional htmlFor + hint id.** Replace the component with:

```tsx
import { useId, type ReactNode } from "react";

export function FormField({
  label,
  hint,
  status,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  status?: ReactNode;
  /** id of the input inside — when set, renders an explicit label binding. */
  htmlFor?: string;
  children: ReactNode;
}) {
  const hintId = useId();
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-2">{label}</span>
        {status}
      </span>
      {children}
      {hint && (
        <span id={htmlFor ? hintId : undefined} className="text-[12px] text-ink-2">
          {hint}
        </span>
      )}
    </>
  );
  return htmlFor ? (
    <div className="grid gap-1.5">
      <label htmlFor={htmlFor} className="contents">
        {body}
      </label>
    </div>
  ) : (
    <label className="grid gap-1.5">{body}</label>
  );
}
```

Existing call sites keep working (no `htmlFor` → implicit wrapping, unchanged markup semantics).

- [ ] **Step 2: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "fix(a11y): FormField explicit label binding via htmlFor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Signup shows the domain restriction upfront `[haiku]`

**Files:**
- Modify: `app/src/routes/Signup.tsx`

- [ ] **Step 1: Mirror Login's pattern.** `Login.tsx` already fetches auth config and renders (at `Login.tsx:159-163`):

```tsx
{allowedDomain && (
  <p className="text-center text-[11px]" style={{ color: "var(--ink-3)" }}>
    Only @{allowedDomain} accounts can sign up here.
  </p>
)}
```

Find how Login obtains `allowedDomain` (`grep -n "allowedDomain" app/src/routes/Login.tsx`) and replicate the same fetch + the same paragraph in `Signup.tsx`, placed directly under the form's submit button.

- [ ] **Step 2: Verify + commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "fix(signup): show allowed email domain before submit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Viewer role — disabled buttons with explanation `[sonnet]`

**Files:**
- Modify: `app/src/components/NoTablesYet.tsx`
- Modify: `app/src/routes/MasterTables.tsx:151,158`

Currently `MasterTables.tsx:151` passes `onCreateRequested={canEdit ? create.open : undefined}` and NoTablesYet hides the CTA when undefined. Viewers see no explanation.

- [ ] **Step 1: Read `app/src/components/NoTablesYet.tsx`** to find the create CTA rendering.

- [ ] **Step 2: Add a `readOnlyReason` prop.** In NoTablesYet: when `onCreateRequested` is undefined, instead of hiding the button, render it disabled with an explanation line:

```tsx
<Button disabled title="Viewers can't create tables">
  Create your first table
</Button>
<p className="mt-2 text-[12px] text-ink-3">
  You have view-only access. Ask a workspace admin to make you an editor
  (Settings → Members) to create tables.
</p>
```

Keep the enabled branch exactly as it is today. Apply the same pattern to any "Wire a source" CTA in the same component.

- [ ] **Step 3: Verify + commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "fix(roles): viewers see disabled CTAs with an explanation, not nothing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: NoWorkspaceLanding — refresh, copy email, auto-poll `[sonnet]`

**Files:**
- Modify: `app/src/components/NoWorkspaceLanding.tsx`

- [ ] **Step 1: Replace the component body** (current file is 25 lines; full replacement):

```tsx
import { useEffect, useState } from "react";
import { Mark } from "./Mark";
import { Button } from "./Button";
import { authFetch } from "../api";

export function NoWorkspaceLanding() {
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() => window.location.replace("/login"));

  // Poll memberships so the user is dropped in the moment an admin adds them.
  useEffect(() => {
    void authFetch("/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((me: { email?: string } | null) => setEmail(me?.email ?? null));
    const t = window.setInterval(() => {
      void authFetch("/me/memberships")
        .then((r) => (r.ok ? r.json() : []))
        .then((ms: unknown[]) => {
          if (Array.isArray(ms) && ms.length > 0) window.location.reload();
        });
    }, 30_000);
    return () => window.clearInterval(t);
  }, []);

  const copyEmail = () => {
    if (!email) return;
    void navigator.clipboard.writeText(email).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="zz-canvas grid min-h-screen place-items-center p-8">
      <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-8 text-center">
        <Mark className="mx-auto h-10 w-10" />
        <h1 className="font-display text-2xl font-bold text-ink">
          You&apos;re not in any workspace yet.
        </h1>
        <p className="text-ink-2">
          Ask a workspace admin to add your email in Settings → Members. This page checks
          automatically every 30 seconds — you&apos;ll be dropped straight in once they do.
        </p>
        <div className="flex items-center justify-center gap-2">
          {email && (
            <Button variant="secondary" onClick={copyEmail}>
              {copied ? "Copied!" : "Copy my email"}
            </Button>
          )}
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Check now
          </Button>
          <Button onClick={signOut}>Sign out</Button>
        </div>
      </div>
    </div>
  );
}
```

Note: verify the `/auth/me` response shape (`grep -n "auth/me" app/src/components/BootGate.tsx`) and adjust the email extraction if the payload nests the user (e.g. `me.user.email`).

- [ ] **Step 2: Verify + commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "feat(onboarding): workspace-less landing polls memberships, copy-email, check-now

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Audit scope clarity + record history deep link `[sonnet]`

**Files:**
- Modify: `app/src/routes/Audit.tsx` (read `?q=`, lede tweak)
- Modify: `app/src/routes/admin/Audit.tsx` (scope lede)
- Modify: `app/src/main.tsx` (remove the `settings/audit` ghost redirect)
- Modify: `app/src/components/TablePane.tsx` (context-menu "View history" item)

- [ ] **Step 1: URL-driven search in Audit.** In `Audit.tsx` replace `const [query, setQuery] = useState("");` with search-param state:

```tsx
import { useSearchParams } from "react-router-dom";
// inside component:
const [params, setParams] = useSearchParams();
const query = params.get("q") ?? "";
const setQuery = (v: string) =>
  setParams(v ? { q: v } : {}, { replace: true });
```

The existing input already calls `setQuery` — no other change. Change the lede to `lede="Everything that's happened in this workspace, newest first."` → keep, but change `kicker="Workspace"` to `kicker="This workspace"`.

- [ ] **Step 2: Admin audit scope.** In `app/src/routes/admin/Audit.tsx`, set its PageHeader lede/kicker to say "All workspaces" (read the file first; mirror whatever header component it uses).

- [ ] **Step 3: Remove the ghost redirect.** In `main.tsx` delete the line:

```tsx
<Route path="audit" element={<Navigate to="../../audit" replace />} />
```

(the one inside the `settings` route group). Then `grep -rn "settings/audit" app/src` and update any link that pointed there to the tenant audit path.

- [ ] **Step 4: "View history" row action.** In `TablePane.tsx`, find the row context-menu construction (`grep -n "useContextMenu\|ContextMenu" app/src/components/TablePane.tsx`, then read that region). Add a menu item to the row menu:

```tsx
{
  label: "View history",
  onSelect: () => navigate(`${navLinks.audit}?q=${encodeURIComponent(row.label)}`),
},
```

Adapt the exact item shape to the existing `ContextMenu` item type (read `app/src/components/datagrid/ContextMenu.tsx` for the interface) and to how TablePane accesses `navigate`/`navLinks` (it may need `useNavLinks()` from `../lib/use-tenant-navigate` — check imports at the top of the file).

- [ ] **Step 5: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "feat(audit): scope labels, ?q deep link, per-record View history

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Admin console remembers your workspace `[sonnet]`

**Files:**
- Modify: `app/src/components/TenantLayout.tsx` (store last slug)
- Modify: `app/src/components/AdminShell.tsx` ("Back to app" target)

- [ ] **Step 1: Persist the slug.** In `TenantLayout.tsx`, inside the component (after the slug is validated — read the file to find where `tenantSlug` is known-good), add:

```tsx
useEffect(() => {
  if (tenantSlug) sessionStorage.setItem("zz:lastTenant", tenantSlug);
}, [tenantSlug]);
```

- [ ] **Step 2: Use it in AdminShell.** Find the "Back to app" link (`grep -n "Back to app" app/src/components/AdminShell.tsx`) and change its target:

```tsx
const lastTenant = sessionStorage.getItem("zz:lastTenant");
const backTarget = lastTenant ? `/app/${lastTenant}` : "/app";
```

Use `backTarget` in the link's `to=`.

- [ ] **Step 3: Verify + commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "fix(admin): Back to app returns to the last workspace

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Sources ↔ Warehouse cross-link + first-run guidance `[sonnet]`

**Files:**
- Modify: `app/src/routes/Sources.tsx`

- [ ] **Step 1: Read the empty-ledger branch** of `Sources.tsx` (search for where zero sources renders; the header is at `:441-470`).

- [ ] **Step 2: Add a setup card when there are no sources.** In the zero-sources branch render (adapting to local component conventions — `EmptyState` from `../components/EmptyState` is available):

```tsx
<EmptyState
  title="No sources yet"
  body="A source is a warehouse column Zug Zug scans for values. To add one: an admin connects a database under Settings → Warehouse, then you pick columns from the catalog here."
  action={
    <div className="flex items-center gap-2">
      <Button onClick={() => setCatalog(true)}>Browse catalog</Button>
      <Link to={`${settingsBase}/warehouse`}>
        <Button variant="secondary">Warehouse settings</Button>
      </Link>
    </div>
  }
/>
```

Derive `settingsBase` the same way `AppShell.tsx` does (`grep -n "settingsBase" app/src/components/AppShell.tsx` and mirror; likely from `useNavLinks()`). Check `EmptyState`'s actual props (`app/src/components/EmptyState.tsx`) and adapt — if it has no `action` prop, render the buttons in a sibling div below it.

- [ ] **Step 3: Verify + commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "feat(sources): first-run setup guidance and warehouse settings cross-link

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Honest bulk publish in Review (Triage.tsx) `[sonnet]`

**Files:**
- Create: `app/src/lib/commit-outcomes.ts`
- Test: `app/src/lib/commit-outcomes.test.ts`
- Modify: `app/src/routes/Triage.tsx:288-316`

**Interfaces:**
- Produces: `CommitOutcome`, `summarizeOutcomes(outcomes: CommitOutcome[]): { ok: boolean; committed: number; rowsRecovered: number; failed: CommitOutcome[]; message: string }` — Task 15 reuses these.

- [ ] **Step 1: Failing test** (`app/src/lib/commit-outcomes.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { summarizeOutcomes, type CommitOutcome } from "./commit-outcomes";

const ok = (dim: string, n: number): CommitOutcome => ({
  dimId: dim, dimName: dim, committed: n, rowsRecovered: n * 10, error: null,
});
const bad = (dim: string, err: string): CommitOutcome => ({
  dimId: dim, dimName: dim, committed: 0, rowsRecovered: 0, error: err,
});

describe("summarizeOutcomes", () => {
  it("all success", () => {
    const s = summarizeOutcomes([ok("country", 3), ok("channel", 2)]);
    expect(s.ok).toBe(true);
    expect(s.committed).toBe(5);
    expect(s.failed).toHaveLength(0);
    expect(s.message).toBe("✓ 5 changes published · 50 rows recovered");
  });
  it("partial failure names the failed tables", () => {
    const s = summarizeOutcomes([ok("country", 3), bad("channel", "timeout")]);
    expect(s.ok).toBe(false);
    expect(s.committed).toBe(3);
    expect(s.failed).toHaveLength(1);
    expect(s.message).toBe(
      "Published 3 changes, but channel failed (timeout) — its drafts are still staged.",
    );
  });
  it("singulars", () => {
    expect(summarizeOutcomes([{ ...ok("a", 1), rowsRecovered: 1 }]).message).toBe(
      "✓ 1 change published · 1 row recovered",
    );
  });
});
```

- [ ] **Step 2: Run, verify FAIL** — `cd app && bun run test -- commit-outcomes` → module not found.

- [ ] **Step 3: Implement** (`app/src/lib/commit-outcomes.ts`):

```ts
export interface CommitOutcome {
  dimId: string;
  dimName: string;
  committed: number;
  rowsRecovered: number;
  error: string | null;
}

export function summarizeOutcomes(outcomes: CommitOutcome[]): {
  ok: boolean;
  committed: number;
  rowsRecovered: number;
  failed: CommitOutcome[];
  message: string;
} {
  const failed = outcomes.filter((o) => o.error !== null);
  const committed = outcomes.reduce((n, o) => n + o.committed, 0);
  const rowsRecovered = outcomes.reduce((n, o) => n + o.rowsRecovered, 0);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (failed.length === 0) {
    return {
      ok: true,
      committed,
      rowsRecovered,
      failed,
      message: `✓ ${plural(committed, "change")} published · ${plural(rowsRecovered, "row")} recovered`,
    };
  }
  const names = failed.map((f) => `${f.dimName} failed (${f.error})`).join("; ");
  return {
    ok: false,
    committed,
    rowsRecovered,
    failed,
    message: `Published ${plural(committed, "change")}, but ${names} — its drafts are still staged.`,
  };
}
```

- [ ] **Step 4: Run, verify PASS.** Note: the "rows recovered" formatting must match the test exactly (no `toLocaleString` in the helper — display formatting stays in the caller if needed).

- [ ] **Step 5: Rewire `approveAndCommitAll`** in `Triage.tsx:288-316`. Replace the function with:

```tsx
const approveAndCommitAll = async () => {
  setCommitError(null);
  const dimIds = [...new Set(stagedAllDrafts.map((d) => d.dimId))];
  if (dimIds.length === 0) return;
  setCommitting(true);
  try {
    const outcomes: CommitOutcome[] = [];
    for (const id of dimIds) {
      const name = dims.find((d) => d.id === id)?.dimension ?? id;
      try {
        const res = await commit(id);
        outcomes.push({
          dimId: id,
          dimName: name,
          committed: res.committed,
          rowsRecovered: res.rowsRecovered,
          error: null,
        });
      } catch (err) {
        outcomes.push({
          dimId: id,
          dimName: name,
          committed: 0,
          rowsRecovered: 0,
          error: err instanceof Error ? err.message : "unknown error",
        });
      }
    }
    const summary = summarizeOutcomes(outcomes);
    if (summary.ok) {
      if (summary.committed > 0) toast(summary.message);
    } else {
      setCommitError(summary.message);
    }
  } finally {
    setCommitting(false);
  }
};
```

Add imports: `import { summarizeOutcomes, type CommitOutcome } from "../lib/commit-outcomes";`. Delete the old pre-loop `toast(...)` line — no success message may appear before the loop finishes. The existing `commitError` footer banner (Triage.tsx:819-831) already renders the message with a Retry button; Retry re-runs `commitAll`, which now only touches dims that still have staged drafts — correct by construction.

- [ ] **Step 6: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "fix(review): publish feedback is truthful — no success toast before commit, partial failures named

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: PublishPreviewDialog + TablePane wiring `[sonnet]`

**Files:**
- Create: `app/src/components/PublishPreviewDialog.tsx`
- Modify: `app/src/components/TablePane.tsx:452-463` (doPublish), `:823-831` (button)

**Interfaces:**
- Consumes: `Draft` from `../store`, `ConfirmDialog` (`components/ConfirmDialog.tsx` — props: open, title, body, confirmLabel, loading, onConfirm, onCancel).
- Produces: `PublishPreviewDialog` with props `{ open: boolean; groups: PublishGroup[]; publishing: boolean; onDiscardDraft?: (d: Draft) => void; onConfirm: () => void; onCancel: () => void }` where `PublishGroup = { dimId: string; dimName: string; nextVersion: number; drafts: Draft[]; changedKeys: string[] }`. Task 15 reuses it.

- [ ] **Step 1: Create the component** (`app/src/components/PublishPreviewDialog.tsx`):

```tsx
import type { Draft } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { IconArrowRight } from "./Icons";

export interface PublishGroup {
  dimId: string;
  dimName: string;
  nextVersion: number;
  drafts: Draft[];
  changedKeys: string[];
}

const SAMPLE = 50;

/** Pre-publish review: exactly what ships in each table's next version.
 *  Staged mappings are reversible until confirm; record edits are already in
 *  the working copy and listed for awareness only. */
export function PublishPreviewDialog({
  open,
  groups,
  publishing,
  onDiscardDraft,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  groups: PublishGroup[];
  publishing: boolean;
  onDiscardDraft?: (d: Draft) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const totalDrafts = groups.reduce((n, g) => n + g.drafts.length, 0);
  const totalEdits = groups.reduce((n, g) => n + g.changedKeys.length, 0);
  const title =
    groups.length === 1
      ? `Publish v${groups[0].nextVersion} of ${groups[0].dimName}?`
      : `Publish ${groups.length} tables?`;

  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={publishing ? "Publishing…" : "Publish"}
      loading={publishing}
      onConfirm={onConfirm}
      onCancel={onCancel}
      body={
        <div className="max-h-80 space-y-3 overflow-y-auto text-left">
          {groups.map((g) => (
            <div key={g.dimId} className="rounded-sm border border-line bg-surface-2 p-2.5">
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                {g.dimName} → v{g.nextVersion}
              </div>
              {g.drafts.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {g.drafts.slice(0, SAMPLE).map((d) => (
                    <li
                      key={`${d.dimId}::${d.raw}`}
                      className="flex items-center gap-2 font-mono text-[11px] text-ink-2"
                    >
                      <span className="truncate">{d.raw}</span>
                      <IconArrowRight className="h-3 w-3 shrink-0 text-ink-3" />
                      <span className="truncate text-accent">{d.targetLabel ?? "—"}</span>
                      <span className="ml-auto shrink-0 text-ink-3">
                        {d.source === "ai" ? `AI · ${d.confidence ?? "?"}` : d.user.name}
                      </span>
                      {onDiscardDraft && (
                        <button
                          type="button"
                          aria-label={`Don't publish mapping for ${d.raw}`}
                          onClick={() => onDiscardDraft(d)}
                          className="shrink-0 text-ink-3 hover:text-danger"
                        >
                          ✕
                        </button>
                      )}
                    </li>
                  ))}
                  {g.drafts.length > SAMPLE && (
                    <li className="font-mono text-[11px] text-ink-3">
                      … and {g.drafts.length - SAMPLE} more
                    </li>
                  )}
                </ul>
              )}
              {g.changedKeys.length > 0 && (
                <div className="mt-1.5 font-mono text-[11px] text-ink-3">
                  + {g.changedKeys.length} record edit{g.changedKeys.length === 1 ? "" : "s"} already
                  in the working copy ({g.changedKeys.slice(0, 8).join(", ")}
                  {g.changedKeys.length > 8 ? ", …" : ""})
                </div>
              )}
            </div>
          ))}
          <p className="text-[12px] text-ink-3">
            Publishing creates {totalDrafts + totalEdits === 1 ? "a new version" : "new versions"}{" "}
            that dbt consumers pick up immediately. Staged mappings can still be removed here;
            record edits are listed for awareness.
          </p>
        </div>
      }
    />
  );
}
```

- [ ] **Step 2: Wire into TablePane.** In `TablePane.tsx`:

Add state near the other dialog state (~line 243): `const [publishPreview, setPublishPreview] = useState(false);`

Change the publish button (`:827`) from `onClick={() => void doPublish()}` to `onClick={() => setPublishPreview(true)}`.

Below the existing ConfirmDialogs (~line 1540+), render:

```tsx
<PublishPreviewDialog
  open={publishPreview}
  publishing={publishing}
  groups={
    pubState
      ? [
          {
            dimId: activeId,
            dimName: dim.dimension,
            nextVersion: pubState.version + 1,
            drafts: Object.values(drafts).filter(
              (d) => d.dimId === activeId && d.status === "mapped",
            ),
            changedKeys: pubState.changedKeys,
          },
        ]
      : []
  }
  onDiscardDraft={(d) => void discardDraft(d.dimId, d.raw)}
  onConfirm={() => {
    void doPublish().then(() => setPublishPreview(false));
  }}
  onCancel={() => setPublishPreview(false)}
/>
```

Adapt local names by reading TablePane's existing imports/state: the drafts store hook (`useDrafts`), `discardDraft` (import from `../store`; check its exact signature — `grep -n "export.*discardDraft" app/src/store.ts`), the active dim id variable, and `dim.dimension` for the display name. `doPublish` itself is unchanged.

- [ ] **Step 3: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "feat(publish): preview dialog with staged mappings and record edits before commit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 15: Publish preview in Review (Triage) `[sonnet]`

**Files:**
- Modify: `app/src/routes/Triage.tsx`

**Interfaces:**
- Consumes: `PublishPreviewDialog`, `PublishGroup` (Task 14); `fetchPublishState` from `../store` (`(dimId) => Promise<{ version; pendingDrafts; changedKeys; … }>`); `summarizeOutcomes` (Task 13).

- [ ] **Step 1: Add preview state + loader** in `TriageInner`:

```tsx
const [preview, setPreview] = useState<PublishGroup[] | null>(null);

const openPublishPreview = async () => {
  const dimIds = [...new Set(stagedAllDrafts.map((d) => d.dimId))];
  if (dimIds.length === 0) return;
  const states = await Promise.all(dimIds.map((id) => fetchPublishState(id)));
  setPreview(
    dimIds.map((id, i) => ({
      dimId: id,
      dimName: dims.find((d) => d.id === id)?.dimension ?? id,
      nextVersion: states[i].version + 1,
      drafts: stagedAllDrafts.filter((d) => d.dimId === id),
      changedKeys: states[i].changedKeys,
    })),
  );
};
```

Add `fetchPublishState` to the existing `../store` import list and `import { PublishPreviewDialog, type PublishGroup } from "../components/PublishPreviewDialog";`.

- [ ] **Step 2: Route the two publish triggers through the preview.** Every call site that currently invokes `approveAndCommitAll` directly (the footer button at `Triage.tsx:966`, the `commitAll` prop at `:428`, the `onCommitAll` prop at `:401`, and the ⌘↵ handler that flows into `onCommitAll`) must call `openPublishPreview` instead. Render at the end of `TriageInner`'s JSX:

```tsx
{preview && (
  <PublishPreviewDialog
    open
    groups={preview}
    publishing={committing}
    onDiscardDraft={(d) => {
      void discardDraft(d.dimId, d.raw);
      setPreview((p) =>
        p
          ?.map((g) =>
            g.dimId === d.dimId
              ? { ...g, drafts: g.drafts.filter((x) => x.raw !== d.raw) }
              : g,
          )
          .filter((g) => g.drafts.length > 0 || g.changedKeys.length > 0) ?? null,
      );
    }}
    onConfirm={() => {
      void approveAndCommitAll().then(() => setPreview(null));
    }}
    onCancel={() => setPreview(null)}
  />
)}
```

Check `discardDraft`'s exact signature in `store.ts` and adapt. `approveAndCommitAll` stays as Task 13 built it.

- [ ] **Step 3: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "feat(review): cross-table publish goes through the preview dialog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 16: Merge & retire dialogs show blast radius `[sonnet]`

**Files:**
- Modify: `app/src/components/TablePane.tsx:1500-1518` (bulk remove body), `:1571-1593` (merge body)

`CanonicalValue` (`app/src/data.ts:13-17`) already carries `variants?: number` — the count of source values mapped to that record. No server work needed.

- [ ] **Step 1: Merge dialog.** In the merge ConfirmDialog body (`:1571-1593`), compute and show the re-point count. Where the losing records are known (read the surrounding code for the selected-keys variable), add:

```tsx
const loserVariants = losers.reduce(
  (n, k) => n + (dim.canonical.find((c) => c.key === k)?.variants ?? 0),
  0,
);
```

and extend the body copy to:

```
{loserCount} record{s} will be merged into [survivor].
{loserVariants} source value{s} currently mapped to them will re-point to [survivor] on next publish.
```

If `loserVariants === 0` and every `variants` is `undefined` (data not loaded), fall back to the current copy — never show a false "0".

- [ ] **Step 2: Bulk remove dialog.** Same pattern at `:1500-1518`:

```
{count} record{s} will be retired.
{variantSum} source value{s} will lose their record and reappear in Review.
Use Undo if you change your mind.
```

with the same `undefined`-guard.

- [ ] **Step 3: Verify + commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "feat(grid): merge/retire dialogs state how many source values are affected

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 17: Conflict banner shows what changed `[sonnet]`

**Files:**
- Modify: `app/src/components/ConflictBanner.tsx`
- Modify: `app/src/components/TablePane.tsx` (conflict wiring ~`:269-288`)

- [ ] **Step 1: Extend ConflictBannerProps** with an optional diff:

```tsx
export interface FieldDiff {
  field: string;
  theirs: string;
  yours: string;
}
```

Add `diff?: FieldDiff[]` to the props, and render below the existing message when present:

```tsx
{diff && diff.length > 0 && (
  <ul className="w-full space-y-0.5 font-mono text-[11px] text-warn/90">
    {diff.map((d) => (
      <li key={d.field}>
        <span className="text-warn/70">{d.field}:</span> theirs “{d.theirs}” · yours “{d.yours}”
      </li>
    ))}
  </ul>
)}
```

Rename the buttons for clarity: `"Keep editing"` → `"Keep my version"`, `"Refresh row"` → `"Use theirs"`. Behavior unchanged.

- [ ] **Step 2: Build the diff in TablePane.** Read the conflict-handling region (~`:269-288`) to find where the 409 is caught and what data is available. The store refreshes the dim on conflict, so the server row is available via the canonical list. Build:

```tsx
const serverRow = getCanonical(activeId, conflictedKey);
const diff: FieldDiff[] = [];
if (serverRow && localPendingValue !== undefined && serverRow.label !== localPendingValue) {
  diff.push({ field: "label", theirs: serverRow.label, yours: String(localPendingValue) });
}
```

Adapt to what the conflict state actually captures (the attempted local value must be recorded in the conflict state when the 409 is caught — extend that state object if it currently only stores `updatedBy`/`updatedAt`). If the attempted value genuinely isn't recoverable at the catch site, pass no diff for field edits and only pass it for label renames (where the attempted label is the edit-input value). Scope discipline: do not restructure the save pipeline for this.

- [ ] **Step 3: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "feat(grid): conflict banner shows theirs-vs-yours and clearer actions

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 18: Ordering switch offers an order export `[haiku]`

**Files:**
- Modify: `app/src/components/TablePane.tsx:1607-1618` (ordering ConfirmDialog)

- [ ] **Step 1:** In the `orderingConfirm === "derived"` dialog body, after the existing warning text, add:

```tsx
<button
  type="button"
  onClick={exportToCSV}
  className="mt-2 text-[12px] text-accent hover:underline"
>
  Export the current order to CSV first
</button>
```

`exportToCSV` already exists in TablePane (the Export button uses it — `grep -n "exportToCSV" app/src/components/TablePane.tsx`); reuse it as-is (row order in the export follows the current manual order).

- [ ] **Step 2: Verify + commit**

```bash
cd app && bun run typecheck
git add -A && git commit -m "feat(grid): offer order export before switching to derived ordering

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 19: CSV import preview with column remapping `[sonnet]`

**Files:**
- Create: `app/src/components/ImportPreviewDialog.tsx`
- Test: `app/src/lib/csv.test.ts` (extend if it exists, else create)
- Modify: `app/src/lib/csv.ts`, `app/src/components/TablePane.tsx:300-311`

- [ ] **Step 1: Read `app/src/lib/csv.ts` fully** — understand `prepareImport`'s return shape and how TablePane consumes it.

- [ ] **Step 2: Failing tests for a remap function** (in `app/src/lib/csv.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { applyColumnMap, type ColumnTarget } from "./csv";

describe("applyColumnMap", () => {
  const headers = ["ID", "Name", "Region"];
  const rows = [["us", "United States", "NA"]];
  it("maps chosen columns to key/label/field", () => {
    const map: ColumnTarget[] = [{ kind: "key" }, { kind: "label" }, { kind: "field", fieldId: "region" }];
    expect(applyColumnMap(headers, rows, map)).toEqual([
      { key: "us", label: "United States", fields: { region: "NA" } },
    ]);
  });
  it("ignores ignored columns and derives key from label when unmapped", () => {
    const map: ColumnTarget[] = [{ kind: "ignore" }, { kind: "label" }, { kind: "ignore" }];
    const out = applyColumnMap(headers, rows, map);
    expect(out[0].key).toBe("united_states");
    expect(out[0].fields).toEqual({});
  });
});
```

- [ ] **Step 3: Run, verify FAIL.** Then implement in `csv.ts`:

```ts
export type ColumnTarget =
  | { kind: "key" }
  | { kind: "label" }
  | { kind: "field"; fieldId: string }
  | { kind: "ignore" };

export interface MappedImportRow {
  key: string;
  label: string;
  fields: Record<string, string>;
}

export function applyColumnMap(
  headers: string[],
  rows: string[][],
  map: ColumnTarget[],
): MappedImportRow[] {
  return rows.map((r) => {
    let key = "";
    let label = "";
    const fields: Record<string, string> = {};
    map.forEach((t, i) => {
      const v = r[i] ?? "";
      if (t.kind === "key") key = v;
      else if (t.kind === "label") label = v;
      else if (t.kind === "field") fields[t.fieldId] = v;
    });
    if (!key && label) key = slug(label);
    return { key, label, fields };
  });
}
```

Reuse the module's existing `slug` import (check what `csv.ts`/`prepareImport` uses for key derivation and use the same function).

- [ ] **Step 4: Run, verify PASS.**

- [ ] **Step 5: Build the dialog.** `ImportPreviewDialog.tsx` — built on `ConfirmDialog` like Task 14. Body renders: one `<select>` per CSV header (options: `Key`, `Label` / `Record name`, one per table field label, `Ignore`), defaulted from `prepareImport`'s auto-mapping; below it a preview table of the first 3 rows *after* mapping (`applyColumnMap(headers, rows.slice(0, 3), map)`), plus a warning line when a mapped field's type won't accept a sampled value (reuse whatever coercion check `csv.ts` applies — surface it instead of silently nulling: "3 values in 'Revenue' aren't numbers and will import empty."). Confirm button: `Import N records`.

- [ ] **Step 6: Wire TablePane** — where `prepareImport`'s summary currently feeds the existing confirm modal (`:300-311`), open `ImportPreviewDialog` instead, passing headers/rows/auto-map; on confirm, run the import with `applyColumnMap`'s output through the same `importRows` path used today.

- [ ] **Step 7: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "feat(import): CSV preview with per-column remapping and coercion warnings

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 20: Grid quick search `[sonnet]`

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx` (new optional prop), `app/src/components/TablePane.tsx` (toolbar input)

- [ ] **Step 1: Read `app/src/components/datagrid/types.ts` and `DataGrid.tsx`** — find where rows pass through the `filterSet` pipeline.

- [ ] **Step 2: Add a `quickFilter` prop to DataGrid:**

```tsx
/** Free-text filter — case-insensitive contains over the label column. */
quickFilter?: string;
```

In the row-filtering memo, before/after the filterSet application add:

```tsx
const q = quickFilter?.trim().toLowerCase();
const searched = q
  ? filtered.filter((r) => String(r.label ?? "").toLowerCase().includes(q))
  : filtered;
```

Adapt the row accessor to the grid's actual row type (rows may be generic — if `label` isn't guaranteed, accept a `quickFilterAccessor?: (row: Row) => string` prop alongside and have TablePane pass `(r) => r.label`).

- [ ] **Step 3: Toolbar input in TablePane** — add state `const [quickFilter, setQuickFilter] = useState("");` and render in the grid toolbar (next to Export/Import buttons at ~`:820`):

```tsx
<label className="relative">
  <span className="sr-only">Search records</span>
  <input
    value={quickFilter}
    onChange={(e) => setQuickFilter(e.target.value)}
    placeholder="Search records…"
    className="w-[180px] rounded-sm border border-line-2 bg-surface px-2 py-1 font-mono text-[11.5px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
  />
</label>
```

Pass `quickFilter` (and accessor if needed) to the `DataGrid` in Records mode.

- [ ] **Step 4: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "feat(grid): quick search over record labels

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 21: Rescan vs staged drafts — verify, then guard `[sonnet]`

**Files:**
- Possibly modify: `app/src/components/TablePane.tsx:583-600` (derive/rescan), `app/src/store.ts` (deriveCanonical)

- [ ] **Step 1: Investigate.** Read `store.ts` `deriveCanonical` (~`:826-849`) and the server handler it calls. Determine: does a rescan consume/auto-apply staged (unpublished) drafts, or only published mappings? Write your conclusion in the task report.

- [ ] **Step 2 (only if drafts are consumed): Guard.** Before triggering derive in TablePane, check for staged drafts on the table and warn via the existing ConfirmDialog pattern:

```
Rescan now?
You have {n} staged draft{s} on this table. Rescanning applies them to the
working copy — they'll no longer be listed for review before publish.
[Cancel] [Rescan anyway]
```

- [ ] **Step 2 (if drafts are NOT consumed):** no code change; extend the rescan toast to say `· staged drafts untouched` so the state is explicit.

- [ ] **Step 3: Verify + commit** (message depends on branch taken; prefix `fix(scan):`).

---

### Task 22: First-user admin race fix `[sonnet]`

**Files:**
- Modify: `server/src/auth-password.ts:88-115`
- Test: `server/src/auth.test.ts` (extend)

- [ ] **Step 1: Read `server/src/auth.test.ts`** to learn the test harness (how it stubs Postgres / spins the route).

- [ ] **Step 2: Serialize the first-admin decision.** Wrap the count-check + inserts in a transaction holding an advisory lock. The file currently does (at `:94-96`):

```ts
// NOTE: userCount===0 is race-vulnerable under concurrent first-signups — both
// could see count=0 and both become admin. Acceptable for v0.2; no lock added.
const role = userCount === 0 ? "admin" : "editor";
```

Replace with a transactional block using the codebase's pg helpers (check `server/src/pg.ts` for a transaction helper; if only `pgRun`/`pgGet` exist, issue explicit `BEGIN`/`COMMIT` through the same client — the helper must support a single-connection scope; if it doesn't, add `pgTx(fn)` in `pg.ts` following its existing style):

```ts
const role = await pgTx(async (tx) => {
  await tx.run(`SELECT pg_advisory_xact_lock(hashtext('zz:first-admin'))`);
  const { count } = await tx.get<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${pg("users")}`,
  );
  return count === 0 ? "admin" : "editor";
});
```

Move the user + membership INSERTs inside the same transaction so the lock covers them. Delete the stale NOTE comment.

- [ ] **Step 3: Test** — add to `auth.test.ts` a test that two sequential signups yield roles `admin` then `editor` (full concurrency simulation is out of scope; the lock is the mechanism, the test guards the role logic):

```ts
it("only the first signup becomes admin", async () => {
  const a = await signup("a@x.dk");
  const b = await signup("b@x.dk");
  expect(await roleOf(a)).toBe("admin");
  expect(await roleOf(b)).toBe("editor");
});
```

Adapt `signup`/`roleOf` to the harness's existing helpers.

- [ ] **Step 4: Verify + commit**

```bash
cd server && bun test
git add -A && git commit -m "fix(auth): serialize first-admin assignment with advisory lock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 23: Review gate — server `[sonnet]`

**Files:**
- Create: `server/drizzle/migrations/0035_require_second_publisher.sql`
- Modify: `server/drizzle/schema.ts:215-231`, `server/src/repo-shared.ts:271-275` (Preferences), `server/src/repo-meta.ts:95-130` (get/setPreferences), `server/src/server.ts` (~`:765` preferences route, ~`:1295` commit route)
- Test: `server/src/repo-drafts.test.ts` or nearest existing commit test (`grep -rln "commit" server/src/*.test.ts`)

**Interfaces:**
- Produces: `Preferences.requireSecondPublisher: boolean` (server + wire format); commit rejects with `AppError("SECOND_PUBLISHER_REQUIRED", …, 403)` when enabled and any mapped draft was authored by the committer.

- [ ] **Step 1: Migration** (`0035_require_second_publisher.sql`; match the schema-qualified table naming used by `0034_dimension_owner.sql` — read it first):

```sql
ALTER TABLE "zugzug_app"."preferences"
  ADD COLUMN IF NOT EXISTS "require_second_publisher" boolean NOT NULL DEFAULT false;
```

- [ ] **Step 2: Schema + types.** Add to the `preferences` table in `schema.ts` (match column style of its neighbors): `require_second_publisher: boolean("require_second_publisher").notNull().default(false),`. Add `requireSecondPublisher: boolean;` to `Preferences` in `repo-shared.ts`. Extend `getPreferences` (select + default `false`) and `setPreferences` (insert/upsert column) in `repo-meta.ts` following the exact existing SQL pattern.

- [ ] **Step 3: Failing test** (in the commit-covering test file found above):

```ts
it("rejects self-publish when requireSecondPublisher is on", async () => {
  await setPreferences({ ...(await getPreferences(T)), requireSecondPublisher: true }, T);
  await stageDraft(dimId, "usa", "United States", alice);      // alice authors
  await expect(repo.commit(dimId, alice)).rejects.toThrow(/second/i); // alice can't publish
  const res = await repo.commit(dimId, bob);                   // bob can
  expect(res.committed).toBe(1);
});
```

Adapt helpers to the harness. Run → FAIL.

- [ ] **Step 4: Enforce in commit.** In `repo-drafts.ts` `commit(id, me)` (or in the route at `server.ts:1295` if drafts aren't loaded until inside — put the check where the mapped drafts are first available), before folding:

```ts
const prefs = await getPreferences(tenantId);
if (prefs.requireSecondPublisher) {
  const own = mappedDrafts.filter((d) => d.userId === me.id);
  if (own.length > 0) {
    throw new AppError(
      "SECOND_PUBLISHER_REQUIRED",
      `${own.length} of these drafts are yours — another editor must publish them`,
      403,
    );
  }
}
```

Adapt names (`tenantId`, `mappedDrafts`, draft author field) to the actual code — read `repo-drafts.ts:288-350` first.

- [ ] **Step 5: Wire the preferences route** (`server.ts:765` GET/PUT) to round-trip the new key. Run tests → PASS.

- [ ] **Step 6: Commit**

```bash
cd server && bun test
git add -A && git commit -m "feat(governance): optional second-publisher requirement on publish

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 24: Review gate — frontend `[sonnet]`

**Files:**
- Modify: `app/src/store.ts:253` (Preferences default), `app/src/routes/settings/Matching.tsx` (toggle UI), `app/src/routes/Triage.tsx` + `app/src/components/TablePane.tsx` (error surfacing)

**Interfaces:**
- Consumes: Task 23's `requireSecondPublisher` wire field and `SECOND_PUBLISHER_REQUIRED` error code.

- [ ] **Step 1: Type + default.** Extend the client `Preferences` (find it: `grep -n "publishThreshold" app/src/store.ts app/src/data.ts`) with `requireSecondPublisher: boolean`, default `false` at `store.ts:253`.

- [ ] **Step 2: Toggle in Mapping settings.** In `Matching.tsx` add a second FormField under the thresholds (admin-gated like the workspace-delete actions — use `can(tenant, "settings.general.edit")`, which is admin-only per `permissions.ts`):

```tsx
<FormField
  label="Four eyes on publish"
  hint="When on, a draft's author can't publish it — a second editor must. Applies to mapping drafts only; record edits are not drafted."
>
  <Checkbox
    checked={prefs.requireSecondPublisher}
    disabled={!can(tenant, "settings.general.edit")}
    onChange={(v) =>
      void setPreferences({ ...prefs, requireSecondPublisher: v }).then(() =>
        invalidate.tenant(tenant.slug),
      )
    }
    label="Require a second publisher"
  />
</FormField>
```

Read `app/src/components/Checkbox.tsx` for its actual prop names and adapt.

- [ ] **Step 3: Surface the rejection.** The server's 403 message already flows into `commitError` (Triage) and TablePane's publish error path. Verify the API layer preserves error messages (`grep -n "AppError\|error.message" app/src/api.ts`); if the code arrives as a structured `{ error: "SECOND_PUBLISHER_REQUIRED" }`, map it in both catch sites to: `"These drafts need a second publisher — another editor has to press Publish (workspace setting: Four eyes on publish)."`

- [ ] **Step 4: Verify + commit**

```bash
cd app && bun run typecheck && bun run test
git add -A && git commit -m "feat(governance): four-eyes toggle and clear self-publish rejection message

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 25: Final sweep + judge review `[sonnet implementer, opus/fable judge]`

**Files:** none new — verification only.

- [ ] **Step 1: Avoid-term sweep over user-facing strings**

```bash
cd app && grep -rn --include="*.tsx" -E '"[^"]*(canonical|raw value|triage|Workbench|master (data|record|table)|golden)[^"]*"' src | grep -vi "// \|test\|\.test\." || echo "CLEAN"
```

Judge every hit: internal identifiers stay, user-facing strings get fixed on the spot (glossary from Task 1).

- [ ] **Step 2: Full verification**

```bash
cd app && bun run typecheck && bun run test && bun run lint
cd ../server && bun test
```

All green, or the failing task gets reopened.

- [ ] **Step 3: Judge pass (opus or Fable orchestrator).** Diff review of the whole branch against this plan: `git diff main...ux-review-fixes`. Checklist: every task's spec implemented or explicitly logged as skipped; no scope creep into the excluded restructures; copy complies with the glossary; no success message ever precedes the operation it reports.

- [ ] **Step 4: Summary commit + handoff note** — write `docs/superpowers/plans/2026-07-11-ux-review-fixes.REPORT.md` listing per task: done/skipped, deviations, and anything needing the maintainer's eyes (especially Task 21's investigation verdict and any Task 17 scope reductions). Commit it. Do NOT merge to main or push — the maintainer reviews in the morning.
