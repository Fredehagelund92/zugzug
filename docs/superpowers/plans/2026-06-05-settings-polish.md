***REMOVED*** Settings Revamp + UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-row scan scheduling with a single workspace setting in the Settings page, revamp the Settings page layout to match the rest of the app (full-width, red-thread design), and sweep z-index + focus ring + transition-colors polish issues.

**Architecture:** Server adds `scan_schedule` to the `preferences` table; `anyScanDue()` reads it instead of per-source rows. The client gets a new `SegControl` component used in a new Scans section at the top of Settings. `ScanScheduleMenu` is deleted entirely. Z-index and focus ring fixes are surgical per-file edits.

**Tech Stack:** Bun server (TypeScript), Drizzle ORM + Postgres, React 18 + TypeScript + Tailwind v4, Vitest

---

***REMOVED******REMOVED*** File map

| File | Change |
|---|---|
| `server/drizzle/schema.ts` | Add `scan_schedule varchar(10)` nullable column |
| `server/drizzle/migrations/` | New generated migration |
| `server/src/repo-meta.ts` | `Preferences` type + `getPreferences` + `setPreferences` |
| `server/src/repo-scan.ts` | Replace `anyScanDue()`, add `scanStatus()`, remove `setSourceSchedule()`, remove `SourceInfo.schedule` from `listSources()` |
| `server/src/server.ts` | Add `scan-status` endpoint, update preferences route, remove schedule route |
| `app/src/store.ts` | `Preferences` type update, remove `setSourceSchedule`, remove `SourceInfo.schedule` |
| `app/src/components/ScanScheduleMenu.tsx` | **Delete** |
| `app/src/components/sources/LedgerRow.tsx` | Remove `schedule` prop + `ScanScheduleMenu` import + JSX |
| `app/src/components/SegControl.tsx` | **New** — reusable segmented-control component |
| `app/src/routes/Settings.tsx` | Add `ScansSection`, fix container width, reorder sections |
| `app/src/tokens.css` | Add z-index layer comment |
| `app/src/components/AppShell.tsx` | UserMenu z-index fix + 3 focus rings + sign-out transition-colors |
| `app/src/components/TableTabStrip.tsx` | `z-40 → z-10`, focus rings on close + new-tab buttons |
| `app/src/components/ComboSelect.tsx` | `z-50 → z-40` |
| `app/src/components/datagrid/HiddenFieldsPopover.tsx` | `z-50 → z-40` |
| `app/src/components/datagrid/ColumnHeaderMenu.tsx` | `z-50 → z-40` |
| `app/src/components/AddFieldPopover.tsx` | `z-50 → z-40` |

---

***REMOVED******REMOVED*** Task 1: Drizzle schema + migration

**Files:**
- Modify: `server/drizzle/schema.ts`
- Create: `server/drizzle/migrations/0002_*.sql` (generated)

- [ ] **Step 1: Add column to schema**

Open `server/drizzle/schema.ts`. The `preferences` table currently ends with `updated_at`. Add `scan_schedule` before it:

```ts
export const preferences = app.table("preferences", {
  id:                integer("id").primaryKey(),
  publish_threshold: integer("publish_threshold").notNull(),
  suggest_threshold: integer("suggest_threshold").notNull(),
  scan_schedule:     varchar("scan_schedule", { length: 10 }),
  updated_at:        timestamp("updated_at").notNull(),
});
```

- [ ] **Step 2: Generate the migration**

```bash
cd server && bun run db:generate
```

Expected: a new file `server/drizzle/migrations/0002_*.sql` is created. Its contents should look like:

```sql
ALTER TABLE "zugzug_app"."preferences" ADD COLUMN IF NOT EXISTS "scan_schedule" varchar(10);
```

If the file isn't created or contains unexpected statements, stop and investigate.

- [ ] **Step 3: Apply the migration**

```bash
cd server && bun run db:migrate
```

Expected output ends with "Migrations applied" or "No pending migrations" (if already applied).

- [ ] **Step 4: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/
git commit -m "feat(db): add scan_schedule to preferences table"
```

---

***REMOVED******REMOVED*** Task 2: Server — Preferences type + repo-meta CRUD

**Files:**
- Modify: `server/src/repo-meta.ts`

Context: `repo-meta.ts` owns the `Preferences` interface and the two functions that read/write it. The `preferences` row has `id=1` (always). After this task, `getPreferences()` returns `scanSchedule` and `setPreferences()` persists it.

- [ ] **Step 1: Update the `Preferences` interface**

Find the interface near the top of `server/src/repo-meta.ts` (around where `publish_threshold` / `suggest_threshold` are referenced). Replace it so it includes `scanSchedule`:

```ts
export interface Preferences {
  publishThreshold: number;
  suggestThreshold: number;
  scanSchedule: "15m" | "hourly" | "daily" | null;
}
```

- [ ] **Step 2: Update `getPreferences`**

Replace the existing `getPreferences()` function:

```ts
export async function getPreferences(): Promise<Preferences> {
  const row = await pgGet<{
    publish_threshold: number;
    suggest_threshold: number;
    scan_schedule: string | null;
  }>(
    `SELECT publish_threshold, suggest_threshold, scan_schedule
     FROM ${pg("preferences")} WHERE id = 1`,
  );
  const validSchedule = ["15m", "hourly", "daily"] as const;
  const sched = row?.scan_schedule ?? null;
  return {
    publishThreshold: row?.publish_threshold ?? 95,
    suggestThreshold: row?.suggest_threshold ?? 80,
    scanSchedule: validSchedule.includes(sched as (typeof validSchedule)[number])
      ? (sched as Preferences["scanSchedule"])
      : null,
  };
}
```

- [ ] **Step 3: Update `setPreferences`**

Replace the existing `setPreferences()` function:

```ts
export async function setPreferences(p: Preferences): Promise<void> {
  const valid = p.scanSchedule === null || ["15m", "hourly", "daily"].includes(p.scanSchedule);
  if (!valid) throw new Error(`invalid scanSchedule: ${String(p.scanSchedule)}`);
  await pgRun(
    `UPDATE ${pg("preferences")}
     SET publish_threshold = $1, suggest_threshold = $2,
         scan_schedule = $3, updated_at = current_timestamp
     WHERE id = 1`,
    [p.publishThreshold, p.suggestThreshold, p.scanSchedule],
  );
}
```

- [ ] **Step 4: Verify the server builds**

```bash
cd server && bun run typecheck 2>&1 | tail -5
```

Expected: no TypeScript errors. If there are errors about `Preferences` mismatch — the server.ts route (Task 4) references the old type and will be fixed there.

- [ ] **Step 5: Commit**

```bash
git add server/src/repo-meta.ts
git commit -m "feat(server): workspace scan_schedule in Preferences"
```

---

***REMOVED******REMOVED*** Task 3: Server — anyScanDue + scanStatus + setSourceSchedule removal

**Files:**
- Modify: `server/src/repo-scan.ts`

Context: `anyScanDue()` currently queries per-source schedules across `dimension_source`. We replace it with a single read of `preferences.scan_schedule` plus the most-recent `scanned_at` across all sources. We also add `scanStatus()` (powers the Settings status strip) and delete the now-dead `setSourceSchedule()`.

- [ ] **Step 1: Replace `anyScanDue()`**

Find and replace the existing `anyScanDue` function in `server/src/repo-scan.ts`:

```ts
export async function anyScanDue(now: Date = new Date()): Promise<boolean> {
  let sched: string | null;
  let lastScan: Date | null;
  try {
    const row = await pgGet<{ scan_schedule: string | null; last_scan: string | null }>(
      `SELECT p.scan_schedule,
              (SELECT max(st.scanned_at)::text
               FROM ${pg("source_stat")} st) AS last_scan
       FROM ${pg("preferences")} p WHERE p.id = 1`,
    );
    if (!row) return false;
    sched = row.scan_schedule;
    lastScan = row.last_scan ? new Date(row.last_scan) : null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/relation.*zugzug_app.*does not exist/i.test(msg)) return false;
    throw e;
  }
  if (!sched) return false;
  if (!lastScan) return true; // never scanned → run immediately
  const dueMs =
    sched === "15m" ? 15 * 60_000 : sched === "hourly" ? 60 * 60_000 : 24 * 60 * 60_000;
  return now.getTime() - lastScan.getTime() >= dueMs;
}
```

- [ ] **Step 2: Add `scanStatus()`**

Add this function directly after `anyScanDue()`:

```ts
export interface ScanStatusResult {
  lastScanAt: string | null;
  sourceCount: number;
  unmappedCount: number;
}

export async function scanStatus(): Promise<ScanStatusResult> {
  const row = await pgGet<{
    last_scan: string | null;
    sources: number;
    unmapped: number;
  }>(
    `SELECT max(st.scanned_at)::text                   AS last_scan,
            count(s.*)::int                            AS sources,
            COALESCE(sum(st.unmapped), 0)::int         AS unmapped
     FROM ${pg("dimension_source")} s
     LEFT JOIN ${pg("source_stat")} st
       ON  st.dim_id = s.dim_id
       AND st.source_table  = s.source_table
       AND st.source_column = s.source_column`,
  ).catch(() => null);
  return {
    lastScanAt:    row?.last_scan   ?? null,
    sourceCount:   Number(row?.sources ?? 0),
    unmappedCount: Number(row?.unmapped ?? 0),
  };
}
```

- [ ] **Step 3: Remove `setSourceSchedule()`**

Delete the entire `setSourceSchedule` function (the one that UPDATEs `dimension_source.schedule`). It's no longer called.

- [ ] **Step 4: Remove `schedule` from `listSources()`**

In the `listSources()` SQL query, find the line `s.schedule AS schedule,` and remove it. In the returned mapping object also remove `schedule: r.schedule ?? null`. In the `pgAll` generic type, remove the `schedule: string | null` field. The `SourceInfo` type returned still has `schedule?: string | null` — leave that for the client cleanup task (Task 5); it's harmless while unused.

- [ ] **Step 5: Verify no TypeScript errors**

```bash
cd server && bun run typecheck 2>&1 | tail -5
```

Expected: clean. `setSourceSchedule` still appears in `server.ts` (route handler) — it will cause an error here until Task 4, which is fine: fix Task 4 next.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-scan.ts
git commit -m "feat(server): workspace-level anyScanDue + scanStatus, remove setSourceSchedule"
```

---

***REMOVED******REMOVED*** Task 4: Server — route updates

**Files:**
- Modify: `server/src/server.ts`

Context: Three route changes — update the preferences route to pass `scanSchedule`, add a new `GET /api/sources/scan-status` endpoint, and remove the dead `PUT /api/dimensions/:id/sources/schedule` route.

- [ ] **Step 1: Update the preferences route**

Find the block starting with `// GET /api/preferences ; PUT /api/preferences`. The current PUT handler destructures `{ publishThreshold, suggestThreshold }`. Change it to also pass `scanSchedule`:

```ts
if (method === "PUT") {
  const p = (await req.json()) as {
    publishThreshold: number;
    suggestThreshold: number;
    scanSchedule: string | null;
  };
  await repo.setPreferences(p);
  return noContent();
}
```

- [ ] **Step 2: Add the scan-status endpoint**

Find the block that handles `seg[2] === "scan"` (the `POST /api/sources/scan` endpoint). Directly above it, add:

```ts
if (seg[2] === "scan-status" && seg.length === 3 && method === "GET")
  return json(await repo.scanStatus());
```

- [ ] **Step 3: Remove the dead schedule route**

Find and delete the block:

```ts
// PUT /api/dimensions/:id/sources/schedule {table, column, schedule}
if (seg[3] === "sources" && seg[4] === "schedule" && seg.length === 5 && method === "PUT") {
  const { table, column, schedule } = (await req.json()) as {
    table: string;
    column: string;
    schedule: string | null;
  };
  await repo.setSourceSchedule(id, table, column, schedule);
  return noContent();
}
```

- [ ] **Step 4: Verify the server starts**

```bash
cd server && bun run build 2>&1 | tail -10
```

Expected: no errors referencing `setSourceSchedule` or `Preferences` type mismatch.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): scan-status endpoint, updated preferences route, remove schedule route"
```

---

***REMOVED******REMOVED*** Task 5: Client store cleanup

**Files:**
- Modify: `app/src/store.ts`

Context: The store's `Preferences` interface needs `scanSchedule`. The `setSourceSchedule` export and `SourceInfo.schedule` field become dead code.

- [ ] **Step 1: Update `Preferences` interface (around line 66)**

```ts
export interface Preferences {
  publishThreshold: number;
  suggestThreshold: number;
  scanSchedule: "15m" | "hourly" | "daily" | null;
}
```

- [ ] **Step 2: Update default preferences value (around line 76)**

```ts
let preferences: Preferences = { publishThreshold: 95, suggestThreshold: 80, scanSchedule: null };
```

- [ ] **Step 3: Remove `SourceInfo.schedule` field**

In the `SourceInfo` interface (around line 40–55), remove:

```ts
schedule?: string | null; // null | '15m' | 'hourly' | 'daily'
```

- [ ] **Step 4: Remove `setSourceSchedule` export**

Delete the entire `setSourceSchedule` function (the one that calls `/dimensions/:id/sources/schedule`). It's around line 338–348.

- [ ] **Step 5: Check for TypeScript errors**

```bash
cd app && bun run typecheck 2>&1 | tail -20
```

If `ScanScheduleMenu.tsx` or `LedgerRow.tsx` import or reference `setSourceSchedule` / `SourceInfo.schedule`, those will error here — fix them in the next two tasks. Any other TS errors should be investigated now.

- [ ] **Step 6: Commit**

```bash
git add app/src/store.ts
git commit -m "refactor(store): workspace Preferences.scanSchedule, drop setSourceSchedule + schedule field"
```

---

***REMOVED******REMOVED*** Task 6: Delete ScanScheduleMenu + clean LedgerRow

**Files:**
- Delete: `app/src/components/ScanScheduleMenu.tsx`
- Modify: `app/src/components/sources/LedgerRow.tsx`

Context: ScanScheduleMenu is the per-row clock-icon popover. LedgerRow imports and renders it. Both become dead code once scheduling moves to Settings.

- [ ] **Step 1: Delete ScanScheduleMenu**

```bash
rm app/src/components/ScanScheduleMenu.tsx
```

- [ ] **Step 2: Clean LedgerRow**

Open `app/src/components/sources/LedgerRow.tsx`. Remove:
- The `import { ScanScheduleMenu } from ...` line
- The `schedule?: string | null` prop from the props interface
- The `onScheduleChange?: (s: string | null) => void` prop (if present)
- The `<ScanScheduleMenu ... />` JSX wherever it appears in the component body

The LedgerRow still renders the row — just without the schedule clock icon. No other behavioral changes.

- [ ] **Step 3: Verify typecheck is clean**

```bash
cd app && bun run typecheck 2>&1 | grep -i "error" | head -10
```

Expected: no errors related to `ScanScheduleMenu` or `schedule`.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/ScanScheduleMenu.tsx app/src/components/sources/LedgerRow.tsx
git commit -m "feat(sources): remove per-row ScanScheduleMenu — scheduling is now workspace-level"
```

---

***REMOVED******REMOVED*** Task 7: SegControl component

**Files:**
- Create: `app/src/components/SegControl.tsx`

Context: A reusable segmented-control (pill group of buttons). Used in the new Settings Scans section for schedule selection. Supports `string | null` values so "Off" maps to `null`.

- [ ] **Step 1: Create the file**

```bash
touch app/src/components/SegControl.tsx
```

- [ ] **Step 2: Write the component**

```tsx
import { cx } from "../lib/cx";

interface SegControlOption {
  value: string | null;
  label: string;
}

interface SegControlProps {
  value: string | null;
  options: SegControlOption[];
  onChange: (v: string | null) => void;
}

export function SegControl({ value, options, onChange }: SegControlProps) {
  return (
    <div
      role="group"
      className="inline-flex items-center gap-0.5 rounded-md border border-line bg-surface p-0.5"
    >
      {options.map((opt) => (
        <button
          key={String(opt.value)}
          type="button"
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
          className={cx(
            "rounded-[4px] px-3 py-1.5 font-mono text-[11.5px] transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
            opt.value === value
              ? "border border-line-2 bg-surface-3 text-ink shadow-sm"
              : "text-ink-3 hover:text-ink-2",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | grep "SegControl" | head -5
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/SegControl.tsx
git commit -m "feat(ui): SegControl — reusable segmented control component"
```

---

***REMOVED******REMOVED*** Task 8: Settings revamp

**Files:**
- Modify: `app/src/routes/Settings.tsx`

Context: Add `ScansSection` as the first section (with `SegControl` + status strip + "scan now" button), fix container width to match Dashboard/MasterTables, and reorder sections so Scans comes first.

- [ ] **Step 1: Add the `ScanStatus` interface and `relativeTime` helper at the top of Settings.tsx**

Add after the existing imports and before the `Section` component:

```ts
interface ScanStatus {
  lastScanAt: string | null;
  sourceCount: number;
  unmappedCount: number;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
```

- [ ] **Step 2: Add imports**

At the top of the file add:

```ts
import { SegControl } from "../components/SegControl";
import { scanSources } from "../store";
```

(`scanSources` is already exported from the store — it calls `POST /api/sources/scan`.)

- [ ] **Step 3: Add `ScansSection`**

Add the new component after `relativeTime` and before `TeamSection`:

```tsx
function ScansSection() {
  const prefs = usePreferences();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    fetch("/api/sources/scan-status")
      .then((r) => r.json() as Promise<ScanStatus>)
      .then(setStatus)
      .catch(() => {});
  }, []);

  const handleScheduleChange = (next: string | null) => {
    void setPreferences({
      ...prefs,
      scanSchedule: next as "15m" | "hourly" | "daily" | null,
    });
  };

  const handleScanNow = async () => {
    setScanning(true);
    try {
      await scanSources();
      const fresh = await fetch("/api/sources/scan-status").then(
        (r) => r.json() as Promise<ScanStatus>,
      );
      setStatus(fresh);
    } finally {
      setScanning(false);
    }
  };

  const scheduleOptions = [
    { value: null,      label: "Off" },
    { value: "15m",     label: "15 min" },
    { value: "hourly",  label: "Hourly" },
    { value: "daily",   label: "Daily" },
  ];

  return (
    <Section
      title="Scans"
      hint="How often Zug Zug checks your warehouse sources for new unmapped values."
    >
      <FormField label="Schedule">
        <SegControl
          value={prefs.scanSchedule}
          options={scheduleOptions}
          onChange={handleScheduleChange}
        />
      </FormField>

      {status && (
        <div className="flex items-center justify-between rounded-sm border border-line bg-surface-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className={cx(
                "inline-block h-2 w-2 rounded-full",
                status.unmappedCount > 0
                  ? "bg-accent shadow-[0_0_6px_var(--accent)]"
                  : "bg-ok shadow-[0_0_6px_var(--ok)]",
              )}
            />
            <span className="font-mono text-[11.5px] text-ink-2">
              last scan {relativeTime(status.lastScanAt)}
              {" · "}
              {status.sourceCount} {status.sourceCount === 1 ? "source" : "sources"}
              {status.unmappedCount > 0 && (
                <span className="text-accent"> · {status.unmappedCount} unmapped</span>
              )}
            </span>
          </div>
          <Button onClick={() => void handleScanNow()} disabled={scanning}>
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
        </div>
      )}

      {!status && prefs.scanSchedule && (
        <p className="font-mono text-[11px] text-ink-3">Loading scan status…</p>
      )}
    </Section>
  );
}
```

- [ ] **Step 4: Update `Settings()` — fix width + reorder sections**

Find the `return` block inside `Settings()`. Change the container width and move Scans to the top:

```tsx
export function Settings() {
  const { engineer, setEngineer } = useEngineerMode();
  const prefs = usePreferences();

  return (
    <div className="mx-auto w-full max-w-[var(--wide)] space-y-6 p-8">
      <PageHeader kicker="Workspace" title="Settings" lede="Changes are saved as you make them." />

      <div className="zz-rise" style={{ animationDelay: "60ms" }}>
        <ScansSection />
      </div>

      <div className="zz-rise" style={{ animationDelay: "100ms" }}>
        <Section title="Appearance" hint="Theme follows the toggle in the top bar.">
          <FormField label="Engineer details">
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={engineer}
                aria-label="Engineer details"
                onClick={() => setEngineer(!engineer)}
                className={cx("ak-toggle", engineer && "on")}
              />
              <span className="text-[13px] text-ink-2">
                Show warehouse table names, SQL, and join warnings
              </span>
            </div>
          </FormField>
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "140ms" }}>
        <Section
          title="Connections"
          hint={
            engineer
              ? "Reads your warehouse (MotherDuck), writes records to its own MotherDuck database, and keeps multi-user app state in Postgres."
              : "Where Zug Zug is connected."
          }
        >
          {engineer ? (
            <>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[14px] font-semibold text-ink">
                      Warehouse
                    </span>
                    <Badge>read-only</Badge>
                  </div>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
                  <span className="text-ink-2">md:analytics</span>
                  <span>·</span>
                  <span>attached &amp; scanned for source values — never written to</span>
                </div>
              </div>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[14px] font-semibold text-ink">
                      Master store
                    </span>
                    <Badge>MotherDuck</Badge>
                  </div>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
                  <span className="text-ink-2">md:zugzug</span>
                  <span>·</span>
                  <span>its own database — every dim_* master + map_* lookup dbt joins</span>
                </div>
              </div>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[14px] font-semibold text-ink">
                      App state
                    </span>
                    <Badge tone="accent">Postgres</Badge>
                  </div>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
                  <span className="text-ink-2">postgres://zugzug</span>
                  <span>·</span>
                  <span>drafts, audit log, users &amp; presence — the multi-user layer</span>
                </div>
              </div>
              <p className="font-mono text-[10.5px] leading-relaxed text-ink-3">
                DuckDB{" "}
                <span className="text-ink-2">ATTACH … (TYPE postgres)</span> bridges them — a
                single scan can join live drafts ⋈ master ⋈ warehouse.
              </p>
            </>
          ) : (
            <>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[14px] font-semibold text-ink">Warehouse</span>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-1 text-[12.5px] text-ink-2">
                  Reading from your warehouse — read-only.
                </div>
              </div>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[14px] font-semibold text-ink">
                    Master store
                  </span>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-1 text-[12.5px] text-ink-2">
                  Stores every table — this is what downstream models pick up.
                </div>
              </div>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[14px] font-semibold text-ink">Workspace</span>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-1 text-[12.5px] text-ink-2">
                  Drafts, history, and your team — the collaborative layer.
                </div>
              </div>
            </>
          )}
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "180ms" }}>
        <Section
          title="Matching defaults"
          hint="How aggressively Zug Zug matches new values when a scan finds them."
        >
          <FormField label="Confidence bands">
            <ThresholdRange
              publish={prefs.publishThreshold}
              suggest={prefs.suggestThreshold}
              onChange={({ publish, suggest }) =>
                setPreferences({ ...prefs, publishThreshold: publish, suggestThreshold: suggest })
              }
            />
          </FormField>
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "220ms" }}>
        <TeamSection />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | grep -i "error" | head -10
```

Expected: no errors. If `scanSources` isn't exported from the store, check `app/src/store.ts` — it should be. If `cx` isn't imported, add it to the imports.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/Settings.tsx
git commit -m "feat(settings): Scans section + workspace schedule + full-width layout"
```

---

***REMOVED******REMOVED*** Task 9: Z-index normalization

**Files:**
- Modify: `app/src/tokens.css`
- Modify: `app/src/components/AppShell.tsx`
- Modify: `app/src/components/TableTabStrip.tsx`
- Modify: `app/src/components/ComboSelect.tsx`
- Modify: `app/src/components/datagrid/HiddenFieldsPopover.tsx`
- Modify: `app/src/components/datagrid/ColumnHeaderMenu.tsx`
- Modify: `app/src/components/AddFieldPopover.tsx`

Context: The critical bug is `UserMenu` (z-20) rendering behind `TableTabStrip` (z-40). We define a clear z-layer vocabulary and apply it consistently.

Layer vocabulary:
- `z-10` — sticky surfaces (tab strip, toolbar headers)
- `z-30` — modal/overlay backdrops
- `z-40` — dropdowns, popovers, user menu panel
- `z-50` — full-screen overlays (command palette, dialogs)

- [ ] **Step 1: Add z-layer comment to tokens.css**

At the end of `app/src/tokens.css` add:

```css
/* Z-index layers:
 *   10  — sticky surfaces (tab strip, toolbar headers)
 *   30  — overlay/modal backdrops
 *   40  — dropdowns, popovers, context menus
 *   50  — full-screen overlays (command palette, modals)
 */
```

- [ ] **Step 2: Fix UserMenu z-index in AppShell.tsx**

Find the UserMenu popover (around line 84–86):

Current:
```tsx
<div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
<div className="zz-pop-in absolute right-0 top-10 z-20 min-w-[160px] ...">
```

Change to:
```tsx
<div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
<div className="zz-pop-in absolute right-0 top-10 z-40 min-w-[160px] ...">
```

- [ ] **Step 3: Lower TableTabStrip sticky from z-40 to z-10**

In `app/src/components/TableTabStrip.tsx`, find (around line 196):

```tsx
className="sticky top-0 z-40 flex h-9 items-stretch border-b border-line bg-surface-2"
```

Change `z-40` to `z-10`.

- [ ] **Step 4: Lower ComboSelect dropdown from z-50 to z-40**

In `app/src/components/ComboSelect.tsx`, find the dropdown div with `z-50` (around line 122):

```tsx
className="zz-pop-in absolute left-0 z-50 mt-1 ..."
```

Change `z-50` to `z-40`.

- [ ] **Step 5: Lower HiddenFieldsPopover from z-50 to z-40**

In `app/src/components/datagrid/HiddenFieldsPopover.tsx`, find `z-50` on the popover div and change to `z-40`.

- [ ] **Step 6: Lower ColumnHeaderMenu from z-50 to z-40**

In `app/src/components/datagrid/ColumnHeaderMenu.tsx`, find `z-50` on the menu div and change to `z-40`.

- [ ] **Step 7: Lower AddFieldPopover from z-50 to z-40**

In `app/src/components/AddFieldPopover.tsx`, find `z-50` on the popover div and change to `z-40`.

- [ ] **Step 8: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | grep -i "error" | head -5
```

Expected: no errors. Z-index is in className strings, not TypeScript — this is really just a sanity check.

- [ ] **Step 9: Commit**

```bash
git add app/src/tokens.css app/src/components/AppShell.tsx app/src/components/TableTabStrip.tsx app/src/components/ComboSelect.tsx app/src/components/datagrid/HiddenFieldsPopover.tsx app/src/components/datagrid/ColumnHeaderMenu.tsx app/src/components/AddFieldPopover.tsx
git commit -m "fix(ui): normalize z-index layers — UserMenu visible above TabStrip"
```

---

***REMOVED******REMOVED*** Task 10: Focus ring + transition-colors sweep

**Files:**
- Modify: `app/src/components/AppShell.tsx`
- Modify: `app/src/components/TableTabStrip.tsx`

Context: Several interactive elements are missing `focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none` — they're invisible to keyboard users. The tab close button also needs `focus-visible:opacity-100` to become visible when focused (it's `opacity-0` by default for non-active tabs). The sign-out button is also missing `transition-colors`.

Standard focus ring class to add to every element: `focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none`

- [ ] **Step 1: Sidebar collapse toggle — AppShell.tsx**

Find the sidebar toggle button (around line 388). Its current className:
```
"grid h-8 w-8 place-items-center rounded-sm border border-line-2 text-ink-2 transition-colors hover:border-accent hover:text-ink"
```

Add focus ring:
```
"grid h-8 w-8 place-items-center rounded-sm border border-line-2 text-ink-2 transition-colors hover:border-accent hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
```

- [ ] **Step 2: Command palette trigger — AppShell.tsx**

Find the palette trigger button (around line 394). Add focus ring:
```
"flex h-8 min-w-[260px] max-w-[420px] flex-1 items-center gap-2 rounded-sm border border-line-2 bg-surface px-3 text-left text-[12.5px] text-ink-3 transition-colors hover:border-accent hover:text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
```

- [ ] **Step 3: Sign-out button — AppShell.tsx**

Find the sign-out button (around line 94). Its current className:
```
"w-full px-3 py-2 text-left text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
```

Add focus ring and transition-colors:
```
"w-full px-3 py-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
```

- [ ] **Step 4: Tab close button — TableTabStrip.tsx**

Find the close button (around line 162). Its current className uses `cx()` with conditional opacity:
```tsx
className={cx(
  "grid h-4 w-4 place-items-center rounded-sm text-ink-3 transition-opacity hover:bg-line hover:text-ink",
  active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
)}
```

Change to (add `focus-visible:opacity-100` to always-on classes, plus ring):
```tsx
className={cx(
  "grid h-4 w-4 place-items-center rounded-sm text-ink-3 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 hover:bg-line hover:text-ink",
  active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
)}
```

(`ring-1` not `ring-2` because the button is tiny — `ring-1` looks proportional.)

- [ ] **Step 5: New tab (+) button — TableTabStrip.tsx**

Find the `+` button (around line 221). Its current className:
```
"grid h-full w-9 place-items-center text-ink-3 transition-colors hover:bg-hover hover:text-accent"
```

Add focus ring:
```
"grid h-full w-9 place-items-center text-ink-3 transition-colors hover:bg-hover hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
```

- [ ] **Step 6: Typecheck and commit**

```bash
cd app && bun run typecheck 2>&1 | grep -i "error" | head -5
git add app/src/components/AppShell.tsx app/src/components/TableTabStrip.tsx
git commit -m "fix(a11y): focus rings on sidebar toggle, palette trigger, sign-out, tab close, new-tab button"
```

---

***REMOVED******REMOVED*** Final verification

- [ ] Start the dev server: `cd app && bun run dev`
- [ ] Navigate to Settings — confirm Scans section is first, page is full-width matching Dashboard
- [ ] Set schedule to "Daily" — confirm change persists on page reload (server stores it)
- [ ] Click "Scan now" — status strip updates after completion
- [ ] Open UserMenu — confirm panel renders above the TableTabStrip (no longer hidden behind it)
- [ ] Open a ComboSelect — confirm dropdown is visible, not clipped
- [ ] Tab through Settings form — confirm SegControl buttons show focus ring
- [ ] Tab through the top bar — sidebar toggle, palette trigger, and UserMenu avatar all show focus ring
- [ ] Tab to a non-active tab and Tab to its close button — confirm close button becomes visible when focused
