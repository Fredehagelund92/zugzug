# Sources Connection Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the Sources page from a monitoring dashboard ("Operator's Ledger") into a calm connection surface — a grouped, collapsible list of connected columns with add/re-scan/remove, plus a redesigned right-drawer catalog explorer for adding sources.

**Architecture:** Frontend-heavy. One new backend endpoint (`DELETE /dimensions/:id/sources`) + repo function to unwire a column. A new store mutation `removeSource`. A new presentational `SourceRow`. A rewrite of the `Sources.tsx` route (delete monitoring machinery, add collapsible groups + review pointer). A redesign of `CatalogExplorer` into a right slide-over drawer. The per-table workbench (`WiredSourcesModeBody` → `LedgerRow` → `ExpandedDrill`) is left untouched.

**Tech Stack:** React 18 + TypeScript, Vite, Tailwind v4 (`@theme` tokens), custom `useSyncExternalStore` store, `react-router-dom`. Tests: app = Vitest + React Testing Library (`vitest run`); server = `bun test` integration against Postgres test DB (`npm --prefix server run test:db:up` first).

## Global Constraints

- **Language (CLAUDE.md §5):** user-facing strings stay plain — "column", "connected", "table", "Map values", "Review", "source". Never surface "canonical", "raw", "sync", "master", "ledger", "drift", "dimension".
- **Surgical changes (CLAUDE.md §3):** do NOT modify `LedgerRow.tsx`, `ExpandedDrill.tsx`, or `WiredSourcesModeBody.tsx` — they are a separate consumer. Do not refactor adjacent code.
- **Store mutation pattern:** every mutation calls `api(...)` → `refreshX()` → `emit()`, returns after refetch. Mirror `addSource` (`store.ts:901`).
- **Permission gate:** wiring/unwiring endpoints gate on `manage_adapter` via `gateOrJson(tenantCtx, "manage_adapter")`.
- **Accent discipline:** accent (`--accent`) only for status (pending counts, the `+`, active states) and the drawer spine; success in `--ok` green. Everything else in ink tokens.
- **Visual source of truth for markup:** the two approved mockups —
  `docs/superpowers/specs/mockups/2026-07-17-sources-connection-surface.html` and
  `docs/superpowers/specs/mockups/2026-07-17-catalog-explorer.html`. Translate their structure into the app's Tailwind token classes (`bg-surface`, `text-ink`, `border-line`, `text-accent`, `font-mono`, `font-display`, etc.).

---

## Phase 1 — Backend + store: remove a source

### Task 1: `DELETE /dimensions/:id/sources` endpoint + repo function

**Files:**
- Modify: `server/src/repo-canonical.ts` (add `removeSource` near the source-related exports; reuse the existing `QualifiedSource` type and `resolveDefaultDatabase`)
- Modify: `server/src/server.ts:1101-1156` (add a `DELETE` branch alongside the existing `POST` branch under `seg[3] === "sources"`)
- Test: `server/test/dimension-source-remove.test.ts` (new)

**Interfaces:**
- Consumes: `pgRun` from `../src/pg.ts`; `resolveDefaultDatabase(tenantId)`, `QualifiedSource` from `repo-canonical.ts`; `provisionTenant` from `../src/tenant.ts`.
- Produces: `removeSource(dimId: string, source: QualifiedSource, tenantId: string): Promise<void>` — deletes one `dimension_source` row. Idempotent (deleting a nonexistent wiring is a no-op).

- [ ] **Step 1: Write the failing test**

Create `server/test/dimension-source-remove.test.ts`:

```ts
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import "./setup.ts";
import { test, expect, beforeEach, afterAll } from "bun:test";
import { pgAll, pgRun } from "../src/pg.ts";
import { provisionTenant } from "../src/tenant.ts";
import * as canonical from "../src/repo-canonical.ts";

const T = "trm_a";
const D = "trm_thing";

async function cleanup(): Promise<void> {
  await pgRun(`DELETE FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant_member" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."warehouse_database" WHERE tenant_id = $1`, [T]);
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]);
}
beforeEach(cleanup);
afterAll(cleanup);

test("removeSource deletes exactly the one wired column row", async () => {
  await provisionTenant({ id: T, label: "A" });
  await canonical.addDimension(D, [], { keyKind: "slug" }, "u_test", T);

  // register a warehouse database + two wired columns
  const dbId = "wdb_trm";
  await pgRun(
    `INSERT INTO "zugzug_app"."warehouse_database" (id, tenant_id, database_name, created_at)
     VALUES ($1, $2, 'analytics', now())`,
    [dbId, T],
  );
  const wire = (schema: string, table: string, col: string) =>
    pgRun(
      `INSERT INTO "zugzug_app"."dimension_source"
         (dim_id, tenant_id, database_id, schema_name, table_name, column_name)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [D, T, dbId, schema, table, col],
    );
  await wire("authco", "users", "plan_type");
  await wire("authco", "users", "country");

  await canonical.removeSource(
    D,
    { databaseId: dbId, schemaName: "authco", tableName: "users", columnName: "plan_type" },
    T,
  );

  const rows = await pgAll<{ column_name: string }>(
    `SELECT column_name FROM "zugzug_app"."dimension_source" WHERE tenant_id = $1 AND dim_id = $2`,
    [T, D],
  );
  expect(rows.map((r) => r.column_name).sort()).toEqual(["country"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test:db:up && npm --prefix server test -- dimension-source-remove`
Expected: FAIL — `canonical.removeSource is not a function`.

- [ ] **Step 3: Add the repo function**

In `server/src/repo-canonical.ts`, add near the other source/db helpers (reuse the existing `QualifiedSource` interface and `pg()`/`pgRun` imports already in that file):

```ts
export async function removeSource(
  dimId: string,
  source: QualifiedSource,
  tenantId: string,
): Promise<void> {
  await pgRun(
    `DELETE FROM ${pg("dimension_source")}
      WHERE tenant_id = $1 AND dim_id = $2 AND database_id = $3
        AND schema_name = $4 AND table_name = $5 AND column_name = $6`,
    [tenantId, dimId, source.databaseId, source.schemaName, source.tableName, source.columnName],
  );
}
```

- [ ] **Step 4: Add the DELETE endpoint**

In `server/src/server.ts`, immediately after the `POST /sources` block (closes at line 1156), add:

```ts
        // DELETE /api/dimensions/:id/sources — unwire a column. Same input
        // shapes as the POST above (bare "schema.table"+column resolves to the
        // default database; qualified passes databaseId explicitly).
        if (seg[3] === "sources" && seg.length === 4 && method === "DELETE") {
          const denied = gateOrJson(tenantCtx, "manage_adapter");
          if (denied) return denied;
          const raw = (await req.json()) as {
            source?:
              | import("./repo-canonical.ts").QualifiedSource
              | { table: string; column: string };
            table?: string;
            column?: string;
          };
          const input =
            raw.source ??
            (raw.table && raw.column ? { table: raw.table, column: raw.column } : null);
          if (!input) return err("source required", 400);

          const { resolveDefaultDatabase, removeSource } = await import("./repo-canonical.ts");
          let qualified: import("./repo-canonical.ts").QualifiedSource;
          if ("databaseId" in input) {
            if (!input.databaseId || !input.schemaName || !input.tableName || !input.columnName) {
              return err("source requires databaseId + schemaName + tableName + columnName", 400);
            }
            qualified = input;
          } else {
            const parts = input.table.split(".");
            if (parts.length !== 2 || !parts[0] || !parts[1]) {
              return err(`expected "schema.table", got: ${input.table}`, 400);
            }
            qualified = {
              databaseId: await resolveDefaultDatabase(tenantCtx.tenantId),
              schemaName: parts[0],
              tableName: parts[1],
              columnName: input.column,
            };
          }
          await removeSource(id, qualified, tenantCtx.tenantId);
          return new Response(null, { status: 204, headers: corsHeaders });
        }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix server test -- dimension-source-remove`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-canonical.ts server/src/server.ts server/test/dimension-source-remove.test.ts
git commit -m "feat(sources): add removeSource repo fn + DELETE /dimensions/:id/sources"
```

---

### Task 2: `removeSource` store mutation

**Files:**
- Modify: `app/src/store.ts` (add `removeSource` next to `addSource` at ~line 901)
- Test: `app/test/store-remove-source.test.ts` (new)

**Interfaces:**
- Consumes: internal `api(path, init)`, `refreshSources()`, `emit()` (same ones `addSource` uses).
- Produces: `removeSource(dimId: string, table: string, column: string): Promise<void>` — DELETEs the wiring, refetches sources, emits.

- [ ] **Step 1: Write the failing test**

Create `app/test/store-remove-source.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/api", () => ({
  api: vi.fn().mockResolvedValue(undefined),
  authFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ sources: [] }) }),
}));

describe("store/removeSource", () => {
  beforeEach(() => vi.clearAllMocks());

  it("DELETEs the wiring with the bare table+column body", async () => {
    const { removeSource } = await import("../src/store");
    const { api } = await import("../src/api");
    await removeSource("dim-1", "authco.users", "plan_type");
    const call = (api as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("/dimensions/dim-1/sources"),
    );
    expect(call).toBeTruthy();
    expect(call?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({
      table: "authco.users",
      column: "plan_type",
    });
  });
});
```

> Note: confirm the exact internal HTTP helper name (`api`) and its call shape by reading `addSource` at `store.ts:901` before running — if `addSource` uses a differently-named helper, mock and assert that one instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app test -- store-remove-source`
Expected: FAIL — `removeSource` is not exported.

- [ ] **Step 3: Add the mutation**

In `app/src/store.ts`, directly below `addSource` (line ~908):

```ts
export async function removeSource(dimId: string, table: string, column: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/sources`, {
    method: "DELETE",
    body: JSON.stringify({ table, column }),
  });
  await refreshSources();
  emit();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix app test -- store-remove-source`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/store.ts app/test/store-remove-source.test.ts
git commit -m "feat(sources): add removeSource store mutation"
```

---

## Phase 2 — Sources connection surface

### Task 3: `SourceRow` component

A new presentational row: `schema.table.column → target`, connection state, and a `⋯` menu (Re-scan / Open in Map values / Remove source). No coverage %, no unmapped count, no standing bar, no drill.

**Files:**
- Create: `app/src/components/sources/SourceRow.tsx`
- Test: `app/test/source-row.test.tsx` (new)

**Interfaces:**
- Consumes: `SourceInfo` from `../../store`; `ago` from `./utils`; `cx` from `../../lib/cx`; `IconWand`/icons from `../Icons`.
- Produces: `SourceRow` with props:

```ts
interface SourceRowProps {
  row: SourceInfo;
  mapValuesHref: string;     // from nav.table(row.dimId, "match")
  canEdit?: boolean;
  busy?: boolean;
  onDerive: () => void;      // Re-scan
  onRemove: () => void;      // Remove source (parent shows confirm + calls store.removeSource)
}
```

Connection-state derivation (only connection-about states — no drift):

```ts
// scanned but the column no longer exists in the warehouse → broken wire
const state =
  row.scanned && !row.present
    ? { label: "column not found", tone: "text-danger", warn: true }
    : !row.scanned && !row.scannedAt
      ? { label: "never scanned", tone: "text-warn", warn: false }
      : { label: row.scannedAt ? `scanned ${ago(row.scannedAt)} ago` : "scanned", tone: "text-ink-3", warn: false };
```

- [ ] **Step 1: Write the failing test**

Create `app/test/source-row.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SourceRow } from "../src/components/sources/SourceRow";
import type { SourceInfo } from "../src/store";

const base: SourceInfo = {
  table: "authco.users",
  column: "plan_type",
  dimension: "Plan",
  dimId: "dim-1",
  present: true,
  rows: 1000,
  values: 10,
  unmapped: 2,
  scanned: true,
  scannedAt: "2026-07-17T10:00:00Z",
};

function renderRow(over: Partial<SourceInfo>, handlers = {}) {
  return render(
    <SourceRow
      row={{ ...base, ...over }}
      mapValuesHref="/app/default/tables?open=dim-1&active=dim-1&mode=match"
      canEdit
      onDerive={vi.fn()}
      onRemove={vi.fn()}
      {...handlers}
    />,
  );
}

describe("SourceRow", () => {
  it("shows column, target, and 'column not found' when scanned & absent", () => {
    renderRow({ present: false });
    expect(screen.getByText(/authco\.users\.plan_type|plan_type/)).toBeInTheDocument();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText(/column not found/i)).toBeInTheDocument();
  });

  it("shows 'never scanned' when not yet scanned", () => {
    renderRow({ scanned: false, scannedAt: null });
    expect(screen.getByText(/never scanned/i)).toBeInTheDocument();
  });

  it("Remove source in the menu calls onRemove", () => {
    const onRemove = vi.fn();
    renderRow({}, { onRemove });
    fireEvent.click(screen.getByLabelText(/more actions/i));
    fireEvent.click(screen.getByText(/remove source/i));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("links Open in Map values to mapValuesHref", () => {
    renderRow({});
    fireEvent.click(screen.getByLabelText(/more actions/i));
    const link = screen.getByText(/open in map values/i).closest("a");
    expect(link).toHaveAttribute("href", expect.stringContaining("mode=match"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app test -- source-row`
Expected: FAIL — cannot resolve `SourceRow`.

- [ ] **Step 3: Implement `SourceRow`**

Create `app/src/components/sources/SourceRow.tsx`. Translate the row markup from the Sources mockup (`.row`, `.col-name`, `.target`, `.state`, `.menu`) into token classes. Minimum structure:

```tsx
import { useState } from "react";
import { Link } from "react-router-dom";
import { IconWand } from "../Icons";
import { cx } from "../../lib/cx";
import { ago } from "./utils";
import type { SourceInfo } from "../../store";

interface SourceRowProps {
  row: SourceInfo;
  mapValuesHref: string;
  canEdit?: boolean;
  busy?: boolean;
  onDerive: () => void;
  onRemove: () => void;
}

export function SourceRow({ row, mapValuesHref, canEdit = true, busy, onDerive, onRemove }: SourceRowProps) {
  const [menu, setMenu] = useState(false);
  const tableName = row.table.split(".").slice(1).join(".") || row.table;
  const state =
    row.scanned && !row.present
      ? { label: "⚠ column not found", tone: "text-danger" }
      : !row.scanned && !row.scannedAt
        ? { label: "never scanned", tone: "text-warn" }
        : { label: row.scannedAt ? `scanned ${ago(row.scannedAt)} ago` : "scanned", tone: "text-ink-3" };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(120px,auto)_150px_32px] items-center gap-4 px-6 py-3 pl-10 border-b border-line last:border-b-0 transition-colors hover:bg-surface-2/40">
      <div className="truncate font-mono text-[12.5px] text-ink">
        <span className="text-ink-3">{row.table.split(".")[0]}.{tableName.includes(".") ? "" : ""}</span>
        {tableName}
        <span className="text-ink-3">.{row.column}</span>
      </div>
      <div className="whitespace-nowrap text-[12.5px] text-ink-2">
        <span className="mr-1.5 text-ink-3">→</span>
        <span className="font-display font-semibold text-ink">{row.dimension}</span>
      </div>
      <div className={cx("whitespace-nowrap font-mono text-[11px]", state.tone)}>{state.label}</div>
      <div className="relative justify-self-end">
        <button
          type="button"
          aria-label="More actions"
          onClick={() => setMenu((v) => !v)}
          className="px-1.5 py-1 text-ink-3 transition-colors hover:text-ink"
        >
          ⋯
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <div className="absolute right-0 top-full z-20 mt-1 min-w-[180px] border border-line-2 bg-surface-3 p-1 shadow-pop">
              <button
                type="button"
                disabled={!canEdit || !!busy}
                onClick={() => { setMenu(false); onDerive(); }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"
              >
                <IconWand className="h-3 w-3" /> Re-scan
              </button>
              <Link
                to={mapValuesHref}
                onClick={() => setMenu(false)}
                className="block px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink"
              >
                Open in Map values
              </Link>
              <div className="my-1 h-px bg-line" />
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => { setMenu(false); onRemove(); }}
                className="block w-full px-2.5 py-1.5 text-left text-[12.5px] text-danger hover:bg-danger-soft disabled:opacity-40"
              >
                Remove source
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

> Tidy the schema-prefix rendering while implementing so it reads `schema.table.column` once, cleanly (the snippet above prioritizes passing tests; simplify the first `<div>` to a single `{row.table}.{row.column}` mono string with the schema/column dimmed).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix app test -- source-row`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/components/sources/SourceRow.tsx app/test/source-row.test.tsx
git commit -m "feat(sources): add SourceRow (column → target, state, actions menu)"
```

---

### Task 4: Rewrite the Sources route into a connection surface

Strip the monitoring machinery from `Sources.tsx`; keep header (with `Scan all` + `Add source`), collapsible system groups rendering `SourceRow`, and a single review pointer. Delete the keyboard-cursor hook.

**Files:**
- Modify: `app/src/routes/Sources.tsx` (major rewrite; target ~230 lines)
- Delete: `app/src/routes/use-sources-cursor.ts` (sole consumer is `Sources.tsx`)
- Test: `app/test/sources-route.test.tsx` (new)

**Interfaces:**
- Consumes: `useSources`, `useDimensions`, `useCanEdit`, `useStoreLoading`, `scanSources`, `deriveCanonical`, `removeSource` (Task 2) from `../store`; `useNavLinks` (`nav.table(dimId,"match")`, `nav.settings`); `SourceRow` (Task 3); `CatalogExplorer`; `PageHeader`; `Button`; `useAsyncAction`; `toast`.
- Produces: nothing consumed elsewhere.

**Remove (delete these blocks — line refs vs current 821-line file):**
- Standing callout `503–547`
- Sticky toolbar (search input + status CHIPS + sort `<select>`) `552–608`
- `SORTS`, `CHIPS`, `status`/`sort`/`q` state + their URL write-through effects `316–344`, and `sort`/`status`/`shown` filter+sort logic inside the `groups` memo `223–286` (keep grouping-by-schema; drop the sort comparators and status filter)
- keyboard cursor: `useSourcesCursor`, `visibleKeys`, `rowsWithUnmapped`, `useLayoutEffect` scroll-into-view `354–397`, and the `onKeyDown`/`tabIndex` on the `<section>`
- "Load more" pagination `638–651` and `shown`/`PAGE` state
- footer totals `656–672`
- `counts` memo `217–221`; trim `agg` to only what the header + pointer need: `columns`, `systems`, `unmapped`, `worst` (keep `worst` for the review pointer)
- `dashboardSentence`'s unmapped tail — lede becomes `"{columns} columns connected across {systems} systems"`

**Keep / add:**
- `PageHeader` with `Scan all` (ghost) + `Add source` (primary) actions — unchanged wiring.
- `deriveAction` (re-scan) — unchanged; pass to `SourceRow.onDerive`.
- New `removeAction` using `useAsyncAction` → `window.confirm` then `removeSource(row.dimId, row.table, row.column)` + success/error toast.
- Group by schema (`s.table.split(".")[0]`), each group = collapsible header (chevron, name, `{n} columns · scanned {ago} ago`, pending badge = sum of `unmapped` shown in accent when folded/positive) + `SourceRow` list. Keep the existing open/collapse heuristic (`AUTO_EXPAND_MAX_SCHEMAS`, `openSchemas` set, `toggleSchema`).
- Review pointer at the bottom of the surface, shown only when `agg.unmapped > 0`:
  `● {agg.unmapped} values await a decision → Review`, the link = `nav.table(agg.worst!.dimId, "match")`.
- Empty state (no sources): keep the existing `SetupCard` "No sources yet" with Browse catalog + Warehouse settings.

- [ ] **Step 1: Write the failing test**

Create `app/test/sources-route.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { SourceInfo } from "../src/store";

const SOURCES: SourceInfo[] = [
  { table: "authco.users", column: "plan_type", dimension: "Plan", dimId: "d1", present: true, rows: 1000, values: 10, unmapped: 8, scanned: true, scannedAt: "2026-07-17T10:00:00Z" },
  { table: "billing.invoices", column: "currency", dimension: "Currency", dimId: "d2", present: true, rows: 50, values: 5, unmapped: 0, scanned: true, scannedAt: "2026-07-16T10:00:00Z" },
];
const removeSource = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/store", () => ({
  useSources: () => SOURCES,
  useDimensions: () => [],
  useCanEdit: () => true,
  useStoreLoading: () => false,
  scanSources: vi.fn(),
  deriveCanonical: vi.fn(),
  removeSource,
}));
vi.mock("../src/lib/use-tenant-navigate", () => ({
  useNavLinks: () => ({
    table: (id: string) => `/app/default/tables?open=${id}&active=${id}&mode=match`,
    settings: "/app/default/settings",
    sources: "/app/default/sources",
  }),
}));

async function renderPage() {
  const { Sources } = await import("../src/routes/Sources");
  return render(<MemoryRouter><Sources /></MemoryRouter>);
}

describe("Sources route", () => {
  it("renders the connection lede without monitoring copy", async () => {
    await renderPage();
    expect(screen.getByText(/2 columns connected across 2 systems/i)).toBeInTheDocument();
    expect(screen.queryByText(/standing · today/i)).toBeNull();
  });

  it("shows the review pointer linking to the most-affected table", async () => {
    await renderPage();
    const link = screen.getByText(/review/i).closest("a");
    expect(link).toHaveAttribute("href", expect.stringContaining("open=d1"));
  });

  it("collapsing a system hides its rows", async () => {
    await renderPage();
    expect(screen.getByText("Plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /authco/i }));
    expect(screen.queryByText("Plan")).toBeNull();
  });

  it("Remove source (with confirm) calls store.removeSource", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await renderPage();
    fireEvent.click(within(screen.getByText("Plan").closest("[class]")!.parentElement!).getByLabelText(/more actions/i));
    fireEvent.click(screen.getByText(/remove source/i));
    expect(removeSource).toHaveBeenCalledWith("d1", "authco.users", "plan_type");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app test -- sources-route`
Expected: FAIL — old page still renders "Standing · today" / no matching lede.

- [ ] **Step 3: Rewrite `Sources.tsx`**

Apply the Remove/Keep lists above. Use the Sources mockup as the markup reference. The `SchemaSection` sub-component now renders `SourceRow` and takes: `group`, `open`, `onToggle`, `canEdit`, `busy`, `mapHref(row)`, `onDerive(row)`, `onRemove(row)`. Add the review pointer + `removeAction`:

```tsx
const removeAction = useAsyncAction(async (s: SourceInfo) => {
  if (!window.confirm(`Remove ${s.table}.${s.column} from ${s.dimension}? This unwires the column; it won't delete any records.`)) return;
  try {
    await removeSource(s.dimId, s.table, s.column);
    toast(`Removed ${s.table}.${s.column}.`);
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't remove source.", "error");
  }
});
```

Review pointer (inside the surface, after the group list):

```tsx
{agg.unmapped > 0 && agg.worst && (
  <div className="flex items-center gap-2 border-t border-line px-6 py-3 text-[12.5px] text-ink-2">
    <span className="zz-live h-1.5 w-1.5 rounded-pill bg-accent" />
    {agg.unmapped.toLocaleString()} values await a decision
    <Link to={nav.table(agg.worst.dimId, "match")} className="font-semibold text-accent hover:underline">
      → Review
    </Link>
  </div>
)}
```

- [ ] **Step 4: Delete the cursor hook + its import**

```bash
git rm app/src/routes/use-sources-cursor.ts
```
Remove the `import { useSourcesCursor } from "./use-sources-cursor";` line and all cursor references from `Sources.tsx`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm --prefix app test -- sources-route source-row && npm --prefix app run build`
Expected: route + row tests PASS; `tsc` build succeeds with no unused-import / missing-symbol errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/routes/Sources.tsx
git rm app/src/routes/use-sources-cursor.ts
git add app/test/sources-route.test.tsx
git commit -m "feat(sources): rewrite route as a connection surface (collapsible groups, review pointer, remove)"
```

---

## Phase 3 — Catalog explorer drawer

### Task 5: Redesign `CatalogExplorer` as a right slide-over drawer

Convert the centered modal to a right-docked drawer, drop the schema-facet rail (search-only), and add a live "N wired just now" tally. The wiring interaction (`ComboSelect` → `deriveCanonical` → connected line) and `searchCatalog` + Load-more stay.

**Files:**
- Modify: `app/src/components/CatalogExplorer.tsx`
- Test: `app/test/catalog-explorer.test.tsx` (new or extend if one exists)

**Interfaces:**
- Consumes: unchanged public props (`dims`, `database`, `onDatabaseChange`, `onClose`) — `Sources.tsx` calls it the same way. `searchCatalog`, `deriveCanonical`, `fetchWarehouseDatabases` unchanged.
- Produces: no signature change.

**Changes:**
- **Shell → drawer.** Replace the outer `fixed inset-0 … items-start justify-center` + centered panel (`max-w-4xl`, lines 203–211) with: full-height scrim + a right-docked panel `fixed top-0 right-0 h-full w-[620px] max-w-full border-l border-line-2 bg-surface shadow-pop`, entering with a slide-from-right (mirror the mockup's `slide` keyframe using the app's `--ease-spring`; or reuse an existing drawer/slide utility if one exists in `globals.css` — grep `translateX` first).
- **Drop the schema rail** (lines 408–436): remove the `<div className="… md:grid md:grid-cols-[180px_1fr]">` two-column layout and the schema-facet buttons. Keep `schema` state removed too. Since only `CatalogExplorer` consumes `CatalogResult.schemas` (verified), also stop reading `r.schemas`/`setSchemas` — delete the `schemas` state and its `setSchemas(r.schemas)` call in `load`. Results become a single scrolling column.
- **Live tally.** Add `const [wiredThisSession, setWiredThisSession] = useState(0);`; increment it inside `wire()` on success (after `setWired(...)` resolves with a non-error result). Render in the footer next to the `{rows.length} of {total} tables` line: when `> 0`, `· {n} wired just now` in `text-ok`.
- **Copy:** header stays `Wire a source`; search placeholder stays `Search tables, columns…`. Keep the `deriveCanonical` outcome text.
- Do not touch the database picker/switcher logic or the `!internalDb` "choose a database" state — only re-skin their container as needed to sit in the drawer width.

- [ ] **Step 1: Write the failing test**

Create `app/test/catalog-explorer.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../src/store", () => ({
  searchCatalog: vi.fn().mockResolvedValue({
    rows: [{ schema: "authco", table: "authco.users", columns: ["plan_type", "country"] }],
    total: 1,
    schemas: [{ schema: "authco", tables: 1 }],
  }),
  deriveCanonical: vi.fn(),
  useCanEdit: () => true,
}));
vi.mock("../src/api", () => ({
  fetchWarehouseDatabases: vi.fn().mockResolvedValue([{ id: "db1", databaseName: "analytics", label: null, lastProbeError: null }]),
}));

async function renderExplorer() {
  const { CatalogExplorer } = await import("../src/components/CatalogExplorer");
  return render(<CatalogExplorer dims={[]} database="db1" onClose={vi.fn()} />);
}

describe("CatalogExplorer (drawer)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the 'Wire a source' header and a search box, no schema-facet rail", async () => {
    await renderExplorer();
    expect(screen.getByText(/wire a source/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/search tables, columns/i)).toBeInTheDocument();
    // the old 'all systems' facet is gone
    expect(screen.queryByText(/all systems/i)).toBeNull();
  });

  it("lists tables from searchCatalog", async () => {
    await renderExplorer();
    await waitFor(() => expect(screen.getByText("authco.users")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix app test -- catalog-explorer`
Expected: FAIL — "all systems" facet still present (test 1 fails).

- [ ] **Step 3: Apply the drawer redesign**

Make the shell/rail/tally changes listed above, using the catalog mockup (`2026-07-17-catalog-explorer.html`) for exact structure and the app token classes. Keep table-expand + `ComboSelect` wiring.

- [ ] **Step 4: Run tests + build**

Run: `npm --prefix app test -- catalog-explorer && npm --prefix app run build`
Expected: PASS + build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/CatalogExplorer.tsx app/test/catalog-explorer.test.tsx
git commit -m "feat(sources): redesign catalog explorer as right drawer, search-only, with wired tally"
```

---

## Phase 4 — Verify end-to-end

### Task 6: Full suite + manual pass

- [ ] **Step 1: Run the whole app suite**

Run: `npm --prefix app test`
Expected: all pass, including the untouched `WiredSourcesModeBody`/`LedgerRow` paths (regression guard).

- [ ] **Step 2: Run the server suite**

Run: `npm --prefix server run test:db:up && npm --prefix server test`
Expected: all pass, including the new `dimension-source-remove` test.

- [ ] **Step 3: Manual smoke (dev server)**

Run the app (`npm --prefix app run dev`), open `/app/default/sources`:
- Groups collapse/expand; folded groups show the pending badge.
- A source with `present:false` shows `⚠ column not found`.
- `⋯` → Remove source prompts a confirm, then the row disappears.
- `Add source` opens the right drawer; searching filters tables; wiring a column shows the green connected line and bumps "N wired just now"; the new source appears in the list behind after close.
- The per-table workbench "wired sources" mode (open a table → its sources mode) still renders `LedgerRow` with the drill — unchanged.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test(sources): green app + server suites for connection surface"
```

---

## Self-Review

**Spec coverage:**
- Connection-surface list + collapsible groups + pending badge → Task 4. ✓
- 3-field row + `⋯` (Re-scan / Open in Map values / Remove source) → Task 3. ✓
- Review pointer → most-affected table → Task 4. ✓
- `Scan all` kept, demoted → Task 4 (header unchanged). ✓
- Remove source (new endpoint + store fn + UI) → Tasks 1, 2, 3, 4. ✓
- Delete monitoring machinery + cursor hook → Task 4. ✓
- `LedgerRow`/`ExpandedDrill` retained for `WiredSourcesModeBody` → enforced in Global Constraints + Task 6 regression check. ✓
- Add-source = right drawer, search-only (no facets), live tally → Task 5. ✓
- Drop `q/status/sort/focus` URL params → Task 4 (effects removed). ✓
- Vocabulary pass → Global Constraints + reviewed in each UI task. ✓

**Placeholder scan:** No TBD/TODO. Every code step shows real code; the two large UI tasks (4, 5) give exact remove/keep line ranges + the new-code snippets + the mockup as markup reference rather than fictional full-file dumps.

**Type consistency:** `removeSource(dimId, table, column)` identical in store (Task 2), server body shape (Task 1), and call site (Task 4). `SourceRowProps` in Task 3 matches the props passed in Task 4. `QualifiedSource` reused from `repo-canonical.ts` in Task 1.

**Open risk flagged in-plan:** Task 2 Step 1 note — confirm the store's internal HTTP helper name (`api`) by reading `addSource` before asserting on the mock.
