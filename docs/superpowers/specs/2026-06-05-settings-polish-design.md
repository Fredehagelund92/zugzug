# Settings revamp + UI polish — design spec

**Date:** 2026-06-05
**Status:** Design — approved, pending implementation plan
**Scope:** `app/src/routes/Settings.tsx`, `app/src/components/ScanScheduleMenu.tsx`, `app/src/components/LedgerRow.tsx`, `app/src/components/AppShell.tsx`, `app/src/components/TableTabStrip.tsx`, `app/src/store.ts`, `server/src/repo-meta.ts`, `server/src/repo-scan.ts`, `server/src/server.ts`, `server/drizzle/schema.ts`

---

## Overview

Two categories of change:

1. **Settings revamp + workspace scan scheduling** — a single workspace-level scan schedule replaces the per-row `ScanScheduleMenu`. The Settings page gets a new Scans section at the top (layout B: full-bleed cards) and a live status strip showing last-scan age, source count, and unmapped values.

2. **UI polish sweep** — z-index normalization, focus-ring standardization, and `transition-colors` consistency. Small changes spread across ~8 files but each one is surgical and testable.

---

## Part 1: Scan scheduling

### Decision

**Option A: workspace default only.** One schedule for everything. The per-row `ScanScheduleMenu` clock-icon button is removed from `LedgerRow.tsx` entirely. The schedule lives in `preferences.scan_schedule`. The server's existing `setInterval` scheduler reads it.

Valid values: `null` (off), `"15m"`, `"hourly"`, `"daily"`.

### Why this is the right call

The per-row picker makes sense for 3–5 sources. At 40+ sources it creates noise — users can't tell what's set where, the Sources page gains a column of UI that usually does nothing, and the per-source schedule rows in `dimension_source` mean every `anyScanDue()` call joins across them all. Workspace default removes all of that.

### Server changes

**`server/drizzle/schema.ts`** — add `scan_schedule` column:

```ts
export const preferences = app.table("preferences", {
  id:                integer("id").primaryKey(),
  publish_threshold: integer("publish_threshold").notNull(),
  suggest_threshold: integer("suggest_threshold").notNull(),
  scan_schedule:     varchar("scan_schedule", { length: 10 }),   // null | '15m' | 'hourly' | 'daily'
  updated_at:        timestamp("updated_at").notNull(),
});
```

Run `bun run db:generate` after schema edit. Commit the generated migration. Default is `NULL` (off) — no Drizzle `default()` needed; the bootstrap seed already inserts row `id=1` manually.

**`server/src/repo-meta.ts`** — update `Preferences` type and both functions:

```ts
export interface Preferences {
  publishThreshold: number;
  suggestThreshold: number;
  scanSchedule: "15m" | "hourly" | "daily" | null;
}

export async function getPreferences(): Promise<Preferences> {
  const row = await pgGet<{ publish_threshold: number; suggest_threshold: number; scan_schedule: string | null }>(
    `SELECT publish_threshold, suggest_threshold, scan_schedule FROM ${pg("preferences")} WHERE id = 1`,
  );
  return {
    publishThreshold: row?.publish_threshold ?? 95,
    suggestThreshold: row?.suggest_threshold ?? 80,
    scanSchedule: (row?.scan_schedule ?? null) as Preferences["scanSchedule"],
  };
}

export async function setPreferences(p: Preferences): Promise<void> {
  const valid = p.scanSchedule === null || ["15m", "hourly", "daily"].includes(p.scanSchedule);
  if (!valid) throw new Error(`invalid scanSchedule: ${String(p.scanSchedule)}`);
  await pgRun(
    `UPDATE ${pg("preferences")} SET publish_threshold = $1, suggest_threshold = $2, scan_schedule = $3, updated_at = current_timestamp WHERE id = 1`,
    [p.publishThreshold, p.suggestThreshold, p.scanSchedule],
  );
}
```

**`server/src/repo-scan.ts`** — replace `anyScanDue()`:

```ts
export async function anyScanDue(now: Date = new Date()): Promise<boolean> {
  let pref: { scanSchedule: string | null; scannedAt: string | null };
  try {
    const row = await pgGet<{ scan_schedule: string | null; last_scan: string | null }>(
      `SELECT p.scan_schedule,
              (SELECT max(st.scanned_at)::text FROM ${pg("source_stat")} st) AS last_scan
       FROM ${pg("preferences")} p WHERE p.id = 1`,
    );
    if (!row) return false;
    pref = { scanSchedule: row.scan_schedule, scannedAt: row.last_scan };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation.*zugzug_app.*does not exist/i.test(msg)) return false;
    throw e;
  }
  if (!pref.scanSchedule) return false;
  const dueMs = (s: string) =>
    s === "15m" ? 15 * 60_000 : s === "hourly" ? 60 * 60_000 : 24 * 60 * 60_000;
  if (!pref.scannedAt) return true; // never scanned → run immediately
  return now.getTime() - new Date(pref.scannedAt).getTime() >= dueMs(pref.scanSchedule);
}
```

The `setSourceSchedule()` function in `repo-scan.ts` becomes dead code. Remove it. The `schedule` column from `listSources()`'s SELECT and the `SourceInfo.schedule` field are also dead — remove both.

**`server/src/server.ts`** — update preferences route to pass `scanSchedule` through:

```ts
if (seg[1] === "preferences" && seg.length === 2) {
  if (method === "GET") return json(await repo.getPreferences());
  if (method === "PUT") {
    const p = await req.json() as { publishThreshold: number; suggestThreshold: number; scanSchedule: string | null };
    await repo.setPreferences(p);
    return noContent();
  }
}
```

Add a new read-only endpoint for the Settings status strip:

```ts
// GET /api/sources/scan-status → { lastScanAt, sourceCount, unmappedCount }
if (seg[2] === "scan-status" && seg.length === 3 && method === "GET")
  return json(await repo.scanStatus());
```

**`server/src/repo-scan.ts`** — add `scanStatus()`:

```ts
export interface ScanStatusResult {
  lastScanAt: string | null;  // ISO timestamp (most recent scanned_at across all sources)
  sourceCount: number;
  unmappedCount: number;
}

export async function scanStatus(): Promise<ScanStatusResult> {
  const row = await pgGet<{ last_scan: string | null; sources: number; unmapped: number }>(
    `SELECT max(st.scanned_at)::text AS last_scan,
            count(s.*)::int         AS sources,
            COALESCE(sum(st.unmapped), 0)::int AS unmapped
     FROM ${pg("dimension_source")} s
     LEFT JOIN ${pg("source_stat")} st
       ON st.dim_id = s.dim_id AND st.source_table = s.source_table AND st.source_column = s.source_column`,
  ).catch(() => null);
  return {
    lastScanAt: row?.last_scan ?? null,
    sourceCount: Number(row?.sources ?? 0),
    unmappedCount: Number(row?.unmapped ?? 0),
  };
}
```

### Client changes

**`app/src/store.ts`** — update `Preferences`:

```ts
export interface Preferences {
  publishThreshold: number;
  suggestThreshold: number;
  scanSchedule: "15m" | "hourly" | "daily" | null;
}

let preferences: Preferences = { publishThreshold: 95, suggestThreshold: 80, scanSchedule: null };
```

Remove `setSourceSchedule` from store (was used only by `ScanScheduleMenu`). The `SourceInfo.schedule` field and its reference in `refreshSources()` can be removed. Also remove the `scanSources` export if nothing else calls it — leave it if it's still wired to a manual "scan now" button (keep it, the Settings page uses it).

**`app/src/components/ScanScheduleMenu.tsx`** — delete the file entirely.

**`app/src/components/sources/LedgerRow.tsx`** — remove the `ScanScheduleMenu` import and its JSX. The `schedule` prop and any `onScheduleChange` prop are removed.

---

## Part 2: Settings page revamp

### Layout

Keep the existing full-bleed `Section` card pattern (Layout B). Add **Scans** as the first section, above Appearance.

**Width:** Change the root container from `max-w-3xl` to `max-w-[var(--wide)]` — matching Dashboard and MasterTables. Sections get a maximum inner width of `max-w-2xl` on their content areas (labels, inputs) so the form doesn't become unreadably wide on large screens, but the card borders and section chrome span the full `--wide` width.

**Red thread:** All sections use the same `Section` card component with consistent `px-6 py-4` header and `px-6 py-5` body. The active `SegControl` button uses `bg-surface-3 border border-line-2 text-ink` (neutral, matching the rest of the app's selected states). The status dot uses `bg-ok` (green) when all is clean, `bg-accent` (red) when there are unmapped values — mirroring the badge tones used on the Dashboard and Sources page. The `scan now` button uses the same ghost-button class as the existing `Add` button in TeamSection.

Section order after the change:
1. **Scans** (new)
2. Appearance
3. Connections
4. Matching defaults
5. Team

### Scans section

```tsx
function ScansSection() {
  const prefs = usePreferences();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    fetch("/api/sources/scan-status")
      .then(r => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  const handleScheduleChange = (next: "15m" | "hourly" | "daily" | null) =>
    setPreferences({ ...prefs, scanSchedule: next });

  const handleScanNow = async () => {
    setScanning(true);
    try {
      await scanSources();
      const fresh = await fetch("/api/sources/scan-status").then(r => r.json());
      setStatus(fresh);
    } finally {
      setScanning(false);
    }
  };

  return (
    <Section
      title="Scans"
      hint="How often Zug Zug checks your warehouse for new unmapped values."
    >
      <FormField label="Schedule">
        <SegControl
          value={prefs.scanSchedule}
          options={[
            { value: null,     label: "Off" },
            { value: "15m",    label: "15 min" },
            { value: "hourly", label: "Hourly" },
            { value: "daily",  label: "Daily" },
          ]}
          onChange={handleScheduleChange}
        />
      </FormField>
      {status && <ScanStatusStrip status={status} scanning={scanning} onScanNow={handleScanNow} />}
    </Section>
  );
}
```

`ScanStatusStrip` renders the last-scan time (relative: "4 min ago", "never"), source count, and unmapped count. When `scanning` is true, the button shows "Scanning…" and is disabled.

### `SegControl` component

New reusable component at `app/src/components/SegControl.tsx`. Used by the Scans section; can be used elsewhere (e.g., future density toggle if it ever moves to Settings).

```ts
interface SegControlOption<T> {
  value: T;
  label: string;
}

interface SegControlProps<T> {
  value: T;
  options: SegControlOption<T>[];
  onChange: (v: T) => void;
}
```

Renders as a single-row `inline-flex` pill group. Active option gets `bg-surface-3 text-ink border border-line-2` (neutral, not accent — the accent is used for destructive/live state; schedule is a preference, not an alert). Inactive options get `text-ink-3 hover:text-ink-2`. Full `transition-colors`. Each button has `focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none`.

### `ScanStatusStrip` sub-component

Inline to `Settings.tsx` or extracted to `app/src/components/settings/ScanStatusStrip.tsx`. Shows:

```
● last scan 4m ago · 42 sources · 3 unmapped     [scan now]
```

- Dot is `bg-ok` with `animate-pulse` only when `unmappedCount > 0` (there's work to do), else static green.
- "never" when `lastScanAt` is null.
- When `scanSchedule` is null (off), show a muted strip: "Scheduled scanning is off · manual scan available".
- `scan now` button: `bg-surface-2 border border-line-2 text-ink-2` — matches the existing ghost button pattern in Settings.

---

## Part 3: Z-index normalization

### Problem

The app has ad-hoc z-index values spread across files, producing two concrete bugs:
- `UserMenu` panel at `z-20` is hidden behind `TableTabStrip` sticky at `z-40` on narrow viewports.
- `ScanScheduleMenu` (being removed) used `z-50` from inside a Sources row; no portal.

After removal of `ScanScheduleMenu`, remaining z-index usages and their correct assignment:

| Element | File | Current | Correct | Fix |
|---|---|---|---|---|
| `TableTabStrip` sticky | `TableTabStrip.tsx:196` | `z-40` | `z-10` | Lower sticky to z-10 |
| `UserMenu` backdrop | `AppShell.tsx:85` | `z-10` | `z-30` | Raise backdrop |
| `UserMenu` panel | `AppShell.tsx:86` | `z-20` | `z-40` | Raise panel above sticky |
| `ComboSelect` dropdown | `ComboSelect.tsx:122` | `z-50` | `z-40` | Match UserMenu panel |
| `CatalogExplorer` | check | varies | `z-40` | Normalize |
| `CommandPalette` | `CommandPalette.tsx` | `z-50` | `z-50` | No change (top of stack) |
| `CreateTableModal` overlay | | `z-50` | `z-50` | No change |
| `HiddenFieldsPopover` | | `z-50` | `z-40` | Lower to match dropdowns |
| `ColumnHeaderMenu` | | `z-50` | `z-40` | Lower to match dropdowns |
| `AddFieldPopover` | | `z-50` | `z-40` | Lower to match dropdowns |

**Layer vocabulary** (in `tokens.css` as a comment block for reference):
```css
/* Z-index layers:
 *   10  — sticky surfaces (tab strip, toolbar headers)
 *   30  — modal backdrops
 *   40  — dropdowns, popovers, user menu panel
 *   50  — full-screen overlays (command palette, modals)
 */
```

No Tailwind token changes needed — we use the existing `z-10 / z-30 / z-40 / z-50` classes. The comment is for humans reading `tokens.css`.

### Priority fixes

The only user-visible breakage today is `UserMenu` rendering behind `TableTabStrip`. Fix that first. Remaining normalizations (lowering `z-50` dropdowns to `z-40`) are cosmetic order-of-operations cleanup and don't cause visible bugs.

---

## Part 4: Focus ring sweep

### Standard

Every interactive element (button, link, input, toggle) must have a visible focus ring when navigated via keyboard. The ring pattern used by `ak-btn` and the ThresholdRange slider is:

```css
focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none
```

Use `focus-visible:` (not `focus:`) everywhere — `focus-visible` only shows the ring on keyboard focus, not mouse click.

### Missing rings — exhaustive list

| Element | File | Missing classes |
|---|---|---|
| Sign-out button | `AppShell.tsx` ~line 94 | `focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none` |
| Shortcuts overlay trigger (keyboard icon) | `AppShell.tsx` ~line 383 | same |
| Command palette trigger (search bar) | `AppShell.tsx` ~line 394 | same |
| Sidebar collapse toggle | `AppShell.tsx` (sidebar top) | same |
| Tab close `×` button | `TableTabStrip.tsx` | `focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:outline-none` (also make keyboard-accessible: add `tabIndex={0}` — currently `opacity-0` hides it from keyboard users) |
| `+` new tab button | `TableTabStrip.tsx` ~line 64 | `focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none` |

The tab-close button needs `tabIndex={0}` in addition to the ring so it receives keyboard focus at all. Use `focus-visible:opacity-100` to make it visible when focused, overriding the `opacity-0` default.

### Consistency with existing rings

Two existing patterns exist in the codebase:
- `focus:ring-1 focus:ring-accent/40` (older, uses `focus:` not `focus-visible:`)
- `focus-visible:shadow-[0_0_0_3px_var(--accent-soft)]` (one-off on ThresholdRange)

Both are fine where they are — this polish pass only adds rings to elements that have none. Do not change existing rings; only add to elements currently missing any ring.

---

## Part 5: `transition-colors` consistency

Any element with a `hover:bg-*` or `hover:text-*` class should also have `transition-colors` to avoid jarring instant color changes. Sweep the explicitly broken spots:

| Element | File | Fix |
|---|---|---|
| Sign-out button | `AppShell.tsx` ~line 94 | add `transition-colors` |
| All `hover:bg-hover` elements missing it | various | add `transition-colors` |

The sign-out button is the only confirmed missing case from the audit. Others may be present — implementer should grep for `hover:bg-hover` without `transition-colors` in the same className string and add it.

---

## Part 6: `schedule` column cleanup

After removing `ScanScheduleMenu` and workspace-level scheduling is wired:

- `dimension_source.schedule` column becomes unused. **Do not drop it in this pass** — it may contain data, and a migration to drop it is a separate PR. The column becomes inert (never written, never read).
- `SourceInfo.schedule` field in TypeScript can be removed from `repo-scan.ts`, `app/src/store.ts`, and any place that reads it. The field was only used by `ScanScheduleMenu`.
- `setSourceSchedule()` in `repo-scan.ts` is dead code — remove the function and any route that calls it.
- `PUT /api/dimensions/:id/sources/schedule` route in `server.ts` (~line 270) — remove it.

Check `server.ts` for any routes wired to `setSourceSchedule` and remove them.

---

## Files touched

| File | Change |
|---|---|
| `server/drizzle/schema.ts` | Add `scan_schedule varchar(10)` to preferences |
| `server/drizzle/migrations/` | Generated migration file from `db:generate` |
| `server/src/repo-meta.ts` | `Preferences` type + `getPreferences` / `setPreferences` |
| `server/src/repo-scan.ts` | Replace `anyScanDue()`, add `scanStatus()`, remove `setSourceSchedule()`, clean `SourceInfo.schedule` |
| `server/src/server.ts` | Update preferences route, add `scan-status` endpoint, remove schedule route |
| `app/src/store.ts` | `Preferences` type, drop `setSourceSchedule`, drop `SourceInfo.schedule` |
| `app/src/components/ScanScheduleMenu.tsx` | **Delete** |
| `app/src/components/sources/LedgerRow.tsx` | Remove `schedule` prop, `ScanScheduleMenu` import and JSX |
| `app/src/components/SegControl.tsx` | **New** generic segmented control |
| `app/src/routes/Settings.tsx` | Add `ScansSection` (first section), reorder, import `SegControl` |
| `app/src/tokens.css` | Add z-index layer comment |
| `app/src/components/AppShell.tsx` | Fix UserMenu z-index, add 4 focus rings, add `transition-colors` |
| `app/src/components/TableTabStrip.tsx` | Lower `z-40 → z-10`, add focus rings to `+` and close buttons |
| `app/src/components/ComboSelect.tsx` | `z-50 → z-40` |
| `app/src/components/datagrid/HiddenFieldsPopover.tsx` | `z-50 → z-40` |
| `app/src/components/datagrid/ColumnHeaderMenu.tsx` | `z-50 → z-40` |
| `app/src/components/AddFieldPopover.tsx` | `z-50 → z-40` |

---

## What is NOT in scope

- Dropping `dimension_source.schedule` column (safe to do, but a separate migration PR)
- Per-source schedule overrides (Option B from the brainstorm) — explicitly deferred
- Portal-based dropdown rendering (React portals for absolute positioned dropdowns) — z-index normalization is sufficient for all current breakages; portals add complexity with no user-visible gain at this scale
- Animated status strip auto-refresh (polling) — manual "scan now" is enough for now

---

## Testing

| Layer | Coverage |
|---|---|
| Unit | No new pure-logic units; `anyScanDue()` contract test: null schedule → false, "daily" with never-scanned → true, "daily" with recent scan → false |
| Migration | Verify `bun run db:generate` produces a clean migration; apply it against the dev DB and confirm `preferences` row gains a null `scan_schedule` |
| Manual — scheduling | Set schedule to "daily" in Settings → server log shows scan firing within the minute tick; set to "off" → no auto-scan fires |
| Manual — status strip | Run "scan now" → strip updates with fresh timestamp and counts |
| Manual — z-index | Open UserMenu while TableTabStrip is visible → panel renders on top; open ComboSelect near bottom of viewport → dropdown doesn't clip through the floor |
| Manual — focus rings | Tab through AppShell sidebar, tab strip close buttons, Settings form — every interactive element shows visible ring |
