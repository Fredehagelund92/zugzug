# Frontend polish for review-readiness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Zug Zug review-ready for non-technical (Sheets-refugee) users by hiding warehouse jargon behind an opt-in engineer-mode toggle, replacing the single confidence threshold with a two-band auto-publish/suggest picker plus per-source scheduled scans, and fixing the small batch of bugs + accessibility gaps that would embarrass us on a cold walkthrough.

**Architecture:** A new `useEngineerMode()` hook + provider gates engineer-targeted UI throughout the app; off by default, persisted to localStorage, toggled from the topbar + Settings. Backend gains a single-row `app.preferences` table and a per-source `schedule` column; the server's existing scan handler auto-stages drafts above the publish threshold, and a `setInterval` loop in `server.ts` triggers scheduled scans. UI changes are scoped per-file with no cross-file refactors.

**Tech Stack:** React 18 + TypeScript + Vite + Tailwind v4 (app) · Bun + `@duckdb/node-api` + Postgres (server). No test framework installed — verification = `bun run typecheck` + manual UI walkthrough + `verify-*.ts` scripts for backend logic (following the existing `server/src/verify-eid.ts` pattern).

**Spec:** `docs/superpowers/specs/2026-06-03-frontend-polish-design.md`

---

## File structure

**New files (app):**
- `app/src/lib/engineer-mode.ts` — `useEngineerMode()` hook + `EngineerModeProvider`, localStorage-backed
- `app/src/components/EngineerModeToggle.tsx` — `</>` toggle for the topbar
- `app/src/components/NoDimensionsYet.tsx` — shared empty-state component
- `app/src/components/BootGate.tsx` — loading skeleton + styled error fallback that wraps `initStore()`
- `app/src/components/ThresholdRange.tsx` — two-thumb confidence-band slider
- `app/src/components/ScanScheduleMenu.tsx` — per-source schedule picker

**New files (server):**
- `server/src/verify-polish.ts` — verification script for the preferences + schedule additions

**Modified files (app):**
- `app/src/main.tsx` — boot via `BootGate` instead of top-level await
- `app/src/store.ts` — add `usePreferences`, `setPreferences`, `setSourceSchedule` + preload preferences in `initStore`
- `app/src/components/AppShell.tsx` — sidebar footer, nav labels, topbar (remove search, add engineer toggle, keep theme toggle, wrap in EngineerModeProvider)
- `app/src/components/DimensionPicker.tsx` — gate technical subtitle + friendly create-form copy
- `app/src/routes/Mapping.tsx` — gate header row + SQL button + commit footer copy + crash guard + microcopy + confidence color + auto-match result chip
- `app/src/routes/MasterTables.tsx` — gate header row + crash guard + bulk-merge hint
- `app/src/routes/Sources.tsx` — schedule menu integration + microcopy + "last scanned" copy
- `app/src/routes/Settings.tsx` — Connections rework, replace single slider with `ThresholdRange`, remove duplicate theme picker, add engineer toggle row

**Modified files (server):**
- `server/src/schema.ts` — `app.preferences` table + `schedule` column on `dimension_source`
- `server/src/repo.ts` — `getPreferences`, `setPreferences`, `setSourceSchedule`, auto-stage drafts on scan
- `server/src/server.ts` — preferences endpoints, source-schedule endpoint, `setInterval` scheduler loop

---

## Task 1: `useEngineerMode` hook + provider

**Files:**
- Create: `app/src/lib/engineer-mode.ts`

- [ ] **Step 1: Implement the hook + provider**

```tsx
// app/src/lib/engineer-mode.ts
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const KEY = "zugzug:engineer-mode";

interface Ctx { engineer: boolean; setEngineer: (on: boolean) => void }

const EngineerModeCtx = createContext<Ctx>({ engineer: false, setEngineer: () => {} });

export function EngineerModeProvider({ children }: { children: ReactNode }) {
  const [engineer, setEngineerState] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(KEY) === "1";
  });
  useEffect(() => {
    localStorage.setItem(KEY, engineer ? "1" : "0");
    document.documentElement.dataset.engineer = engineer ? "1" : "0";
  }, [engineer]);
  return <EngineerModeCtx.Provider value={{ engineer, setEngineer: setEngineerState }}>{children}</EngineerModeCtx.Provider>;
}

export function useEngineerMode(): Ctx { return useContext(EngineerModeCtx); }
```

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck`
Expected: PASS (no usages yet, just the file existing)

- [ ] **Step 3: Commit**

```bash
git add app/src/lib/engineer-mode.ts
git commit -m "Add useEngineerMode hook + provider (localStorage-backed)"
```

---

## Task 2: `EngineerModeToggle` component

**Files:**
- Create: `app/src/components/EngineerModeToggle.tsx`

- [ ] **Step 1: Implement the toggle button**

```tsx
// app/src/components/EngineerModeToggle.tsx
import { useEngineerMode } from "../lib/engineer-mode";
import { cx } from "../lib/cx";

export function EngineerModeToggle() {
  const { engineer, setEngineer } = useEngineerMode();
  return (
    <button
      type="button"
      onClick={() => setEngineer(!engineer)}
      aria-label="Toggle engineer details"
      aria-pressed={engineer}
      title={engineer ? "Engineer details on — click to hide" : "Engineer details off — click to show"}
      className={cx(
        "grid h-8 w-8 place-items-center rounded-sm border font-mono text-[11px] transition-colors",
        engineer ? "border-accent bg-accent-wash text-accent" : "border-line-2 text-ink-3 hover:border-ink-3 hover:text-ink",
      )}
    >
      &lt;/&gt;
    </button>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck` → PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/components/EngineerModeToggle.tsx
git commit -m "Add EngineerModeToggle component (</> chip for topbar)"
```

---

## Task 3: Wrap the app in `EngineerModeProvider` + add toggle to topbar

**Files:**
- Modify: `app/src/main.tsx`
- Modify: `app/src/components/AppShell.tsx`

- [ ] **Step 1: Wrap router in `EngineerModeProvider` (main.tsx)**

In `app/src/main.tsx` around the `<BrowserRouter>`:

```tsx
import { EngineerModeProvider } from "./lib/engineer-mode";

// inside createRoot(...).render(...)
<React.StrictMode>
  <EngineerModeProvider>
    <BrowserRouter>
      {/* existing Routes */}
    </BrowserRouter>
  </EngineerModeProvider>
</React.StrictMode>
```

- [ ] **Step 2: Add `<EngineerModeToggle />` to the topbar (AppShell.tsx)**

In `app/src/components/AppShell.tsx`, in the header's right-side cluster (after `<ThemeToggle />`):

```tsx
import { EngineerModeToggle } from "./EngineerModeToggle";

// in the header's right cluster (after ThemeToggle):
<EngineerModeToggle />
```

- [ ] **Step 3: Typecheck**

Run: `cd app && bun run typecheck` → PASS

- [ ] **Step 4: Manual verify**

Start dev: `cd app && bun run dev` (and the server in another shell if not already up). Open the app. Confirm the `</>` button appears in the topbar; clicking it toggles `<html data-engineer="1">` in DevTools.

- [ ] **Step 5: Commit**

```bash
git add app/src/main.tsx app/src/components/AppShell.tsx
git commit -m "Wire EngineerModeProvider + topbar toggle"
```

---

## Task 4: Apply engineer mode to AppShell (sidebar footer + nav labels + remove search)

**Files:**
- Modify: `app/src/components/AppShell.tsx`

- [ ] **Step 1: Rename nav labels + use engineer mode in sidebar footer**

In `app/src/components/AppShell.tsx`:

```tsx
import { useEngineerMode } from "../lib/engineer-mode";

export function AppShell() {
  const { engineer } = useEngineerMode();
  const dims = useDimensions();
  const totalNew = dims.reduce((n, s) => n + s.values.filter((v) => v.status === "new").length, 0);
  const nav = [
    { to: "/app", label: "Dashboard", Icon: IconDashboard, end: true },
    { to: "/app/mapping", label: "Match values", Icon: IconMapping, count: totalNew },
    { to: "/app/sources", label: "Sources", Icon: IconSources, count: undefined },
    { to: "/app/tables", label: "Master lists", Icon: IconTables, count: dims.length },
    { to: "/app/settings", label: "Settings", Icon: IconSettings },
  ];
  // ...
```

Replace the sidebar status footer (`flex items-center gap-2 font-mono text-[11px] text-ink` block ~line 80) with:

```tsx
<div className="border-t border-line p-4">
  <div className="flex items-center gap-2 font-mono text-[11px] text-ink">
    <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" />
    {engineer ? "analytics.duckdb" : "Connected to warehouse"}
  </div>
  <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-ink-3">
    <span>{engineer ? "warehouse · live" : "live"}</span>
    <span>{dims.length} {engineer ? "tables" : "master lists"}</span>
  </div>
</div>
```

- [ ] **Step 2: Remove the unwired topbar search input**

In the same file, replace the `<label className="flex w-full max-w-md items-center gap-2 …">` search input block with an empty spacer:

```tsx
<div className="flex-1" />
```

(Remove the `IconSearch` import if it becomes unused — check usages with grep first.)

- [ ] **Step 3: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Browse: confirm sidebar labels say "Match values" / "Master lists"; sidebar footer says "Connected to warehouse" when engineer mode is off, "analytics.duckdb" when on; topbar search is gone.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/AppShell.tsx
git commit -m "Engineer-gate sidebar footer + rename nav labels + remove topbar search"
```

---

## Task 5: Apply engineer mode to DimensionPicker

**Files:**
- Modify: `app/src/components/DimensionPicker.tsx`

- [ ] **Step 1: Replace technical subtitle + create-form copy with friendly versions when engineer mode is off**

```tsx
import { useEngineerMode } from "../lib/engineer-mode";

export function DimensionPicker({ dims, activeId, onSelect, onCreate }: /* ... */) {
  const { engineer } = useEngineerMode();
  // ... existing state ...
  const aStats = stats(active);

  return (
    <div ref={ref} className="relative inline-block">
      {/* trigger */}
      <button /* ... */>
        <Mono label={active.dimension} active />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">{/* unchanged */}</div>
          <div className="truncate font-mono text-[10px] text-ink-3">
            {engineer ? active.mapTable : `${aStats.total - aStats.fresh} mapped · ${aStats.fresh} new`}
          </div>
        </div>
        {/* ... */}
      </button>
      {/* ... */}
```

In the dropdown list rendering (each `<li>`), replace the per-row `<div className="truncate font-mono text-[10px] text-ink-3">{d.mapTable}</div>` with:

```tsx
<div className="truncate font-mono text-[10px] text-ink-3">
  {engineer ? d.mapTable : `${s.total - s.fresh} mapped · ${s.fresh} new`}
</div>
```

In the create form, replace the `creates zugzug.dim_… + zugzug.map_…` line with:

```tsx
<div className="mt-2 font-mono text-[10px] leading-relaxed text-ink-3">
  {engineer
    ? <>creates <span className="text-ink-2">zugzug.dim_{slug(name) || "…"}</span> + <span className="text-ink-2">zugzug.map_{slug(name) || "…"}</span></>
    : <>Creates a new master list{name ? <> called <span className="text-ink-2">"{name}"</span></> : ""}</>}
</div>
```

- [ ] **Step 2: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Browse: with engineer off, dimension picker shows counts in subtitle; create form says "Creates a new master list…". Toggle engineer on: original `zugzug.map_*` and `creates zugzug.dim_*` re-appear.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/DimensionPicker.tsx
git commit -m "Engineer-gate DimensionPicker subtitle + create-form copy"
```

---

## Task 6: Apply engineer mode + crash fix + bulk-merge hint to MasterTables

**Files:**
- Create: `app/src/components/NoDimensionsYet.tsx`
- Modify: `app/src/routes/MasterTables.tsx`

- [ ] **Step 1: Create shared `NoDimensionsYet` component**

```tsx
// app/src/components/NoDimensionsYet.tsx
import { Link } from "react-router-dom";
import { Button } from "./Button";
import { IconArrowRight } from "./Icons";

export function NoDimensionsYet({ from }: { from: "mapping" | "tables" }) {
  return (
    <div className="zz-rise mx-auto max-w-xl rounded-lg border border-line bg-surface p-10 text-center">
      <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">No master lists yet</div>
      <h1 className="mt-2 font-display text-[clamp(22px,3vw,32px)] font-extrabold leading-tight tracking-[-0.03em] text-ink">
        Nothing to {from === "mapping" ? "match" : "manage"} yet.
      </h1>
      <p className="mt-3 text-ink-2">Create a master list from scratch, or import one from a warehouse column.</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Link to="/app/sources"><Button icon={<IconArrowRight className="h-4 w-4" />}>Wire a source</Button></Link>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Guard `dims[0]` in MasterTables + gate header + add merge hint**

In `app/src/routes/MasterTables.tsx`:

```tsx
import { useEngineerMode } from "../lib/engineer-mode";
import { NoDimensionsYet } from "../components/NoDimensionsYet";

export function MasterTables() {
  const dims = useDimensions();
  const sources = useSources();
  const { engineer } = useEngineerMode();
  const [dimId, setDimId] = useState<string | null>(dims[0]?.id ?? null);
  const dim = dims.find((d) => d.id === dimId) ?? dims[0] ?? null;
  if (!dim) return <NoDimensionsYet from="tables" />;
  // ... existing logic uses `dim` directly; `dim.id` etc are safe now ...
```

Replace the existing header strip (the `<div className="zz-rise flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-5 py-4 font-mono text-[11px]">` block) with an engineer-gated version. When engineer mode is **off**, render only the records + attribute-columns counts and the AddColumn affordance; when **on**, render the existing content. Sketch:

```tsx
<div className="zz-rise flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-5 py-4 font-mono text-[11px]" style={{ animationDelay: "100ms" }}>
  {engineer && (
    <>
      <span className="text-ink-3">table <span className="text-ink">{dim.dimTable}</span></span>
      <span className="text-ink-3">key <span className="text-ink">{dim.keyCol}</span></span>
    </>
  )}
  <span className="text-ink-3">{list.length} records</span>
  <span className="text-ink-3">{fields.length} attribute column{fields.length === 1 ? "" : "s"}</span>
  <div className="ml-auto flex items-center gap-4">
    <span className="text-ink-3">{totalVariants.toLocaleString()} raw values resolve here</span>
    <AddColumn onAdd={(label, type) => addField(dim.id, label, type)} />
  </div>
</div>
```

Replace every `dimId` usage further down with `dim.id` (since we now know `dim` is non-null). Where the existing code reads `dimId` from state (e.g. `setDimId`), keep state of type `string | null`.

Add a hint row right above the table when `sel.length === 0`, regardless of engineer mode:

```tsx
<div className="px-5 pt-3 pb-1 text-[12px] text-ink-3">
  Select two or more master records to merge them into one.
</div>
```

(Place this inside the existing card, right before the column header row — only when `list.length >= 2 && sel.length === 0`.)

- [ ] **Step 3: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Browse: with engineer off, the master-tables header no longer shows `table zugzug.dim_*`; the records count + attribute columns + total-variants + AddColumn are still visible. With engineer on, original content returns. Confirm the merge hint appears above the table.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/NoDimensionsYet.tsx app/src/routes/MasterTables.tsx
git commit -m "MasterTables: engineer-gate header, fix dims[0] crash, add merge hint"
```

---

## Task 7: Apply engineer mode + crash fix + microcopy to Mapping route

**Files:**
- Modify: `app/src/routes/Mapping.tsx`

This is the biggest single file change. The changes are mechanical but numerous.

- [ ] **Step 1: Imports + crash guard + engineer mode**

```tsx
import { useEngineerMode } from "../lib/engineer-mode";
import { NoDimensionsYet } from "../components/NoDimensionsYet";
// ... existing imports ...

export function Mapping() {
  const dims = useDimensions();
  const allDrafts = useDrafts();
  const { engineer } = useEngineerMode();
  const [seedId, setSeedId] = useState<string | null>(dims[0]?.id ?? null);
  const seed = dims.find((s) => s.id === seedId) ?? dims[0] ?? null;
  if (!seed) return <NoDimensionsYet from="mapping" />;
  // ... rest of existing logic, which uses `seed.*` — safe now ...
```

- [ ] **Step 2: Engineer-gate the "DuckDB targets + coverage" strip**

Replace the existing strip (`<div className="zz-rise flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-line bg-surface px-5 py-4" style={{ animationDelay: "100ms" }}>` block) so the `master / lookup / rows · key` triplet only shows when engineer is on:

```tsx
<div className="zz-rise flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-line bg-surface px-5 py-4" style={{ animationDelay: "100ms" }}>
  {engineer && (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11px]">
      <span className="text-ink-3">master <span className="text-ink">{seed.dimTable}</span></span>
      <span className="text-ink-3">lookup <span className="text-ink">{seed.mapTable}</span></span>
      <span className="text-ink-3">{seed.rows.toLocaleString()} rows · key <span className="text-ink">{seed.keyCol}</span></span>
    </div>
  )}
  <div className={engineer ? "ml-auto flex items-center gap-3" : "flex items-center gap-3"}>
    {/* coverage bar + new badge unchanged */}
  </div>
</div>
```

- [ ] **Step 3: Engineer-gate the "Preview SQL" button + SQL pre block**

In the commit footer (lines around 262-263 and 283-285):
- Wrap the "Preview SQL" `<Button>` in `{engineer && (...)}`.
- The SQL `<pre>` rendering at the bottom is already guarded by `showSql`; since `showSql` can't be set without the button, this is already covered by gating the button. (No change needed there beyond removing the button when engineer is off.)

- [ ] **Step 4: Replace `LEFT JOIN to NULL` warning copy**

Around `Mapping.tsx:229`, replace:

```tsx
: <>⚠ unresolved — these {valueRows(r).toLocaleString()} rows currently <span className="text-danger">LEFT JOIN to NULL</span></>
```

with:

```tsx
: engineer
  ? <>⚠ unresolved — these {valueRows(r).toLocaleString()} rows currently <span className="text-danger">LEFT JOIN to NULL</span></>
  : <>⚠ <span className="text-danger">Unmapped</span> — {valueRows(r).toLocaleString()} downstream rows are missing this value</>
```

- [ ] **Step 5: Replace commit-footer copy + "Approve & commit" button label**

Around `Mapping.tsx:254-264`, replace the status text and button label:

```tsx
<span className="font-mono text-[11px] text-ink-3">
  {flash
    ? <span className="text-ok">✓ {flash.n} {engineer ? "draft" : "change"}{flash.n === 1 ? "" : "s"} {engineer ? <>merged into {seed.mapTable}</> : <>published to {seed.dimension}</>} · {flash.rows.toLocaleString()} rows recovered</span>
    : staged.length > 0
      ? engineer
        ? <>{staged.length} staged draft{staged.length === 1 ? "" : "s"} → batch MERGE to <span className="text-ink-2">{seed.dimTable}</span> + <span className="text-ink-2">{seed.mapTable}</span></>
        : <>{staged.length} change{staged.length === 1 ? "" : "s"} ready to publish to <span className="text-ink-2">{seed.dimension}</span></>
      : <>no staged drafts — accept or merge values to stage them</>}
</span>
{/* ... */}
<Button size="sm" disabled={staged.length === 0} onClick={approveAndCommit}>
  {engineer ? `Approve & commit ${staged.length}` : `Publish ${staged.length} change${staged.length === 1 ? "" : "s"}`}
</Button>
```

- [ ] **Step 6: Microcopy: rename "New" filter chip → "Needs review"**

Around `Mapping.tsx:102-105`:

```tsx
const FILTERS: { k: Filter; label: string; n: number }[] = [
  { k: "new", label: "Needs review", n: counts.new },
  { k: "all", label: "All", n: counts.all },
  { k: "mapped", label: "Mapped", n: counts.mapped },
];
```

- [ ] **Step 7: Confidence color third tone**

Around `Mapping.tsx:22-23`:

```tsx
const confBar = (c: number) => (c >= 90 ? "bg-ok" : c >= 70 ? "bg-warn" : "bg-danger-soft");
const confText = (c: number) => (c >= 90 ? "text-ok" : c >= 70 ? "text-warn" : "text-danger");
```

If `bg-danger-soft` / `text-danger` are not yet token-mapped utilities, check `app/src/globals.css` and `app/src/tokens.css` — `--danger` is defined; `bg-danger` already works (used at line 207). `text-danger` is also already used at the warning copy line. For the soft variant, fall back to `bg-danger/15` if no token alias exists; this fits the existing pattern.

- [ ] **Step 8: Auto-match result chip**

The current `automap()` (line 65) doesn't tell the user what happened. Add a small flash chip. Replace the existing `automap` with:

```tsx
const [autoFlash, setAutoFlash] = useState<number | null>(null);
const automap = () => {
  let n = 0;
  for (const r of seed.values) if (r.suggestion && r.confidence >= 90 && state[r.value].status === "new") { stageMap(r.value, r.suggestion); n++; }
  setAutoFlash(n); setTimeout(() => setAutoFlash(null), 2600);
};
```

Then update the auto-match button so it shows the result inline:

```tsx
<Button icon={<IconWand className="h-4 w-4" />} onClick={automap} className="zz-glow-sm">
  {autoFlash !== null ? `✓ Auto-matched ${autoFlash}` : "Auto-match new values"}
</Button>
```

- [ ] **Step 9: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Browse with engineer **off**: confirm:
1. No table-name strip.
2. No "Preview SQL" button.
3. Unmapped row reads "Unmapped — N downstream rows are missing this value".
4. Commit footer says "N changes ready to publish to Country".
5. Commit button says "Publish N changes".
6. "Needs review" tab instead of "New".
7. Low-confidence (<70) rows show with danger-tinted bar/text.
8. Auto-match button briefly shows "✓ Auto-matched N".

Toggle engineer on: every above reverts to the technical version.

- [ ] **Step 10: Commit**

```bash
git add app/src/routes/Mapping.tsx
git commit -m "Mapping: engineer-gate jargon, crash guard, microcopy, confidence color, auto-match chip"
```

---

## Task 8: Apply engineer mode + microcopy to Sources route

**Files:**
- Modify: `app/src/routes/Sources.tsx`

- [ ] **Step 1: Microcopy renames**

In `app/src/routes/Sources.tsx`:

- Around line 79-84, rename the `Needs attention` chip label to `Needs review`:

```tsx
const CHIPS: { k: Status | "all"; label: string; n: number }[] = [
  { k: "needs", label: "Needs review", n: counts.needs },
  { k: "all", label: "All", n: sources.length },
  { k: "clean", label: "Clean", n: counts.clean },
  { k: "missing", label: "Not found", n: counts.missing },
];
```

- The "Discovery" eyebrow + "Sources" heading + description can stay (already plain English).

- [ ] **Step 2: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Browse: confirm the chip reads "Needs review".

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/Sources.tsx
git commit -m "Sources: rename Needs attention → Needs review"
```

---

## Task 9: Settings — Connections rework + remove duplicate theme picker + add engineer toggle row

**Files:**
- Modify: `app/src/routes/Settings.tsx`

- [ ] **Step 1: Add engineer mode imports + toggle row**

```tsx
import { useEngineerMode } from "../lib/engineer-mode";

export function Settings() {
  const { theme, setTheme } = useTheme();
  const { engineer, setEngineer } = useEngineerMode();
  // ... existing state ...
```

- [ ] **Step 2: Remove the duplicate theme picker; replace Appearance section with engineer toggle**

Replace the entire Appearance `<Section>` block (lines ~61-75) with:

```tsx
<div className="zz-rise" style={{ animationDelay: "100ms" }}>
  <Section title="Appearance" hint="Theme follows the toggle in the top bar. Engineer details exposes the warehouse internals.">
    <Field label="Engineer details">
      <button type="button" onClick={() => setEngineer(!engineer)} className="flex items-center gap-3 text-left">
        <span className={cx("relative h-5 w-9 rounded-pill border transition-colors", engineer ? "border-accent bg-accent" : "border-line-2 bg-surface-2")}>
          <span className={cx("absolute top-0.5 h-3.5 w-3.5 rounded-pill bg-surface transition-all", engineer ? "left-4" : "left-0.5")} />
        </span>
        <span className="text-[13px] text-ink-2">Show warehouse table names, SQL, and join warnings</span>
      </button>
    </Field>
  </Section>
</div>
```

(Drop the `IconSun` / `IconMoon` imports if they become unused — re-check with grep.)

- [ ] **Step 3: Rework the Connections section**

Replace the existing Connections section (the `<Section title="Connections" hint="…">` block) with:

```tsx
<div className="zz-rise" style={{ animationDelay: "140ms" }}>
  <Section title="Connections" hint={engineer ? "Reads your warehouse (MotherDuck), writes master records to its own MotherDuck database, and keeps multi-user app state in Postgres." : "Where Zug Zug is connected."}>
    {engineer ? (
      <>
        {/* ORIGINAL three cards + ATTACH note — paste the existing JSX here unchanged */}
      </>
    ) : (
      <>
        <div className="rounded-sm border border-line bg-bg p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-display text-[14px] font-semibold text-ink">Warehouse</span>
            <Badge tone="ok" dot>connected</Badge>
          </div>
          <div className="mt-1 text-[12px] text-ink-3">Reading from your warehouse — read-only</div>
        </div>
        <div className="rounded-sm border border-line bg-bg p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-display text-[14px] font-semibold text-ink">Master store</span>
            <Badge tone="ok" dot>connected</Badge>
          </div>
          <div className="mt-1 text-[12px] text-ink-3">Stores every master list — what dbt joins downstream</div>
        </div>
        <div className="rounded-sm border border-line bg-bg p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="font-display text-[14px] font-semibold text-ink">Workspace</span>
            <Badge tone="ok" dot>connected</Badge>
          </div>
          <div className="mt-1 text-[12px] text-ink-3">Drafts, history, and your team — the collaborative layer</div>
        </div>
      </>
    )}
  </Section>
</div>
```

- [ ] **Step 4: Rename "Mapping defaults" → "Matching defaults"**

The "Mapping defaults" `<Section title=…>` heading (around line 110) becomes:

```tsx
<Section title="Matching defaults" hint="How aggressively Zug Zug matches new values.">
```

- [ ] **Step 5: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Browse: with engineer off, the Connections section shows three friendly cards. With engineer on, the original cards (with `md:zugzug`, `ATTACH …`) return. The theme selector is gone — top-bar toggle is the only place. An "Engineer details" toggle row sits where the theme picker was.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/Settings.tsx
git commit -m "Settings: rework Connections section (engineer-gated), remove duplicate theme picker, add engineer toggle, rename Matching defaults"
```

---

## Task 10: BootGate — loading skeleton + styled error fallback

**Files:**
- Create: `app/src/components/BootGate.tsx`
- Modify: `app/src/main.tsx`

- [ ] **Step 1: Create `BootGate`**

```tsx
// app/src/components/BootGate.tsx
import { useEffect, useState, type ReactNode } from "react";
import { initStore } from "../store";
import { Mark } from "./Mark";
import { Button } from "./Button";

type State = { kind: "loading" } | { kind: "ready" } | { kind: "error"; detail: string };

export function BootGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const boot = () => {
    setState({ kind: "loading" });
    initStore().then(
      () => setState({ kind: "ready" }),
      (e: unknown) => setState({ kind: "error", detail: e instanceof Error ? e.message : String(e) }),
    );
  };

  useEffect(boot, []);

  if (state.kind === "ready") return <>{children}</>;

  if (state.kind === "error") {
    return (
      <div className="zz-canvas grid min-h-screen place-items-center p-8">
        <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-8">
          <div className="flex items-center gap-2.5">
            <Mark className="h-7 w-7" />
            <span className="font-display text-lg font-extrabold tracking-tight text-ink">Zug Zug<span className="text-accent">.</span></span>
          </div>
          <h1 className="font-display text-2xl font-bold text-ink">Can't reach the API.</h1>
          <p className="text-ink-2">The server isn't responding. Start it with:</p>
          <pre className="overflow-x-auto rounded-sm border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink-2">cd server && bun run start</pre>
          <details className="text-[12px] text-ink-3"><summary className="cursor-pointer">Technical detail</summary><pre className="mt-2 whitespace-pre-wrap font-mono">{state.detail}</pre></details>
          <Button onClick={boot}>Retry</Button>
        </div>
      </div>
    );
  }

  // loading
  return (
    <div className="zz-canvas grid min-h-screen place-items-center p-8">
      <div className="flex items-center gap-2.5">
        <Mark className="h-8 w-8 animate-pulse" />
        <span className="font-display text-lg font-extrabold tracking-tight text-ink-2">Loading Zug Zug<span className="text-accent">…</span></span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Switch `main.tsx` to mount via `BootGate`**

Replace the `boot()` function in `main.tsx` so React mounts immediately and `BootGate` handles the async:

```tsx
import { BootGate } from "./components/BootGate";

createRoot(root).render(
  <React.StrictMode>
    <EngineerModeProvider>
      <BootGate>
        <BrowserRouter>
          <Routes>{/* existing routes */}</Routes>
        </BrowserRouter>
      </BootGate>
    </EngineerModeProvider>
  </React.StrictMode>,
);
```

Remove the `async function boot()` / `void boot()` block (and the raw-HTML error fallback) — `BootGate` now owns this.

- [ ] **Step 3: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Manual: stop the server, refresh the app; you should see the styled error with a Retry button. Restart the server, hit Retry; the app loads.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/BootGate.tsx app/src/main.tsx
git commit -m "Add BootGate: skeleton loader + styled API-error fallback with retry"
```

---

## Task 11: Accessibility audit pass

**Files:**
- Modify: `app/src/components/Button.tsx` (if needed)
- Modify: `app/src/components/ComboSelect.tsx`
- Modify: `app/src/components/DimensionPicker.tsx`
- Modify: `app/src/routes/Mapping.tsx`, `app/src/routes/MasterTables.tsx`, `app/src/routes/Sources.tsx`, `app/src/components/CatalogExplorer.tsx`

- [ ] **Step 1: Audit aria-labels on icon-only buttons**

Grep first:

```bash
grep -n 'type="button"' app/src/routes/*.tsx app/src/components/*.tsx | head -50
```

For each icon-only `<button>` without an `aria-label`, add one. The known offenders from spec review:
- `Mapping.tsx` row actions (Accept / Skip / Reset / select-all checkbox row) — already have `aria-label` ✓
- `MasterTables.tsx` rename / remove / merge clear — partial; remove `aria-label` is `{locked ? "..." : "Remove"}`, fine.
- `Sources.tsx` derive button (the wand) — missing. Add `aria-label="Import master records from this column"`.
- `CatalogExplorer.tsx` close button — already has `aria-label="Close"` ✓; the row chevron button does not but its content is `t.table` (a string), so visible-text reading suffices.

The single change required:

```tsx
// Sources.tsx around line 171 — the derive icon button
<button type="button" aria-label={`Import master records from ${r.table}.${r.column}`} title="..." onClick={...}>
```

- [ ] **Step 2: Standardize focus rings**

Add a global accent focus-ring utility to `app/src/globals.css` under the base layer:

```css
@layer base {
  :focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: var(--radius-sm, 2px);
  }
}
```

This applies a consistent accent ring to every focused element. Remove any per-component `:focus { outline: none }` if found (none in the current codebase).

- [ ] **Step 3: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Tab through the app from the topbar; confirm focus rings are visible and consistent on buttons, inputs, links, the search input in DimensionPicker, etc.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/Sources.tsx app/src/globals.css
git commit -m "Accessibility: aria-label on Sources derive button + global accent focus ring"
```

---

## Task 12: Backend — `app.preferences` table + endpoints

**Files:**
- Modify: `server/src/schema.ts`
- Modify: `server/src/repo.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: Add the preferences table**

In `server/src/schema.ts`, inside `ensureSchema()` after the existing tables:

```ts
// workspace-global preferences (single row, id=1)
await run(`CREATE TABLE IF NOT EXISTS ${pg("preferences")} (
  id              INT PRIMARY KEY,
  publish_threshold INT NOT NULL,
  suggest_threshold INT NOT NULL,
  updated_at      TIMESTAMP NOT NULL
)`);
await run(`INSERT INTO ${pg("preferences")} (id, publish_threshold, suggest_threshold, updated_at)
  VALUES (1, 95, 80, current_timestamp)
  ON CONFLICT (id) DO NOTHING`);
```

- [ ] **Step 2: Add `getPreferences` + `setPreferences` to repo.ts**

In `server/src/repo.ts`, near the bottom (or near other workspace-wide reads):

```ts
export interface Preferences { publishThreshold: number; suggestThreshold: number }

export async function getPreferences(): Promise<Preferences> {
  const row = (await all<{ publish_threshold: number; suggest_threshold: number }>(
    `SELECT publish_threshold, suggest_threshold FROM ${pg("preferences")} WHERE id = 1`,
  ))[0];
  return row
    ? { publishThreshold: Number(row.publish_threshold), suggestThreshold: Number(row.suggest_threshold) }
    : { publishThreshold: 95, suggestThreshold: 80 };
}

export async function setPreferences(p: Preferences): Promise<void> {
  await run(
    `UPDATE ${pg("preferences")} SET publish_threshold = $1, suggest_threshold = $2, updated_at = current_timestamp WHERE id = 1`,
    [p.publishThreshold, p.suggestThreshold],
  );
}
```

(Check `repo.ts` imports — `run` / `all` come from `./db.ts`; `pg` from `./env.ts`. Mirror existing usage.)

- [ ] **Step 3: Add endpoints to server.ts**

In `server/src/server.ts`, inside the `try` block:

```ts
// GET /api/preferences ; PUT /api/preferences {publishThreshold, suggestThreshold}
if (seg[1] === "preferences" && seg.length === 2) {
  if (method === "GET") return json(await repo.getPreferences());
  if (method === "PUT") {
    const p = (await req.json()) as { publishThreshold: number; suggestThreshold: number };
    await repo.setPreferences(p);
    return noContent();
  }
}
```

- [ ] **Step 4: Typecheck + run server**

Run: `cd server && bun run typecheck` → PASS
Restart server (`bun run start`); confirm it boots without errors.

- [ ] **Step 5: Smoke-test endpoints**

```bash
curl -s http://localhost:8787/api/preferences | jq
# expect: {"publishThreshold":95,"suggestThreshold":80}
curl -s -X PUT http://localhost:8787/api/preferences -H 'content-type: application/json' -d '{"publishThreshold":90,"suggestThreshold":75}'
curl -s http://localhost:8787/api/preferences | jq
# expect: {"publishThreshold":90,"suggestThreshold":75}
# reset:
curl -s -X PUT http://localhost:8787/api/preferences -H 'content-type: application/json' -d '{"publishThreshold":95,"suggestThreshold":80}'
```

- [ ] **Step 6: Commit**

```bash
git add server/src/schema.ts server/src/repo.ts server/src/server.ts
git commit -m "Backend: workspace-global preferences (publish + suggest thresholds)"
```

---

## Task 13: Client — `usePreferences` hook + preload + setter

**Files:**
- Modify: `app/src/store.ts`

- [ ] **Step 1: Add preferences to the store cache + hook + setter**

In `app/src/store.ts`:

```ts
export interface Preferences { publishThreshold: number; suggestThreshold: number }

let preferences: Preferences = { publishThreshold: 95, suggestThreshold: 80 };

async function refreshPreferences(): Promise<void> {
  preferences = await api<Preferences>("/preferences");
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, () => preferences, () => preferences);
}

export async function setPreferences(p: Preferences): Promise<void> {
  await api("/preferences", { method: "PUT", body: JSON.stringify(p) });
  await refreshPreferences();
  emit();
}
```

Call `await refreshPreferences()` from inside `initStore()` after the other refreshes.

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck` → PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/store.ts
git commit -m "Client: usePreferences hook + setter, preloaded in initStore"
```

---

## Task 14: `ThresholdRange` two-thumb slider component

**Files:**
- Create: `app/src/components/ThresholdRange.tsx`

- [ ] **Step 1: Implement the two-thumb range**

```tsx
// app/src/components/ThresholdRange.tsx
import { useCallback } from "react";
import { cx } from "../lib/cx";

interface Props {
  publish: number;
  suggest: number;
  min?: number;
  max?: number;
  onChange: (next: { publish: number; suggest: number }) => void;
}

export function ThresholdRange({ publish, suggest, min = 50, max = 100, onChange }: Props) {
  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, v)), [min, max]);

  const setPublish = (v: number) => {
    const p = clamp(v);
    onChange({ publish: p, suggest: Math.min(suggest, p) });
  };
  const setSuggest = (v: number) => {
    const s = clamp(v);
    onChange({ publish: Math.max(publish, s), suggest: s });
  };

  const pct = (v: number) => ((v - min) / (max - min)) * 100;

  return (
    <div className="w-full max-w-md">
      <div className="relative h-6">
        {/* base track */}
        <div className="absolute inset-y-1/2 left-0 right-0 h-1 -translate-y-1/2 rounded-pill bg-surface-2" />
        {/* suggest..publish band */}
        <div
          className="absolute inset-y-1/2 h-1 -translate-y-1/2 rounded-pill bg-warn"
          style={{ left: `${pct(suggest)}%`, right: `${100 - pct(publish)}%` }}
        />
        {/* >= publish band */}
        <div
          className="absolute inset-y-1/2 h-1 -translate-y-1/2 rounded-pill bg-ok"
          style={{ left: `${pct(publish)}%`, right: 0 }}
        />
        {/* suggest thumb */}
        <input
          type="range" min={min} max={max} value={suggest}
          onChange={(e) => setSuggest(+e.target.value)}
          aria-label={`Suggest threshold: ${suggest} percent`}
          className="absolute inset-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-moz-range-thumb]:pointer-events-auto"
        />
        {/* publish thumb */}
        <input
          type="range" min={min} max={max} value={publish}
          onChange={(e) => setPublish(+e.target.value)}
          aria-label={`Publish threshold: ${publish} percent`}
          className="absolute inset-0 w-full appearance-none bg-transparent pointer-events-none [&::-webkit-slider-thumb]:pointer-events-auto [&::-moz-range-thumb]:pointer-events-auto"
        />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[11px] text-ink-3">
        <span>Below {suggest}%: <span className="text-ink-2">no suggestion</span></span>
        <span>{suggest}–{publish}%: <span className="text-warn">suggest</span></span>
        <span>≥ {publish}%: <span className="text-ok">auto-publish</span></span>
      </div>
    </div>
  );
}
```

Note: two overlapping `<input type="range">`s with `pointer-events-none` on the base and `pointer-events-auto` on the WebKit/Moz thumb pseudos is the standard non-library two-thumb pattern. The visible track is built from three positioned divs so the colors mirror the labels below.

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck` → PASS

- [ ] **Step 3: Commit**

```bash
git add app/src/components/ThresholdRange.tsx
git commit -m "Add ThresholdRange (two-thumb publish/suggest slider)"
```

---

## Task 15: Settings — replace single slider with `ThresholdRange`

**Files:**
- Modify: `app/src/routes/Settings.tsx`

- [ ] **Step 1: Wire the slider to preferences**

In `app/src/routes/Settings.tsx`, replace the "Matching defaults" `<Section>` block (around lines 110-122) with:

```tsx
import { ThresholdRange } from "../components/ThresholdRange";
import { usePreferences, setPreferences } from "../store";

// ... inside Settings():
const prefs = usePreferences();

// ... in the JSX:
<div className="zz-rise" style={{ animationDelay: "180ms" }}>
  <Section title="Matching defaults" hint="How aggressively Zug Zug matches new values when a scan finds them.">
    <Field label="Confidence bands">
      <ThresholdRange
        publish={prefs.publishThreshold}
        suggest={prefs.suggestThreshold}
        onChange={({ publish, suggest }) => setPreferences({ publishThreshold: publish, suggestThreshold: suggest })}
      />
    </Field>
  </Section>
</div>
```

Drop the local `threshold` / `autoAccept` state — no longer needed. Drop the `save()` wiring if it only existed to flash "saved" for those fields; the preferences setter persists per change. (Or keep `save()` as a no-op for the moment to avoid removing the button.)

- [ ] **Step 2: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Browse: drag both thumbs; observe the band colors (gray below suggest, warn between, ok above publish); the values persist across page reloads (because they hit the backend).

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/Settings.tsx
git commit -m "Settings: two-band ThresholdRange wired to preferences (replaces single slider)"
```

---

## Task 16: Server — auto-stage drafts on scan when confidence ≥ publish threshold

**Files:**
- Modify: `server/src/repo.ts`

- [ ] **Step 1: Find the `scanSources` implementation and where it produces values**

Read the current `scanSources` and any helper it calls in `server/src/repo.ts`. The current path produces unmapped values per source; it doesn't auto-stage drafts.

- [ ] **Step 2: Locate the AI confidence + suggestion source**

If suggestions/confidence are produced in the same code path (e.g. in the same function that lists unmapped values), use them directly. If they're computed elsewhere (e.g. on the read path via `getDimension`), then auto-publish needs to happen after we've enriched scanned values with confidence — likely in `scanSources` after the per-source scan, or by walking newly-scanned values and applying the suggestion+confidence logic.

In either case, add a step at the end of `scanSources` that:

```ts
const prefs = await getPreferences();
// For each dim, walk its newly-discovered new values; for any with suggestion + confidence >= prefs.publishThreshold,
// upsert a 'mapped' draft owned by a system user (or first user).
```

Concrete sketch (adapt to the actual function shape):

```ts
const dims = await listDimensions();
for (const meta of dims) {
  const dim = await getDimension(meta.id);
  if (!dim) continue;
  for (const v of dim.values) {
    if (v.status !== "new" || !v.suggestion || v.confidence < prefs.publishThreshold) continue;
    const target = dim.canonical.find((c) => c.label === v.suggestion);
    if (!target) continue;
    await saveDraft(dim.id, v.value, "mapped", target.label, target.key, "u_system");
  }
}
```

Notes:
- Use a stable "system" user id `u_system`; insert it into the `users` table during schema bootstrap or fall back to `u_ada`.
- This may be I/O-heavy on many dimensions; that's acceptable for the demo scale. If needed, batch by dimension.

- [ ] **Step 3: Add `u_system` user (if not present) in schema seed**

In `server/src/schema.ts`, extend `DEFAULT_USERS`:

```ts
const DEFAULT_USERS = [
  { id: "u_ada", name: "Ada Berg", initials: "AB" },
  { id: "u_li", name: "Li Bauer", initials: "LB" },
  { id: "u_cory", name: "Cory Mills", initials: "CM" },
  { id: "u_system", name: "Auto-match", initials: "AM" },
];
```

(The existing seed only runs when the users table is empty. For an existing DB, add a separate idempotent insert in `ensureSchema()`):

```ts
await run(
  `INSERT INTO ${pg("users")} (id, name, initials)
   VALUES ('u_system','Auto-match','AM')
   ON CONFLICT (id) DO NOTHING`,
);
```

- [ ] **Step 4: Verify with a small script**

Create `server/src/verify-polish.ts` (mirroring `verify-eid.ts`'s structure). It should:

1. Connect, ensure schema.
2. Read `getPreferences()` — assert default {95, 80} on fresh DB.
3. `setPreferences({publishThreshold: 50, suggestThreshold: 40})`.
4. Insert a test dimension with a known canonical record and a "new" value whose suggestion has confidence ≥ 50 (mocked — see how `verify-eid.ts` seeds).
5. Call `scanSources()`.
6. Read `listDrafts(dim.id)` — assert the value now has an auto-mapped draft owned by `u_system`.
7. Self-clean: delete the test dimension and the test draft.

Run: `cd server && bun run src/verify-polish.ts` → all asserts pass.

If the confidence/suggestion machinery is downstream of the warehouse (and inactive without `ATTACH_WAREHOUSE=true`), the verify can stub it: insert a draft directly to simulate the auto-mapping path, or assert only that the threshold is honored on a confidence sentinel value. Document the limitation in the script's header.

Add `verify-polish` to `server/package.json` scripts:

```json
"verify-polish": "bun run src/verify-polish.ts"
```

- [ ] **Step 5: Commit**

```bash
git add server/src/repo.ts server/src/schema.ts server/src/verify-polish.ts server/package.json
git commit -m "Server: auto-stage drafts on scan when confidence ≥ publish threshold (Auto-match user)"
```

---

## Task 17: Backend — per-source schedule column + endpoints

**Files:**
- Modify: `server/src/schema.ts`
- Modify: `server/src/repo.ts`
- Modify: `server/src/server.ts`

- [ ] **Step 1: Add `schedule` column to `dimension_source`**

In `server/src/schema.ts`, after the `dimension_source` CREATE TABLE:

```ts
await run(`ALTER TABLE ${pg("dimension_source")} ADD COLUMN IF NOT EXISTS schedule VARCHAR`);
```

`schedule` values: `null` (no schedule, default), `'15m'`, `'hourly'`, `'daily'`. Keep it as a free string column; UI maps from a fixed set.

- [ ] **Step 2: `setSourceSchedule` + `dueScans` in repo.ts**

```ts
export async function setSourceSchedule(dimId: string, table: string, column: string, schedule: string | null): Promise<void> {
  await run(
    `UPDATE ${pg("dimension_source")} SET schedule = $1 WHERE dim_id = $2 AND source_table = $3 AND source_column = $4`,
    [schedule, dimId, table, column],
  );
}

/** Sources whose schedule is due, given the last scanned_at on source_stat. */
export async function dueScans(now: Date): Promise<{ dimId: string; table: string; column: string }[]> {
  const rows = await all<{ dim_id: string; source_table: string; source_column: string; schedule: string; scanned_at: Date | null }>(
    `SELECT ds.dim_id, ds.source_table, ds.source_column, ds.schedule, ss.scanned_at
     FROM ${pg("dimension_source")} ds
     LEFT JOIN ${pg("source_stat")} ss
       ON ss.dim_id = ds.dim_id AND ss.source_table = ds.source_table AND ss.source_column = ds.source_column
     WHERE ds.schedule IS NOT NULL`,
  );
  const dueMs = (s: string) => s === "15m" ? 15 * 60_000 : s === "hourly" ? 60 * 60_000 : s === "daily" ? 24 * 60 * 60_000 : Infinity;
  return rows
    .filter((r) => !r.scanned_at || (now.getTime() - new Date(r.scanned_at).getTime()) >= dueMs(r.schedule))
    .map((r) => ({ dimId: r.dim_id, table: r.source_table, column: r.source_column }));
}
```

Also expose `scanOneSource(dimId, table, column)` if it isn't already — peek at the existing `scanSources()` implementation; if the scan loop walks each row individually, refactor that inner function to be reusable. If `scanSources` is the only entry point, accept the slight inefficiency and call it from the scheduler for now (it's a small registry).

- [ ] **Step 3: Endpoint for setting a schedule**

In `server.ts`, inside `if (seg[1] === "dimensions")` add a handler for setting source schedule via:

```ts
// PUT /api/dimensions/:id/sources/schedule {table, column, schedule}
if (seg[3] === "sources" && seg[4] === "schedule" && seg.length === 5 && method === "PUT") {
  const { table, column, schedule } = (await req.json()) as { table: string; column: string; schedule: string | null };
  await repo.setSourceSchedule(id, table, column, schedule);
  return noContent();
}
```

Also extend the `/sources` GET to include the schedule + `scanned_at`. Inspect the current `listSources` shape and add the two fields. (UI changes in the next task assume `SourceInfo.schedule` and `SourceInfo.scannedAt`.)

- [ ] **Step 4: Typecheck server + smoke test**

```bash
cd server && bun run typecheck
# restart server
curl -s -X PUT http://localhost:8787/api/dimensions/country/sources/schedule \
  -H 'content-type: application/json' \
  -d '{"table":"ga4.sessions","column":"country","schedule":"15m"}'
curl -s http://localhost:8787/api/sources | jq '.[0]'
# expect a `schedule` field on the row
```

- [ ] **Step 5: Commit**

```bash
git add server/src/schema.ts server/src/repo.ts server/src/server.ts
git commit -m "Server: per-source scan schedule (column + endpoint + dueScans)"
```

---

## Task 18: Server — `setInterval` scheduler loop

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: Add a once-per-minute tick that runs due scans**

In `server/src/server.ts`, after `await connect()` but before `Bun.serve(...)`:

```ts
let scanInFlight = false;
async function scheduleTick() {
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    const due = await repo.dueScans(new Date());
    for (const s of due) {
      try { await repo.scanSources(); break; } catch (e) { console.error("scheduled scan failed:", e); }
    }
  } finally {
    scanInFlight = false;
  }
}
setInterval(scheduleTick, 60_000);
// optional: scheduleTick(); // run once at boot
console.log("· scheduler started (1m tick)");
```

Note: `scanSources()` scans **all** wired sources today. If `dueScans` returns any, we call it once; the granularity is coarse but matches what's wired. A future refinement is to scan only the due ones, requiring a `scanOneSource` extraction.

- [ ] **Step 2: Typecheck + restart**

Run: `cd server && bun run typecheck` → PASS
Restart server. With a source scheduled to `15m`, watch for the `scheduler started` log line at boot.

- [ ] **Step 3: Commit**

```bash
git add server/src/server.ts
git commit -m "Server: 1-minute setInterval scheduler that runs due scans"
```

---

## Task 19: Client — `ScanScheduleMenu` component + Sources integration

**Files:**
- Create: `app/src/components/ScanScheduleMenu.tsx`
- Modify: `app/src/store.ts`
- Modify: `app/src/routes/Sources.tsx`

- [ ] **Step 1: Extend `SourceInfo` and add `setSourceSchedule` to the store**

In `app/src/store.ts`:

```ts
export interface SourceInfo {
  // ... existing fields ...
  schedule?: string | null;     // '15m' | 'hourly' | 'daily' | null
  scannedAt?: string | null;    // ISO timestamp of last scan
}

export async function setSourceSchedule(dimId: string, table: string, column: string, schedule: string | null): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/sources/schedule`, {
    method: "PUT",
    body: JSON.stringify({ table, column, schedule }),
  });
  await refreshSources();
  emit();
}
```

- [ ] **Step 2: Create `ScanScheduleMenu`**

```tsx
// app/src/components/ScanScheduleMenu.tsx
import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";

const OPTIONS = [
  { value: null, label: "Off" },
  { value: "15m", label: "Every 15 min" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
] as const;

export function ScanScheduleMenu({ value, onChange }: { value: string | null; onChange: (next: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = OPTIONS.find((o) => o.value === (value ?? null)) ?? OPTIONS[0];

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Scan schedule: ${current.label}`}
        title={`Scan schedule: ${current.label}`}
        className={cx(
          "grid h-6 w-6 place-items-center rounded-sm border transition-colors",
          value ? "border-accent text-accent" : "border-line-2 text-ink-3 hover:border-accent hover:text-accent",
        )}
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 4 V8 L10.5 9.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-40 overflow-hidden rounded-sm border border-line-2 bg-surface shadow-pop">
          <ul className="py-1">
            {OPTIONS.map((o) => (
              <li key={o.value ?? "off"}>
                <button
                  type="button"
                  onClick={() => { onChange(o.value); setOpen(false); }}
                  className={cx("flex w-full items-center justify-between px-3 py-1.5 text-left font-mono text-[12px] transition-colors hover:bg-hover", o.value === (value ?? null) ? "text-accent" : "text-ink-2")}
                >
                  <span>{o.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire into Sources.tsx**

In `app/src/routes/Sources.tsx`, in the row rendering (around lines 156-180), add the menu and the "last scanned" / "Auto every Nm" copy:

```tsx
import { ScanScheduleMenu } from "../components/ScanScheduleMenu";
import { setSourceSchedule } from "../store";

// helper, inline at the top of the file:
function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `Last scanned ${sec}s ago`;
  if (sec < 3600) return `Last scanned ${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `Last scanned ${Math.round(sec / 3600)}h ago`;
  return `Last scanned ${Math.round(sec / 86400)}d ago`;
}
const SCHED_LABEL: Record<string, string> = { "15m": "Auto every 15m", hourly: "Auto hourly", daily: "Auto daily" };
```

Update the row's right cluster:

```tsx
<span className="flex items-center justify-end gap-2">
  <ScanScheduleMenu value={r.schedule ?? null} onChange={(next) => setSourceSchedule(r.dimId, r.table, r.column, next)} />
  <button type="button" aria-label={`Import master records from ${r.table}.${r.column}`} title="..." onClick={(e) => { e.preventDefault(); e.stopPropagation(); derive(r); }} className="...">
    <IconWand className="h-3 w-3" />
  </button>
  {r.unmapped > 0 ? <Badge tone="warn">{r.unmapped}</Badge> : <Badge tone="ok">0</Badge>}
</span>
```

Replace the existing "unscanned" / row metadata where shown with:

```tsx
<div className="mt-0.5 font-mono text-[10px] text-ink-3">
  → {r.dimension}
  {r.schedule ? <> · <span className="text-accent">{SCHED_LABEL[r.schedule] ?? r.schedule}</span></> : null}
  {r.scannedAt ? <> · {ago(r.scannedAt)}</> : !r.scanned ? <> · unscanned</> : null}
</div>
```

- [ ] **Step 4: Typecheck + manual verify**

Run: `cd app && bun run typecheck` → PASS
Browse Sources; click the clock icon on a row → pick `Every 15 min` → confirm the row label updates to `Auto every 15m`; reload — schedule persists.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/ScanScheduleMenu.tsx app/src/store.ts app/src/routes/Sources.tsx
git commit -m "Client: per-source scan schedule menu + Last scanned / Auto every Nm labels"
```

---

## Final pass

- [ ] **Run typecheck across both packages**

```bash
cd app && bun run typecheck && cd ../server && bun run typecheck
```

Both: PASS.

- [ ] **Cold walkthrough (no engineer mode)**

Hard-reload the app. Walk: Dashboard → Sources → MasterTables → Mapping → Settings. Confirm no `zugzug.*`, no SQL, no MERGE/JOIN copy, no `analytics.duckdb` anywhere. Settings shows the two-band slider and the Engineer toggle.

- [ ] **Engineer mode walkthrough**

Click the `</>` toggle. Walk the same routes; confirm every piece of technical detail is back.

- [ ] **Stress test edge cases**

- Kill the server; reload the app — styled error screen with Retry.
- Restart server, hit Retry — app loads.
- (If a fresh-install Postgres is available) bootstrap with no `--seed`; confirm `/app/mapping` and `/app/tables` show the `NoDimensionsYet` screen with a link to Sources.

- [ ] **Final commit (if any micro-fixes from the walkthrough)**

---

## Self-review against the spec

Cross-checking each spec requirement → task:

| Spec | Task |
|---|---|
| useEngineerMode + provider | Task 1 |
| topbar EngineerModeToggle | Task 2, 3 |
| Settings engineer toggle | Task 9 |
| AppShell sidebar footer + nav labels | Task 4 |
| DimensionPicker subtitle + create form | Task 5 |
| MasterTables header gate | Task 6 |
| Mapping header + SQL button + JOIN copy + commit footer + button label | Task 7 |
| Settings Connections rework | Task 9 |
| Microcopy: Value mapping → Match values | Task 4 |
| Microcopy: Master tables → Master lists | Task 4 |
| Microcopy: New → Needs review (Mapping) | Task 7 |
| Microcopy: Needs attention → Needs review (Sources) | Task 8 |
| Microcopy: Mapping defaults → Matching defaults | Task 9 |
| Auto-match button + result chip | Task 7 |
| dims[0] crash + NoDimensionsYet | Tasks 6, 7 |
| Styled boot error + skeleton | Task 10 |
| Remove topbar search | Task 4 |
| Confidence color third tone | Task 7 |
| Remove duplicate theme picker | Task 9 |
| Accessibility (aria-labels + focus rings) | Task 11 |
| Bulk-merge hint in MasterTables | Task 6 |
| `app.preferences` table + endpoints | Task 12 |
| `usePreferences` hook | Task 13 |
| ThresholdRange component | Task 14 |
| Settings two-band slider | Task 15 |
| Server: auto-stage on scan | Task 16 |
| Per-source schedule column + endpoint | Task 17 |
| Scheduler setInterval | Task 18 |
| ScanScheduleMenu + Sources integration | Task 19 |

All spec requirements covered.
