# Admin Polish Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise Settings / Admin / Account surfaces to Linear/Vercel polish, closing the OSS-launch gap.

**Architecture:** Five independently shippable phases, each a separate PR off `main`. Phase 1 collapses workspace Settings from 8 tabs to 5 and unifies the page-header pattern. Phase 2 ships `<Skeleton>` and `<EmptyState>` primitives and applies them across admin/settings. Phase 3 converts the last explicit-save forms to autosave, unifies destructive confirmation, and runs a toast-copy pass. Phase 4 adds Account → Memberships (relocating "Leave workspace") and hides the Notifications stub. Phase 5 replaces sidebar numbers with icons.

**Tech Stack:** React 18 + TypeScript, Vite, Tailwind v4, React Router v6, Vitest + Testing Library. Test directory: `app/test/`. Run tests: `cd app && bun run test`. Typecheck: `cd app && bun run typecheck`. Lint: `cd app && bun run lint`.

**Reference implementation:** `app/src/routes/settings/Members.tsx` — every change in this plan must match its bar (real loading layout, activation empty states, inline error recovery, hover-reveal destructive actions, ConfirmDialog usage, per-row pending state, ⌘K search hint, counts as first-class).

**Spec:** [docs/superpowers/specs/2026-06-13-admin-polish-audit-design.md](../specs/2026-06-13-admin-polish-audit-design.md)

**Conventions:**
- Hand-rolled SVG icons in `app/src/components/Icons.tsx` — `lucide-react` is NOT a dependency. Follow the existing `Base` wrapper (24x24, stroke 1.6, currentColor).
- Settings/Account/Admin sidebars currently render with `01–0N` mono numbers + active accent left-bar. Phase 5 changes only that number slot.
- `apiFetch("")` posts to `/api/t/:slug` (tenant-scoped). `authFetch("/auth/...")` is the auth-scoped helper.
- TDD pattern in this repo: write `*.test.tsx` in `app/test/`, run `bun run test -- <pattern>` to scope.
- Commits use Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`).
- One PR per phase. Branch naming: `polish/phase-{1..5}-{slug}`.

---

## PHASE 1 — IA collapse (5 tasks)

**Branch:** `polish/phase-1-ia-collapse`

**Outcome:** Workspace Settings has 5 tabs. Tokens + Scans become sections of Warehouse. Audit promotes to primary nav. `<PageHeader>` is the only page-top pattern.

### Task 1.1: Extend `<PageHeader>` with `count` slot

**Files:**
- Modify: `app/src/components/PageHeader.tsx`
- Test: `app/test/page-header.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeader } from "../src/components/PageHeader";

describe("PageHeader", () => {
  it("renders kicker, title, lede", () => {
    render(<PageHeader kicker="System" title="Workspaces" lede="Isolated environments." />);
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Workspaces" })).toBeInTheDocument();
    expect(screen.getByText("Isolated environments.")).toBeInTheDocument();
  });

  it("renders a count badge inline with the title when count is provided", () => {
    render(<PageHeader title="Workspaces" count={4} />);
    const badge = screen.getByTestId("page-header-count");
    expect(badge).toHaveTextContent("4");
  });

  it("does not render the count badge when count is undefined", () => {
    render(<PageHeader title="Workspaces" />);
    expect(screen.queryByTestId("page-header-count")).toBeNull();
  });

  it("renders the action slot on the right", () => {
    render(<PageHeader title="X" action={<button>Add</button>} />);
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd app && bun run test -- page-header`
Expected: `count` tests fail (property does not exist).

- [ ] **Step 3: Add `count` prop to PageHeader**

In `app/src/components/PageHeader.tsx`, extend the prop type and render a small inline badge to the right of the `<h1>` text using existing tabular-nums treatment:

```tsx
import type { ReactNode } from "react";

export function PageHeader({
  kicker,
  title,
  lede,
  action,
  meta,
  backdrop,
  count,
}: {
  kicker?: string;
  title: ReactNode;
  lede?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
  backdrop?: ReactNode;
  count?: number;
}) {
  return (
    <div className="zz-rise relative overflow-hidden">
      {backdrop}
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {kicker && (
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">
              {kicker}
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-3">
            <h1 className="font-display text-[clamp(30px,4vw,44px)] font-extrabold leading-[0.95] tracking-[-0.035em] text-ink">
              {title}
            </h1>
            {count !== undefined && (
              <span
                data-testid="page-header-count"
                className="font-mono text-xs tabular-nums bg-surface-2 border border-line text-ink-3 px-2 py-0.5"
              >
                {count}
              </span>
            )}
          </div>
          {lede && <p className="mt-2 max-w-2xl text-[14px] text-ink-2">{lede}</p>}
          {meta && <div className="mt-3">{meta}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `cd app && bun run test -- page-header`
Expected: all four tests pass.

- [ ] **Step 5: Typecheck + lint**

Run: `cd app && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/PageHeader.tsx app/test/page-header.test.tsx
git commit -m "feat(page-header): add count slot"
```

---

### Task 1.2: Migrate `Admin/Workspaces.tsx` to `<PageHeader>`

**Files:**
- Modify: `app/src/routes/admin/Workspaces.tsx:54-78`

- [ ] **Step 1: Replace hand-rolled header**

In `Workspaces.tsx`, remove the hand-rolled `<div className="zz-rise flex items-end justify-between gap-4">…</div>` block (lines ~54-78) and replace with:

```tsx
import { PageHeader } from "../../components/PageHeader";
// ...
<PageHeader
  kicker="System"
  title="Workspaces"
  lede="Isolated reconciliation environments. Each workspace is scoped to a warehouse connection and owns its own canonical tables and audit trail."
  count={loading ? undefined : tenants.length}
  action={
    <Button
      variant={showForm ? "secondary" : "primary"}
      size="sm"
      onClick={() => setShowForm((v) => !v)}
    >
      {showForm ? "Cancel" : "+ New workspace"}
    </Button>
  }
/>
```

Remove the now-unused inline `<h1>`, `<p>`, and `<Button>` block; keep the Workspaces list and create form below unchanged.

- [ ] **Step 2: Run existing admin tests**

Run: `cd app && bun run test -- admin`
Expected: still passing.

- [ ] **Step 3: Typecheck + lint**

Run: `cd app && bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/admin/Workspaces.tsx
git commit -m "refactor(admin/workspaces): use PageHeader"
```

---

### Task 1.3: Add `<PageHeader>` to Account/Profile and other bare pages

**Files:**
- Modify: `app/src/routes/account/Account.tsx`
- Modify: `app/src/routes/account/Profile.tsx`
- Modify: `app/src/routes/account/Appearance.tsx`
- Modify: `app/src/routes/account/Notifications.tsx`
- Modify: `app/src/routes/admin/Users.tsx`
- Modify: `app/src/routes/admin/Audit.tsx`
- Modify: `app/src/routes/admin/Warehouses.tsx`

The Account layout (`Account.tsx`) currently lacks a top-level `<PageHeader>`. The Settings layout has one (`SettingsLayout.tsx`). Add the same shell to Account.

- [ ] **Step 1: Open `app/src/routes/account/Account.tsx`** — it likely renders `<Outlet />` inside an `AccountShell` similar to SettingsShell. Wrap with a `<PageHeader kicker="Account" title="Your account" lede="Personal preferences. Not workspace-scoped." />` at the same outer wrapper level as SettingsLayout uses one.

- [ ] **Step 2: For each admin route (`Users`, `Audit`, `Warehouses`)** — replace hand-rolled headings with:

```tsx
<PageHeader kicker="System" title="Users" lede="…" count={…} />
<PageHeader kicker="System" title="Audit" lede="System-wide activity." />
<PageHeader kicker="System" title="Warehouses" lede="…" count={…} />
```

Copy the existing lede/description text into the `lede` prop. If a page currently has no description, write a one-sentence lede (1 line max, ink-2 voice).

- [ ] **Step 3: Run tests**

Run: `cd app && bun run test`
Expected: still passing (no behavior change in existing tests).

- [ ] **Step 4: Typecheck + lint, commit**

```bash
git add app/src/routes/account/*.tsx app/src/routes/admin/*.tsx
git commit -m "refactor(admin,account): unify page headers via PageHeader"
```

---

### Task 1.4: Fold Scans + Tokens into Warehouse

**Files:**
- Modify: `app/src/routes/settings/Warehouse.tsx` (host sections)
- Modify: `app/src/components/settings/SettingsSidebar.tsx` (drop Scans, Tokens items)
- Modify: `app/src/main.tsx` (redirects)
- Delete: nothing — keep `Scans.tsx` / `Tokens.tsx` but stop routing to them directly
- Test: `app/test/settings-sidebar.test.tsx` (update expectations)
- Test: `app/test/warehouse-sections.test.tsx` (create)

- [ ] **Step 1: Update sidebar test**

In `app/test/settings-sidebar.test.tsx`, change the expected items list to:

```tsx
const EXPECTED = ["General", "Members", "Matching", "Warehouse", "Danger"];
expect(EXPECTED).toEqual(items.map((i) => i.textContent?.trim()));
```

(Remove Tokens, Scans, Audit from any existing assertions.)

- [ ] **Step 2: Run and confirm failure**

Run: `cd app && bun run test -- settings-sidebar`
Expected: fail because sidebar still has Tokens / Scans / Audit.

- [ ] **Step 3: Update `SettingsSidebar.tsx` ITEMS list**

```tsx
const ITEMS: Item[] = [
  { label: "General", to: "general", action: "settings.general.view" },
  { label: "Members", to: "members", action: "settings.members.view" },
  { label: "Matching", to: "matching", action: "settings.matching.view" },
  { label: "Warehouse", to: "warehouse", action: "settings.warehouse.view" },
  { label: "Danger", to: "danger", action: "settings.danger.leave" },
];
```

- [ ] **Step 4: Run sidebar test, confirm pass**

Run: `cd app && bun run test -- settings-sidebar`
Expected: pass.

- [ ] **Step 5: Refactor Warehouse.tsx into three sections**

Open `app/src/routes/settings/Warehouse.tsx`. Rename the existing `<SettingsSection title="Connections">` content to a local `<ConnectionsSection>` sub-component. Add two more local sub-components that import and render the existing Scans and Tokens UIs:

```tsx
import { Scans } from "./Scans";
import { Tokens } from "./Tokens";

export function Warehouse() {
  // existing connection-section state stays here
  return (
    <div className="space-y-8">
      <ConnectionsSection />
      <div id="scans"><Scans /></div>
      <div id="tokens"><Tokens /></div>
    </div>
  );
}
```

Both `Scans` and `Tokens` already render as `<SettingsSection>`, so they slot in naturally.

- [ ] **Step 6: Add redirects in `app/src/main.tsx`**

For one release cycle, redirect old routes to new ones (use React Router's `<Navigate>`):

```tsx
<Route path="tokens" element={<Navigate to="../warehouse#tokens" replace />} />
<Route path="scans" element={<Navigate to="../warehouse#scans" replace />} />
```

Make sure these come BEFORE any `<Route path="*">` catch-all.

- [ ] **Step 7: Write the warehouse-sections test**

`app/test/warehouse-sections.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Warehouse } from "../src/routes/settings/Warehouse";
// ...mock useTenant, usePreferences as the file requires

describe("Warehouse page", () => {
  it("renders Connections + Scans + Tokens sections", () => {
    render(
      <MemoryRouter>
        <Warehouse />
      </MemoryRouter>,
    );
    expect(screen.getByText("Connections")).toBeInTheDocument();
    expect(screen.getByText("Scans")).toBeInTheDocument();
    expect(screen.getByText("API tokens")).toBeInTheDocument();
  });
});
```

(Inspect existing tests in `app/test/` for the right mock pattern for `useTenant` and `usePreferences` — likely `vi.mock("../src/lib/tenant-context", ...)` and a store helper.)

- [ ] **Step 8: Run all tests**

Run: `cd app && bun run test`
Expected: pass.

- [ ] **Step 9: Typecheck + lint, commit**

```bash
git add app/src/routes/settings/Warehouse.tsx app/src/components/settings/SettingsSidebar.tsx app/src/main.tsx app/test/settings-sidebar.test.tsx app/test/warehouse-sections.test.tsx
git commit -m "refactor(settings): fold Scans + Tokens into Warehouse"
```

---

### Task 1.5: Promote Audit to primary nav

**Files:**
- Create: `app/src/routes/Audit.tsx` (move from `app/src/routes/settings/Audit.tsx`)
- Modify: `app/src/main.tsx` (route move + redirect)
- Modify: `app/src/lib/use-tenant-navigate.ts` (add `audit` link)
- Modify: `app/src/components/AppShell.tsx:306-315` (add Audit nav item)
- Modify: `app/src/components/settings/SettingsSidebar.tsx` (remove Audit item — already done in 1.4)
- Test: `app/test/audit-route.test.tsx` (create)

- [ ] **Step 1: Create the new file**

Move `app/src/routes/settings/Audit.tsx` to `app/src/routes/Audit.tsx`. Update imports inside the file: e.g. `../../components/...` likely becomes `../components/...`. Remove any `<SettingsSection>` wrapper at the top of the file; the page now stands on its own with a `<PageHeader>` instead:

```tsx
import { PageHeader } from "../components/PageHeader";
// ...existing audit-rendering code below the header

export function Audit() {
  return (
    <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8">
      <PageHeader kicker="Workspace" title="Audit" lede="Activity across this workspace." />
      {/* …existing audit table/list… */}
    </div>
  );
}
```

- [ ] **Step 2: Update `use-tenant-navigate.ts`**

```tsx
export function useNavLinks() {
  const { slug } = useTenant();
  return useMemo(
    () => ({
      base: `/app/${slug}`,
      dashboard: `/app/${slug}`,
      triage: `/app/${slug}/triage`,
      sources: `/app/${slug}/sources`,
      tables: `/app/${slug}/tables`,
      audit: `/app/${slug}/audit`,
      settings: `/app/${slug}/settings`,
      // ...existing helpers
    }),
    [slug],
  );
}
```

- [ ] **Step 3: Add Audit to AppShell primary nav**

In `app/src/components/AppShell.tsx`, locate the primary nav array (~line 305):

```tsx
const navItems = [
  { to: navLinks.dashboard, label: "Home", Icon: IconDashboard, end: true },
  { to: navLinks.triage, label: "Review", Icon: IconMapping, count: totalNew },
  { to: navLinks.sources, label: "Sources", Icon: IconSources },
  { to: navLinks.tables, label: "Tables", Icon: IconTables, count: dims.length },
  { to: navLinks.audit, label: "Audit", Icon: IconAudit }, // ← NEW
  { to: navLinks.settings, label: "Settings", Icon: IconSettings },
];
```

Pick a sensible icon — if `IconAudit` doesn't exist yet in `Icons.tsx`, add one (clock-style). Hand-rolled SVG matching the existing Base wrapper:

```tsx
export const IconAudit = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Base>
);
```

- [ ] **Step 4: Update routing in `app/src/main.tsx`**

```tsx
// Inside the AppShell route group:
<Route path="audit" element={<Audit />} />
// And inside Settings:
<Route path="audit" element={<Navigate to="../../audit" replace />} />
```

The `Navigate` keeps deep links to `/settings/audit` working for one release cycle.

- [ ] **Step 5: Write the audit-route test**

`app/test/audit-route.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Audit } from "../src/routes/Audit";
// mocks as needed

describe("Audit (primary nav)", () => {
  it("renders the page header with kicker 'Workspace'", () => {
    render(
      <MemoryRouter>
        <Audit />
      </MemoryRouter>,
    );
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Audit" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run tests**

Run: `cd app && bun run test`
Expected: pass.

- [ ] **Step 7: Typecheck + lint, commit**

```bash
git add -A
git commit -m "feat(audit): promote to primary nav"
```

- [ ] **Step 8: Open PR for Phase 1**

```bash
git push -u origin polish/phase-1-ia-collapse
gh pr create --title "Polish phase 1 — IA collapse + PageHeader unification" --body "$(cat <<'EOF'
## Summary
- Workspace Settings tabs: 8 → 5 (General, Members, Matching, Warehouse, Danger)
- Scans + Tokens fold into Warehouse as in-page sections
- Audit promoted to primary nav (`/app/:slug/audit`)
- One `<PageHeader>` pattern across Settings / Admin / Account

## Test plan
- [ ] Sidebar shows 5 items, accent + numbered nav still active
- [ ] `/app/:slug/settings/tokens` and `/settings/scans` redirect to `/settings/warehouse`
- [ ] `/app/:slug/settings/audit` redirects to `/app/:slug/audit`
- [ ] Warehouse page shows Connections + Scans + Tokens sections inline
- [ ] Admin/Workspaces, Admin/Users, Account/Profile use PageHeader

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PHASE 2 — State patterns (4 tasks)

**Branch:** `polish/phase-2-state-patterns`

**Outcome:** No page renders `<span>Loading…</span>`. No empty state is a bare dashed box. Members.tsx zero-state gains an activation message.

### Task 2.1: Create `<Skeleton>` primitives

**Files:**
- Create: `app/src/components/Skeleton.tsx`
- Test: `app/test/skeleton.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SkeletonList, SkeletonRow } from "../src/components/Skeleton";

describe("Skeleton", () => {
  it("SkeletonRow renders N column placeholders", () => {
    render(<SkeletonRow columns={[40, 120, 1, 80]} data-testid="row" />);
    const row = screen.getByTestId("row");
    expect(row.children.length).toBe(4);
  });

  it("SkeletonList renders N rows", () => {
    render(<SkeletonList rows={5} columns={[1]} data-testid="list" />);
    const list = screen.getByTestId("list");
    expect(list.children.length).toBe(5);
  });

  it("respects prefers-reduced-motion via data attribute", () => {
    render(<SkeletonRow columns={[1]} data-testid="row" />);
    expect(screen.getByTestId("row")).toHaveAttribute("aria-busy", "true");
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `cd app && bun run test -- skeleton`
Expected: module not found.

- [ ] **Step 3: Implement Skeleton**

```tsx
// app/src/components/Skeleton.tsx
import type { HTMLAttributes } from "react";
import { cx } from "../lib/cx";

interface SkeletonRowProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Column widths. Number = px; "1fr" / 1 = flex-1. */
  columns: Array<number | string>;
}

export function SkeletonRow({ columns, className, ...rest }: SkeletonRowProps) {
  const grid = columns
    .map((c) => (typeof c === "number" ? (c === 1 ? "minmax(0,1fr)" : `${c}px`) : c))
    .join(" ");
  return (
    <div
      {...rest}
      aria-busy="true"
      className={cx("grid items-center gap-4 px-5 py-3.5", className)}
      style={{ gridTemplateColumns: grid }}
    >
      {columns.map((_, i) => (
        <span
          key={i}
          className="h-3 rounded-sm bg-surface-2 motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}

interface SkeletonListProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  rows: number;
  columns: Array<number | string>;
}

export function SkeletonList({ rows, columns, className, ...rest }: SkeletonListProps) {
  return (
    <div {...rest} className={cx("border border-line divide-y divide-line", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} columns={columns} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `cd app && bun run test -- skeleton`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/Skeleton.tsx app/test/skeleton.test.tsx
git commit -m "feat(components): add Skeleton primitives"
```

---

### Task 2.2: Create `<EmptyState>` primitive

**Files:**
- Create: `app/src/components/EmptyState.tsx`
- Test: `app/test/empty-state.test.tsx` (create)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "../src/components/EmptyState";

describe("EmptyState", () => {
  it("renders title + body + action", () => {
    render(
      <EmptyState
        title="No workspaces yet"
        body="Workspaces isolate reconciliation environments."
        action={<button>Create one</button>}
      />,
    );
    expect(screen.getByText("No workspaces yet")).toBeInTheDocument();
    expect(screen.getByText("Workspaces isolate reconciliation environments.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create one" })).toBeInTheDocument();
  });

  it("renders secondary link below action", () => {
    render(
      <EmptyState title="X" action={<button>A</button>} secondary={<a href="/docs">Learn more</a>} />,
    );
    expect(screen.getByRole("link", { name: "Learn more" })).toBeInTheDocument();
  });

  it("renders optional glyph", () => {
    render(<EmptyState title="X" glyph={<svg data-testid="g" />} />);
    expect(screen.getByTestId("g")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `cd app && bun run test -- empty-state`
Expected: module not found.

- [ ] **Step 3: Implement**

```tsx
// app/src/components/EmptyState.tsx
import type { ReactNode } from "react";

export function EmptyState({
  title,
  body,
  action,
  secondary,
  glyph,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  secondary?: ReactNode;
  glyph?: ReactNode;
}) {
  return (
    <div className="border border-line bg-surface-2/40 px-6 py-12 text-center">
      {glyph && <div className="mx-auto mb-4 grid place-items-center text-ink-3">{glyph}</div>}
      <h3 className="font-display text-base font-bold text-ink">{title}</h3>
      {body && <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-2">{body}</p>}
      {(action || secondary) && (
        <div className="mt-5 flex flex-col items-center gap-2">
          {action}
          {secondary && <div className="font-mono text-[11px] text-ink-3">{secondary}</div>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `cd app && bun run test -- empty-state`
Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/EmptyState.tsx app/test/empty-state.test.tsx
git commit -m "feat(components): add EmptyState primitive"
```

---

### Task 2.3: Apply Skeleton + EmptyState to Admin/Workspaces

**Files:**
- Modify: `app/src/routes/admin/Workspaces.tsx:81-129`
- Test: `app/test/admin-workspaces.test.tsx` (create)

- [ ] **Step 1: Write the test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Workspaces } from "../src/routes/admin/Workspaces";

// Mock apiFetch
vi.mock("../src/api", () => ({
  apiFetch: vi.fn(),
}));
import { apiFetch } from "../src/api";

describe("Admin/Workspaces", () => {
  beforeEach(() => vi.resetAllMocks());

  it("shows skeleton rows on first load", () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {})); // never resolves
    render(<MemoryRouter><Workspaces /></MemoryRouter>);
    expect(screen.getAllByRole("generic", { busy: true }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Loading…/)).toBeNull();
  });

  it("shows EmptyState when no workspaces", async () => {
    (apiFetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ tenants: [] }),
    });
    render(<MemoryRouter><Workspaces /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText("No workspaces yet")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /create your first workspace/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Confirm fail**

Run: `cd app && bun run test -- admin-workspaces`
Expected: tests fail (existing markup uses "Loading…" + "No workspaces yet.").

- [ ] **Step 3: Replace loading + empty in Workspaces.tsx**

Replace lines ~82-90 of `Workspaces.tsx`:

```tsx
import { SkeletonList } from "../../components/Skeleton";
import { EmptyState } from "../../components/EmptyState";

// inside JSX:
{loading ? (
  <SkeletonList rows={4} columns={[20, 160, 1, 140]} data-testid="workspaces-skeleton" />
) : tenants.length === 0 ? (
  <EmptyState
    title="No workspaces yet"
    body="Workspaces isolate reconciliation environments. Each scopes to a warehouse connection and owns its own canonical tables."
    action={
      <Button size="sm" onClick={() => setShowForm(true)}>
        Create your first workspace
      </Button>
    }
  />
) : (
  /* existing list */
)}
```

- [ ] **Step 4: Run, confirm pass**

Run: `cd app && bun run test -- admin-workspaces`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/admin/Workspaces.tsx app/test/admin-workspaces.test.tsx
git commit -m "feat(admin/workspaces): skeleton loading + activation empty state"
```

---

### Task 2.4: Apply Skeleton + EmptyState across remaining surfaces

**Files:**
- Modify: `app/src/routes/admin/Users.tsx`
- Modify: `app/src/routes/admin/Audit.tsx`
- Modify: `app/src/routes/admin/Warehouses.tsx`
- Modify: `app/src/routes/settings/Tokens.tsx` (line 127 — `Loading tokens…`)
- Modify: `app/src/routes/settings/Scans.tsx` (line 111 — `Loading scan status…`)
- Modify: `app/src/routes/settings/Members.tsx` (zero-roster state — currently invisible per spec)
- Modify: `app/src/routes/Audit.tsx` (workspace audit page from Phase 1)

For each file:

- [ ] **Step 1: Replace `<span>Loading…</span>` / `<p>Loading…</p>` with `<SkeletonList rows={N} columns={[…]}>` matching the page's final table layout.**

  Recommended column hints:
  - `Admin/Users`: `[24, 1, 100, 120]` (avatar, email/name, role, last seen)
  - `Admin/Audit`: `[120, 1, 100]` (timestamp, message, actor)
  - `Admin/Warehouses`: `[120, 1, 100]` (id, label, status)
  - `Tokens`: `[1, 120, 80]` (name, created, used)
  - `Scans`: a single status-pill row — `SkeletonRow columns={[16, 1, 80]}` inline (not a full list).

- [ ] **Step 2: Replace each "No X yet" placeholder with `<EmptyState>`.**

  Per page:
  - `Admin/Users`: title `"No users yet"`, body `"Users will appear here once they sign in."`, no primary action.
  - `Admin/Audit`: title `"No activity yet"`, body `"System activity will appear here as workspaces are created and changed."`
  - `Admin/Warehouses`: title `"No warehouses connected"`, body `"Connect a MotherDuck warehouse to begin."`, action `<Button>Add warehouse</Button>` if such a route exists; otherwise omit action.
  - `Tokens` zero state: title `"No tokens yet"`, body `"Create a personal access token for dbt or CI."`, action `<Button onClick={() => setShowForm(true)}>Create token</Button>`.
  - `Members.tsx` zero-roster: when `teamUsers.length === 0` (line ~916 currently short-circuits) — render `<EmptyState title="You're flying solo" body="Invite teammates to collaborate on this workspace." action={<Button onClick={() => inputRef.current?.focus()}>Send invites</Button>} />` ABOVE the invite chip input.

- [ ] **Step 3: Run all tests**

Run: `cd app && bun run test`
Expected: all pass. Any existing test that asserted on "Loading…" copy must be updated to assert on skeleton / aria-busy.

- [ ] **Step 4: Typecheck + lint**

Run: `cd app && bun run typecheck && bun run lint`

- [ ] **Step 5: Commit**

```bash
git add app/src/routes
git commit -m "feat(state-patterns): skeleton loading + EmptyState across admin/settings"
```

- [ ] **Step 6: Open PR for Phase 2**

```bash
git push -u origin polish/phase-2-state-patterns
gh pr create --title "Polish phase 2 — Skeleton + EmptyState across admin/settings" --body "$(cat <<'EOF'
## Summary
- New `<Skeleton>` (row, list) and `<EmptyState>` (title/body/action/secondary/glyph) primitives
- Loading states across Admin + Settings now render layout-shaped skeletons
- Empty states are activation moments with CTAs (workspaces, members, tokens, ...)
- Members.tsx zero-roster shows "You're flying solo" with invite focus

## Test plan
- [ ] Visit each admin and settings page with a slow connection — no "Loading…" text
- [ ] Brand-new workspace shows the "You're flying solo" message above invite input
- [ ] Empty Tokens shows Create CTA

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PHASE 3 — Form & feedback (5 tasks)

**Branch:** `polish/phase-3-forms-feedback`

**Outcome:** Settings/General, Profile, Appearance autosave (no Save button). One unified `ConfirmDialog` with `confirmPhrase` handles destructive flows. Toast copy is consistent, surfaces real errors.

### Task 3.1: Add `confirmPhrase` to ConfirmDialog

**Files:**
- Modify: `app/src/components/ConfirmDialog.tsx`
- Modify: `app/test/confirm-dialog.test.tsx`

- [ ] **Step 1: Add failing tests**

Append to `app/test/confirm-dialog.test.tsx`:

```tsx
import { fireEvent } from "@testing-library/react";

describe("ConfirmDialog with confirmPhrase", () => {
  it("disables confirm until phrase is typed exactly", () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        body="Type sportsbook to confirm."
        confirmPhrase="sportsbook"
        confirmLabel="Delete"
        danger
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "sportsbook" } });
    expect(confirm).not.toBeDisabled();
  });

  it("does not render input when confirmPhrase is undefined", () => {
    render(
      <ConfirmDialog open title="X" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `cd app && bun run test -- confirm-dialog`
Expected: fail.

- [ ] **Step 3: Extend ConfirmDialog**

In `app/src/components/ConfirmDialog.tsx`, add `confirmPhrase?: string` to props. Inside the dialog body, after `{body && …}`, render an input when `confirmPhrase` is set:

```tsx
import { useState } from "react";

// inside the component:
const [phrase, setPhrase] = useState("");
const phraseRequired = !!confirmPhrase;
const phraseMatches = !phraseRequired || phrase === confirmPhrase;

// reset phrase when dialog opens/closes:
useEffect(() => {
  if (!open) setPhrase("");
}, [open]);

// inside the dialog body, after {body}:
{phraseRequired && (
  <input
    type="text"
    className="mt-3 w-full rounded-sm border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent"
    placeholder={confirmPhrase}
    value={phrase}
    onChange={(e) => setPhrase(e.target.value)}
    autoComplete="off"
    spellCheck={false}
  />
)}

// confirm button:
<Button
  variant={danger ? "danger" : "primary"}
  size="sm"
  loading={loading}
  disabled={!phraseMatches}
  onClick={() => void onConfirm()}
>
  {confirmLabel}
</Button>
```

- [ ] **Step 4: Run, confirm pass**

Run: `cd app && bun run test -- confirm-dialog`
Expected: all pass (including pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/components/ConfirmDialog.tsx app/test/confirm-dialog.test.tsx
git commit -m "feat(confirm-dialog): add confirmPhrase prop"
```

---

### Task 3.2: Replace inline modal in Danger.tsx with ConfirmDialog

**Files:**
- Modify: `app/src/routes/settings/Danger.tsx`
- Modify: `app/test/danger-zone.test.tsx`

- [ ] **Step 1: Update danger-zone test**

Open `app/test/danger-zone.test.tsx`. Find the delete-workspace test and add:

```tsx
it("uses ConfirmDialog (not a bespoke modal) for delete confirmation", () => {
  // render <Danger /> with deleteOpen → expect single dialog with role=dialog
  // and exactly one textbox to type the slug
  render(<MemoryRouter><Danger /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));
  const dialog = screen.getByRole("dialog");
  expect(dialog).toBeInTheDocument();
  expect(screen.getByRole("textbox")).toBeInTheDocument();
  // The delete button is disabled until slug is typed
  const deleteBtn = screen.getAllByRole("button").find((b) => b.textContent === "Delete")!;
  expect(deleteBtn).toBeDisabled();
});
```

- [ ] **Step 2: Confirm fail**

Run: `cd app && bun run test -- danger-zone`
Expected: depends on existing test — the test may already pass if the inline modal also exposes a dialog role. Tighten assertion if needed: search for exactly ONE element with `data-testid="confirm-dialog-backdrop"` after click.

- [ ] **Step 3: Replace inline modal**

Delete `Danger.tsx` lines 108-162 (the entire `{deleteOpen && (...)}` block including its inline JSX). Replace with:

```tsx
<ConfirmDialog
  open={deleteOpen}
  title={`Delete ${tenant.label}?`}
  body={
    <>
      This will permanently delete the workspace and all its data. Type{" "}
      <strong className="font-semibold text-ink">{tenant.slug}</strong> to confirm.
    </>
  }
  confirmPhrase={tenant.slug}
  confirmLabel="Delete"
  danger
  loading={busy}
  onConfirm={() => void deleteWorkspace()}
  onCancel={() => setDeleteOpen(false)}
/>
```

Remove now-unused `deleteSlug` state and its setter.

- [ ] **Step 4: Run tests**

Run: `cd app && bun run test -- danger-zone`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/settings/Danger.tsx app/test/danger-zone.test.tsx
git commit -m "refactor(danger): use ConfirmDialog with confirmPhrase"
```

---

### Task 3.3: Convert Settings/General to autosave

**Files:**
- Modify: `app/src/routes/settings/General.tsx`
- Create: `app/src/hooks/useAutosave.ts`
- Test: `app/test/use-autosave.test.tsx` (create)
- Test: `app/test/settings-general.test.tsx` (create)

- [ ] **Step 1: Write useAutosave test**

```tsx
// app/test/use-autosave.test.tsx
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutosave } from "../src/hooks/useAutosave";

describe("useAutosave", () => {
  it("debounces save calls", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save, 500), {
      initialProps: { v: "a" },
    });
    rerender({ v: "ab" });
    rerender({ v: "abc" });
    expect(save).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("abc");
    expect(result.current.status).toBe("saved");
    vi.useRealTimers();
  });

  it("does not save if value matches initial", async () => {
    vi.useFakeTimers();
    const save = vi.fn();
    renderHook(({ v }) => useAutosave(v, save, 500), { initialProps: { v: "a" } });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(save).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Confirm fail**

Run: `cd app && bun run test -- use-autosave`
Expected: module not found.

- [ ] **Step 3: Implement useAutosave**

```tsx
// app/src/hooks/useAutosave.ts
import { useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export function useAutosave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  debounceMs = 600,
): { status: AutosaveStatus; error: string | null; flush: () => Promise<void> } {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const initial = useRef(value);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    if (value === initial.current) return;
    const t = setTimeout(async () => {
      setStatus("saving");
      setError(null);
      try {
        await save(latest.current);
        initial.current = latest.current;
        setStatus("saved");
        setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1800);
      } catch (e) {
        setStatus("error");
        setError(e instanceof Error ? e.message : "Couldn't save — try again.");
      }
    }, debounceMs);
    return () => clearTimeout(t);
  }, [value, save, debounceMs]);

  const flush = async () => {
    setStatus("saving");
    try {
      await save(latest.current);
      initial.current = latest.current;
      setStatus("saved");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Couldn't save — try again.");
    }
  };

  return { status, error, flush };
}
```

- [ ] **Step 4: Confirm pass**

Run: `cd app && bun run test -- use-autosave`
Expected: 2 pass.

- [ ] **Step 5: Write settings-general test**

```tsx
// app/test/settings-general.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { General } from "../src/routes/settings/General";

vi.mock("../src/api", () => ({ apiFetch: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../src/lib/tenant-context", () => ({
  useTenant: () => ({ slug: "ws", label: "WS", role: "admin" }),
}));

describe("Settings/General", () => {
  beforeEach(() => vi.useFakeTimers());

  it("autosaves the workspace label after debounce", async () => {
    render(<General />);
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    const input = screen.getByPlaceholderText("WS");
    fireEvent.change(input, { target: { value: "New name" } });
    await act(async () => { vi.advanceTimersByTime(700); });
    const { apiFetch } = await import("../src/api");
    await waitFor(() =>
      expect((apiFetch as any).mock.calls.some((c: any[]) =>
        c[1]?.body?.includes("New name"),
      )).toBe(true),
    );
  });
});
```

- [ ] **Step 6: Confirm fail**

Run: `cd app && bun run test -- settings-general`
Expected: Save button still present (`queryByRole` returns it).

- [ ] **Step 6.5: Extend FormField with optional `status` slot**

`app/src/components/FormField.tsx` currently has no `status` prop. Add it:

```tsx
import type { ReactNode } from "react";

export function FormField({
  label,
  hint,
  status,
  children,
}: {
  label: string;
  hint?: string;
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-2">{label}</span>
        {status}
      </span>
      {children}
      {hint && <span className="text-[12px] text-ink-2">{hint}</span>}
    </label>
  );
}
```

Run: `cd app && bun run typecheck` — expected clean.

- [ ] **Step 7: Convert General.tsx**

Rewrite `app/src/routes/settings/General.tsx`:

```tsx
import { useState } from "react";
import { useTenant } from "../../lib/tenant-context";
import { apiFetch } from "../../api";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { useAutosave } from "../../hooks/useAutosave";
import { cx } from "../../lib/cx";

export function General() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.general.edit");
  const [label, setLabel] = useState(tenant.label);

  const save = async (next: string) => {
    if (!next.trim() || next === tenant.label) return;
    const res = await apiFetch("", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: next.trim() }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
  };
  const autosave = useAutosave(label, save);

  return (
    <SettingsSection title="General" hint="Workspace identity. Slug is immutable.">
      <ReadOnly enabled={!canEdit}>
        <FormField
          label="Workspace name"
          status={
            <span
              className={cx(
                "font-mono text-[10.5px]",
                autosave.status === "error" ? "text-danger" : "text-ink-3",
              )}
              aria-live="polite"
            >
              {autosave.status === "saving" && "saving…"}
              {autosave.status === "saved" && "saved"}
              {autosave.status === "error" && (autosave.error ?? "couldn't save")}
            </span>
          }
        >
          <input
            className="w-full bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={tenant.label}
          />
        </FormField>
      </ReadOnly>

      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-3 text-sm mt-6">
        <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-3 pt-0.5">Slug</dt>
        <dd>
          <code className="font-mono text-accent">{tenant.slug}</code>
          <span className="ml-2 text-xs text-ink-3">immutable</span>
        </dd>
      </dl>
    </SettingsSection>
  );
}
```

Note: this assumes `FormField` already supports an optional `status` slot. Verify by reading `app/src/components/FormField.tsx`; if it doesn't, add `status?: ReactNode` and render it after the label.

- [ ] **Step 8: Run, confirm pass**

Run: `cd app && bun run test -- settings-general`
Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add app/src/hooks/useAutosave.ts app/src/routes/settings/General.tsx app/test/use-autosave.test.tsx app/test/settings-general.test.tsx
git commit -m "feat(settings/general): autosave with status indicator"
```

---

### Task 3.4: Convert Account/Profile to autosave

**Files:**
- Modify: `app/src/routes/account/Profile.tsx`
- Test: `app/test/account-profile.test.tsx` (create)

- [ ] **Step 1: Test (mirror of Task 3.3 test pattern)**

```tsx
// app/test/account-profile.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Profile } from "../src/routes/account/Profile";

vi.mock("../src/api", () => ({
  authFetch: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("../src/store", () => ({
  useCurrentUser: () => ({ name: "Alice", email: "alice@x.com" }),
}));

describe("Account/Profile", () => {
  beforeEach(() => vi.useFakeTimers());

  it("autosaves the display name", async () => {
    render(<Profile />);
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    fireEvent.change(screen.getByDisplayValue("Alice"), { target: { value: "Alicia" } });
    await act(async () => { vi.advanceTimersByTime(700); });
    const { authFetch } = await import("../src/api");
    await waitFor(() =>
      expect((authFetch as any).mock.calls.some((c: any[]) => c[1]?.body?.includes("Alicia"))).toBe(true),
    );
  });
});
```

- [ ] **Step 2: Convert Profile.tsx**

Apply the same `useAutosave` pattern. Remove the Save button, the `saving` state, and the `onKeyDown Enter` handler. The Sign out button stays. Keep email-readonly section.

```tsx
import { useState } from "react";
import { authFetch } from "../../api";
import { Button } from "../../components/Button";
import { FormField } from "../../components/FormField";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { useCurrentUser } from "../../store";
import { useAutosave } from "../../hooks/useAutosave";
import { cx } from "../../lib/cx";

export function Profile() {
  const user = useCurrentUser();
  const [name, setName] = useState(user?.name ?? "");

  const save = async (next: string) => {
    if (!next.trim() || next === user?.name) return;
    const res = await authFetch("/auth/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: next.trim() }),
    });
    if (!res.ok) throw new Error(`${res.status}`);
  };
  const autosave = useAutosave(name, save);

  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() => window.location.replace("/login"));

  return (
    <>
      <SettingsSection title="Profile" hint="Your display name and email address.">
        <FormField
          label="Display name"
          status={
            <span
              className={cx(
                "font-mono text-[10.5px]",
                autosave.status === "error" ? "text-danger" : "text-ink-3",
              )}
              aria-live="polite"
            >
              {autosave.status === "saving" && "saving…"}
              {autosave.status === "saved" && "saved"}
              {autosave.status === "error" && (autosave.error ?? "couldn't save")}
            </span>
          }
        >
          <input
            className="w-full bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
        </FormField>
        <FormField label="Email">
          <p className="text-sm text-ink-2">{user?.email ?? "—"}</p>
          <p className="mt-1 text-xs text-ink-3">Email cannot be changed here.</p>
        </FormField>
      </SettingsSection>

      <SettingsSection title="Session">
        <div className="flex items-center justify-between">
          <p className="text-sm text-ink-2">
            Signed in as <span className="text-ink">{user?.email}</span>
          </p>
          <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
        </div>
      </SettingsSection>
    </>
  );
}
```

- [ ] **Step 3: Run, confirm pass**

Run: `cd app && bun run test -- account-profile`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/account/Profile.tsx app/test/account-profile.test.tsx
git commit -m "feat(account/profile): autosave display name"
```

---

### Task 3.5: Toast copy pass

**Files:**
- Modify: across `app/src/routes/**/*.tsx` and `app/src/components/**/*.tsx`

Apply the three rules from spec §6.3 in one sweep:

- [ ] **Step 1: Audit toast call sites**

Run: `grep -rn 'toast(' app/src --include='*.tsx' --include='*.ts' | grep -v '__tests__' | grep -v test`

For each site, classify:
- **Success** with internals (e.g. "takes effect on next navigation", "they'll join when they next sign in") → strip internals.
- **Error** with generic copy ("Failed to X") → surface server-returned error when present; fall back to a concise alternative.

- [ ] **Step 2: Apply edits**

Specific known sites:

`app/src/routes/settings/General.tsx` (post-autosave) — autosave conversion already removed the toast. ✓ no-op.

`app/src/routes/settings/Members.tsx:876`:
```tsx
// before:
toast(`Invite${sentCount > 1 ? "s" : ""} sent — they'll join when they next sign in.`);
// after:
toast(`Invite${sentCount > 1 ? "s" : ""} sent.`, "success");
```

`app/src/routes/settings/Danger.tsx:30`:
```tsx
// before:
toast("You are the last admin of this workspace. Transfer ownership before leaving.", "error");
// keep — this one is appropriate and actionable.
```

`app/src/routes/settings/Danger.tsx:37, 52`:
```tsx
// before:
toast("Failed to leave workspace.", "error");
toast("Failed to delete workspace.", "error");
// after: read server error if available
async function readServerError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    return (j?.error || j?.message || `${res.status}`).toString();
  } catch {
    return `${res.status}`;
  }
}
// usage:
const msg = await readServerError(res);
toast(`Couldn't leave workspace — ${msg}.`, "error");
```

Apply the same `readServerError` helper to other `Failed to X` → `Couldn't X — {server error}` patterns. Put the helper in `app/src/lib/api-errors.ts` and import where needed:

```tsx
// app/src/lib/api-errors.ts
export async function readServerError(res: Response): Promise<string> {
  try {
    const j = await res.json();
    const m = j?.error || j?.message;
    return typeof m === "string" && m.length > 0 ? m : `${res.status}`;
  } catch {
    return `${res.status}`;
  }
}
```

- [ ] **Step 3: Run all tests**

Run: `cd app && bun run test`
Expected: any test asserting on old toast copy must be updated.

- [ ] **Step 4: Typecheck + lint**

Run: `cd app && bun run typecheck && bun run lint`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(toasts): consistent voice, real server errors, drop internals"
```

- [ ] **Step 6: Open PR for Phase 3**

```bash
git push -u origin polish/phase-3-forms-feedback
gh pr create --title "Polish phase 3 — autosave + unified confirm + toast voice" --body "$(cat <<'EOF'
## Summary
- New `useAutosave` hook + autosave for Settings/General and Account/Profile
- ConfirmDialog gains `confirmPhrase` prop; Danger inline modal deleted
- Toast copy pass — internals stripped, server errors surfaced
- `readServerError` helper for consistent error formatting

## Test plan
- [ ] Edit workspace name — no Save button, "saving…" → "saved" inline
- [ ] Edit display name — same flow
- [ ] Delete workspace shows ConfirmDialog with slug input (one dialog, not two markup styles)
- [ ] Invite success toast says "Invites sent." (no internals)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PHASE 4 — User vs workspace cleanup (3 tasks)

**Branch:** `polish/phase-4-memberships`

**Outcome:** Account → Memberships page exists, lists all workspaces the user belongs to with per-row Leave. Danger zone contains only Delete. Notifications stub hidden.

### Task 4.1: Build Account → Memberships route

**Files:**
- Create: `app/src/routes/account/Memberships.tsx`
- Modify: `app/src/components/settings/AccountSidebar.tsx`
- Modify: `app/src/main.tsx` (add route)
- Test: `app/test/account-memberships.test.tsx` (create)

- [ ] **Step 1: Inspect available data**

The bootstrap response exposes `boot.memberships`. Find its shape:

```bash
grep -n "memberships" app/src/store.ts app/src/components/BootGate.tsx app/src/main.tsx | head -20
```

Identify how to read it from a hook (likely a `useMemberships()` selector or pulled from `boot` prop).

- [ ] **Step 2: Write the failing test**

```tsx
// app/test/account-memberships.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Memberships } from "../src/routes/account/Memberships";

vi.mock("../src/store", () => ({
  useMemberships: () => [
    { slug: "sportsbook", label: "Sportsbook", role: "admin", joinedAt: "2026-04-12" },
    { slug: "media", label: "Media", role: "editor", joinedAt: "2026-05-03" },
  ],
}));

describe("Account/Memberships", () => {
  it("lists every workspace with role and Leave button", () => {
    render(<MemoryRouter><Memberships /></MemoryRouter>);
    expect(screen.getByText("Sportsbook")).toBeInTheDocument();
    expect(screen.getByText("Media")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /leave/i })).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Confirm fail**

Run: `cd app && bun run test -- account-memberships`
Expected: module not found.

- [ ] **Step 4: Implement Memberships.tsx**

```tsx
// app/src/routes/account/Memberships.tsx
import { useState } from "react";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { toast } from "../../components/Toast";
import { useMemberships } from "../../store";

interface Membership {
  slug: string;
  label: string;
  role: "admin" | "editor" | "viewer";
  joinedAt: string;
}

export function Memberships() {
  const memberships = useMemberships() as Membership[];
  const [leaving, setLeaving] = useState<Membership | null>(null);
  const [busy, setBusy] = useState(false);

  const leave = async () => {
    if (!leaving) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/t/${leaving.slug}/leave`, { method: "POST" });
      if (!res.ok) {
        const code = res.status === 409 ? "last_admin" : "error";
        if (code === "last_admin") {
          toast(`Can't leave ${leaving.label} — you're the last admin.`, "error");
        } else {
          toast(`Couldn't leave ${leaving.label}.`, "error");
        }
        return;
      }
      toast(`Left ${leaving.label}.`, "success");
      setLeaving(null);
      // Refresh app state — simplest: reload to re-bootstrap memberships
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Workspaces"
      hint="Every workspace you belong to. Leave any to remove yourself."
    >
      <ul className="divide-y divide-line border border-line">
        {memberships.map((m) => (
          <li key={m.slug} className="flex items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium text-ink truncate">{m.label}</div>
              <div className="font-mono text-[10.5px] text-ink-3">
                /{m.slug} · {m.role} · joined {m.joinedAt}
              </div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setLeaving(m)}>
              Leave
            </Button>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={leaving !== null}
        title={leaving ? `Leave ${leaving.label}?` : ""}
        body="You'll lose access immediately."
        confirmLabel="Leave"
        danger
        loading={busy}
        onConfirm={leave}
        onCancel={() => setLeaving(null)}
      />
    </SettingsSection>
  );
}
```

- [ ] **Step 5: Add route in main.tsx**

```tsx
<Route path="memberships" element={<Memberships />} />
```

- [ ] **Step 6: Add to AccountSidebar.tsx ITEMS**

```tsx
const ITEMS = [
  { label: "Profile", to: "profile" },
  { label: "Appearance", to: "appearance" },
  { label: "Memberships", to: "memberships" },
  // Notifications removed in 4.2
];
```

- [ ] **Step 7: If `useMemberships` doesn't exist in store.ts, add a thin selector**

```tsx
// in app/src/store.ts
export function useMemberships() {
  const boot = useBootData();
  return boot?.memberships ?? [];
}
```

Adapt to the actual bootstrap-state pattern used in the repo (the BootGate likely owns this).

- [ ] **Step 8: Confirm test passes**

Run: `cd app && bun run test -- account-memberships`
Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(account): memberships page"
```

---

### Task 4.2: Remove Leave from Danger, hide Notifications

**Files:**
- Modify: `app/src/routes/settings/Danger.tsx` (remove Leave block)
- Modify: `app/src/components/settings/AccountSidebar.tsx` (remove Notifications)
- Modify: `app/src/main.tsx` (drop notifications route or redirect to /memberships)
- Modify: `app/test/danger-zone.test.tsx`

- [ ] **Step 1: Remove the Leave block from Danger.tsx**

Delete the `<div className="flex items-center justify-between rounded-md border border-line p-4">…Leave workspace…</div>` block and its supporting `leaveOpen`/`leave()`/`ConfirmDialog` for Leave. Keep Delete.

- [ ] **Step 2: Remove Notifications**

In `AccountSidebar.tsx`, drop the Notifications item (already noted in 4.1 Step 6). In `main.tsx`, remove or redirect the `/account/notifications` route:

```tsx
<Route path="notifications" element={<Navigate to="../memberships" replace />} />
```

- [ ] **Step 3: Update danger-zone test**

Remove any test that asserts on "Leave workspace" being in Danger. Add an inverse assertion:

```tsx
it("does not render Leave workspace (moved to Account/Memberships)", () => {
  render(<MemoryRouter><Danger /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: /leave workspace/i })).toBeNull();
});
```

- [ ] **Step 4: Run all tests**

Run: `cd app && bun run test`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(account,settings): move Leave to Memberships; hide Notifications"
```

---

### Task 4.3: Optionally delete `account/Notifications.tsx`

**Files:**
- Delete: `app/src/routes/account/Notifications.tsx`

- [ ] **Step 1: Confirm no remaining imports**

Run: `grep -rn 'Notifications' app/src | grep -v test`
Expected: only the redirect target should remain.

- [ ] **Step 2: Delete the file**

```bash
rm app/src/routes/account/Notifications.tsx
```

- [ ] **Step 3: Typecheck**

Run: `cd app && bun run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(account): remove Notifications stub"
```

- [ ] **Step 5: Open PR for Phase 4**

```bash
git push -u origin polish/phase-4-memberships
gh pr create --title "Polish phase 4 — Memberships page; hide Notifications" --body "$(cat <<'EOF'
## Summary
- New Account → Memberships page listing every workspace the user belongs to
- Leave workspace action moves from Settings → Danger to Account → Memberships
- Danger zone is now Delete-only (single concern)
- Notifications stub removed from nav (redirect to Memberships for old links)

## Test plan
- [ ] Account sidebar: Profile, Appearance, Memberships (no Notifications)
- [ ] Memberships lists all workspaces with Leave per row
- [ ] Last-admin guard still returns 409 → toast shown
- [ ] Settings → Danger shows only Delete workspace

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## PHASE 5 — Sidebar icons (3 tasks)

**Branch:** `polish/phase-5-sidebar-icons`

**Outcome:** Settings / Account / Admin sidebars use icons instead of `01–0N` mono numbers. Same hover/active treatment.

### Task 5.1: Add icons to `Icons.tsx`

**Files:**
- Modify: `app/src/components/Icons.tsx`

- [ ] **Step 1: Add icons for sidebar items**

Hand-rolled SVGs in the existing `Base` style (24x24, 1.6 stroke, currentColor). Add to `Icons.tsx`:

```tsx
export const IconUsers = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Base>
);
export const IconWand = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M15 9h0M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5" />
  </Base>
);
export const IconDatabase = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v14a9 3 0 0 0 18 0V5" />
    <path d="M3 12a9 3 0 0 0 18 0" />
  </Base>
);
export const IconOctagonAlert = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z" />
    <path d="M12 8v4M12 16h0" />
  </Base>
);
export const IconUser = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-1a8 8 0 0 1 16 0v1" />
  </Base>
);
export const IconPalette = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor" />
    <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor" />
    <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor" />
    <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor" />
    <path d="M12 2a10 10 0 1 0 0 20 2 2 0 0 0 0-4h-1.5a2.5 2.5 0 1 1 0-5H17a5 5 0 0 0 0-10z" />
  </Base>
);
export const IconLayers = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <path d="m12 2 9 4-9 4-9-4z" />
    <path d="m3 12 9 4 9-4" />
    <path d="m3 18 9 4 9-4" />
  </Base>
);
export const IconBuilding = (p: SVGProps<SVGSVGElement>) => (
  <Base {...p}>
    <rect x="4" y="2" width="16" height="20" rx="2" />
    <path d="M9 6h.01M9 10h.01M9 14h.01M14 6h.01M14 10h.01M14 14h.01M9 22v-4h6v4" />
  </Base>
);
```

(`IconSettings`, `IconAudit` already added in Phase 1; `IconMapping` exists.)

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/Icons.tsx
git commit -m "feat(icons): add sidebar-section icons"
```

---

### Task 5.2: Replace numbers in `SettingsSidebar`, `AccountSidebar`, `AdminSidebar`

**Files:**
- Modify: `app/src/components/settings/SettingsSidebar.tsx`
- Modify: `app/src/components/settings/AccountSidebar.tsx`
- Modify: `app/src/components/admin/AdminSidebar.tsx`
- Modify: `app/test/settings-sidebar.test.tsx`
- Modify: `app/test/admin-sidebar.test.tsx`

- [ ] **Step 1: Update each sidebar's ITEMS to include an icon component**

`SettingsSidebar.tsx`:

```tsx
import { IconSettings, IconUsers, IconWand, IconDatabase, IconOctagonAlert } from "../Icons";
import type { SVGProps, ComponentType } from "react";

interface Item {
  label: string;
  to: string;
  action: Action;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const ITEMS: Item[] = [
  { label: "General", to: "general", action: "settings.general.view", Icon: IconSettings },
  { label: "Members", to: "members", action: "settings.members.view", Icon: IconUsers },
  { label: "Matching", to: "matching", action: "settings.matching.view", Icon: IconWand },
  { label: "Warehouse", to: "warehouse", action: "settings.warehouse.view", Icon: IconDatabase },
  { label: "Danger", to: "danger", action: "settings.danger.leave", Icon: IconOctagonAlert },
];
```

Inside the render, replace the `<span className="font-mono text-[10px] tabular-nums w-[18px] text-right shrink-0 transition-colors">{String(i + 1).padStart(2, "0")}</span>` block with:

```tsx
<item.Icon className="h-3.5 w-3.5 shrink-0 opacity-70 group-hover:opacity-100" />
```

Apply the same conversion to `AccountSidebar.tsx`:

```tsx
import { IconUser, IconPalette, IconLayers } from "../Icons";

const ITEMS = [
  { label: "Profile", to: "profile", Icon: IconUser },
  { label: "Appearance", to: "appearance", Icon: IconPalette },
  { label: "Memberships", to: "memberships", Icon: IconLayers },
];
```

And `AdminSidebar.tsx`:

```tsx
import { IconBuilding, IconUsers, IconAudit, IconDatabase } from "../Icons";

const ITEMS = [
  { label: "Workspaces", to: "workspaces", Icon: IconBuilding },
  { label: "Users", to: "users", Icon: IconUsers },
  { label: "Audit", to: "audit", Icon: IconAudit },
  { label: "Warehouses", to: "warehouses", Icon: IconDatabase },
];
```

- [ ] **Step 2: Update sidebar tests**

Remove any assertion looking for `"01"`, `"02"`, etc. Instead, assert all items render their label and that an `<svg>` precedes the label in each row.

```tsx
it("renders an icon for each item", () => {
  render(<MemoryRouter><SettingsSidebar /></MemoryRouter>);
  const links = screen.getAllByRole("link");
  for (const link of links) {
    expect(link.querySelector("svg")).not.toBeNull();
  }
});
```

- [ ] **Step 3: Run tests**

Run: `cd app && bun run test`
Expected: pass.

- [ ] **Step 4: Visual sanity check**

Run: `cd app && bun run dev` and check `/app/:slug/settings`, `/account`, `/app/admin` sidebars — each row shows icon + label, no `01–0N` numbers.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/settings/SettingsSidebar.tsx app/src/components/settings/AccountSidebar.tsx app/src/components/admin/AdminSidebar.tsx app/test/settings-sidebar.test.tsx app/test/admin-sidebar.test.tsx
git commit -m "refactor(sidebars): icons instead of numbered prefixes"
```

---

### Task 5.3: PR

- [ ] **Step 1: Push and open PR**

```bash
git push -u origin polish/phase-5-sidebar-icons
gh pr create --title "Polish phase 5 — sidebar icons" --body "$(cat <<'EOF'
## Summary
- Settings / Account / Admin sidebars: numbers (01–0N) replaced with icons
- Hand-rolled SVGs in Icons.tsx (no new dependency)
- Same hover translate / active accent / left-bar treatment

## Test plan
- [ ] Visit Settings, Account, Admin — each item shows an icon
- [ ] Active item keeps the accent left-bar and accent-soft background
- [ ] Hover still translates the row 2px right

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

The plan was reviewed against the spec for coverage:

- **Phase 1 (IA collapse)** covers spec §4 — tab fold (4.1), warehouse-as-parent (4.2), audit promotion (4.3), PageHeader unification (4.4). ✓
- **Phase 2 (state patterns)** covers spec §5 — skeleton primitives (5.1) and activation empty states (5.2). ✓
- **Phase 3 (form & feedback)** covers spec §6 — autosave + SyncPill (6.1, implemented inline per-field since SyncPill is global; matches the existing autosave pattern in Scans/Matching), confirmPhrase (6.2), toast voice (6.3). ✓
- **Phase 4 (cleanup)** covers spec §7 — Memberships page (7.1), hide Notifications (7.2). ✓
- **Phase 5 (sidebar polish)** covers spec §8 — numbers → icons. ✓

Tier 3 items (Appearance dedup, Admin breadcrumb chip, zz-rise gating) are deferred per spec §10 and not in this plan.

**Open question carried from spec §11:** the audit-promotion assumes the workspace audit log has utility today. If post-launch feedback says no, Phase 1 Task 1.5 is the easiest to revert independently.

**Adaptation noted:** spec §6.1 mentions "SyncPill next to the field". SyncPill is global in the actual codebase (`app/src/components/SyncPill.tsx` reads `useSyncStatus()` for the topbar). The plan uses an inline `<span>saving…/saved/couldn't save</span>` next to the field label via FormField's `status` slot, matching the existing autosave pattern in `Scans.tsx` (`setPreferences` → global pill). If preferred, switch to global pill by removing the inline status and having `useAutosave` call into the same store action that updates `useSyncStatus`.
