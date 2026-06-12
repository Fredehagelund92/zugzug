# Settings IA PR A — Scaffold + role infrastructure + extraction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1683-line monolithic `Settings.tsx` with a nested `/settings/*` route tree backed by a `SettingsShell` primitive, role-filtered sidebar, and one-section-per-file extraction — without changing any behavior or shipping any new server endpoints.

**Architecture:** Introduce a typed `can(tenant, action)` permission helper plus two React primitives (`RoleGate` for hide/show, `ReadOnly` for visual disable). Build a 220px-left-rail `SettingsShell` primitive used by `SettingsLayout`. Move each existing Settings section (Members, Tokens, Scans, Matching, Warehouse) into its own file under `app/src/routes/settings/`. Add stub `General.tsx`, `Audit.tsx` (live — wraps existing `useAudit`), and `Danger.tsx` (stub for PR B). Delete `Settings.tsx`.

**Tech Stack:** React 18, react-router-dom v6, Tailwind v4, Vitest, @testing-library/react. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-12-settings-ia-redesign.md`

**Branch:** `mt-pr5a-settings-ia` off `main`. Prereq: PR4 (`mt-pr4-ui-shell`) merged.

**Scope notes:**

- This PR is the IA scaffold + extraction. No new server endpoints. No new functional features beyond the role gating itself.
- Behavior is preserved 1:1: every existing test for Team / Tokens / Scans / API tokens that currently passes against `Settings.tsx` must still pass against the extracted files.
- `General.tsx` ships as a read-only stub showing workspace label + slug + created_at (rename comes in PR B).
- `Danger.tsx` ships as an empty placeholder (real Leave/Delete actions come in PR B).
- Theme + engineer mode stay in `Settings/Appearance` for this PR — they move to `Account/Appearance` in PR B.

---

## File structure (post-PR)

```
app/src/lib/permissions.ts                       NEW — Action type + can() truth table
app/src/components/settings/SettingsShell.tsx    NEW — 220px sidebar + content primitive
app/src/components/settings/SettingsLayout.tsx   NEW — workspace settings layout (wraps SettingsShell)
app/src/components/settings/SettingsSidebar.tsx  NEW — role-filtered nav list
app/src/components/settings/SettingsSection.tsx  NEW — card shell (extracted from Settings.tsx Section)
app/src/components/settings/RoleGate.tsx         NEW — hide/show by action
app/src/components/settings/ReadOnly.tsx         NEW — fieldset wrapper

app/src/routes/settings/General.tsx              NEW — workspace label + slug (read-only stub)
app/src/routes/settings/Members.tsx              NEW — extracted TeamSection
app/src/routes/settings/Tokens.tsx               NEW — extracted API tokens UI
app/src/routes/settings/Scans.tsx                NEW — extracted ScansSection
app/src/routes/settings/Matching.tsx             NEW — extracted matching defaults
app/src/routes/settings/Warehouse.tsx            NEW — extracted Data flow / Workspace info
app/src/routes/settings/Appearance.tsx           NEW — extracted theme + engineer mode (moves to Account in PR B)
app/src/routes/settings/Audit.tsx                NEW — per-workspace audit timeline (uses existing useAudit)
app/src/routes/settings/Danger.tsx               NEW — empty placeholder (real impl in PR B)
app/src/routes/settings/_shared.ts               NEW — shared helpers extracted from Settings.tsx
                                                       (relativeTime, ScanStatus, role types,
                                                        RolePopover, MemberRoleControl, MemberRow,
                                                        TeamRoster, RoleFilterPill, PendingInvitesList,
                                                        ChipPill, HealthBadge)

app/src/routes/Settings.tsx                      DELETE

app/src/main.tsx                                 MOD — nested /settings/* routes
app/src/components/AppShell.tsx                  MOD — Settings nav: useNavLinks().settings already
                                                       points to /app/:slug/settings; verify it still
                                                       resolves correctly to the new /general default

app/test/permissions.test.ts                     NEW — can() truth table across action × role
app/test/settings-sidebar.test.tsx               NEW — role filtering + active route highlighting
app/test/read-only.test.tsx                      NEW — fieldset disabled, blocks interaction
app/test/settings-redirect.test.tsx              NEW — /settings → /settings/general
```

---

## Task 1: Branch kickoff + baseline

**Files:** none.

- [ ] **Step 1: Confirm PR4 merged**

```bash
git log --oneline main | head -10 | grep -c "PR 4\|pr4-ui-shell"
```

Expected: at least 1.

- [ ] **Step 2: Create branch**

```bash
git checkout main && git pull --ff-only origin main && git checkout -b mt-pr5a-settings-ia
```

- [ ] **Step 3: Baseline test counts**

```bash
cd app && bun run test 2>&1 | tail -3
cd app && bun run typecheck 2>&1 | tail -3
cd app && bun run lint 2>&1 | tail -3
```

Record numbers in PR description at the end.

---

## Task 2: `permissions.ts` — typed `can()` helper

The single source of truth for client-side role gating. Pure, no React, no IO — just a typed switch.

**Files:**
- Create: `app/src/lib/permissions.ts`
- Test: `app/test/permissions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/test/permissions.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { can, type Action } from "../src/lib/permissions";
import type { TenantContextValue } from "../src/lib/tenant-context";

function t(role: "admin" | "editor" | "viewer", isSuperAdmin = false): TenantContextValue {
  return { id: "t1", slug: "acme", label: "Acme", role, isSuperAdmin };
}

const MATRIX: Record<Action, Record<"viewer" | "editor" | "admin", boolean>> = {
  "account.profile.edit":     { viewer: true,  editor: true,  admin: true },
  "settings.general.view":    { viewer: true,  editor: true,  admin: true },
  "settings.general.edit":    { viewer: false, editor: false, admin: true },
  "settings.members.view":    { viewer: true,  editor: true,  admin: true },
  "settings.members.edit":    { viewer: false, editor: false, admin: true },
  "settings.tokens.view":     { viewer: false, editor: true,  admin: true },
  "settings.tokens.edit":     { viewer: false, editor: false, admin: true },
  "settings.scans.view":      { viewer: true,  editor: true,  admin: true },
  "settings.scans.edit":      { viewer: false, editor: true,  admin: true },
  "settings.matching.view":   { viewer: true,  editor: true,  admin: true },
  "settings.matching.edit":   { viewer: false, editor: true,  admin: true },
  "settings.warehouse.view":  { viewer: true,  editor: true,  admin: true },
  "settings.audit.view":      { viewer: true,  editor: true,  admin: true },
  "settings.appearance.edit": { viewer: true,  editor: true,  admin: true },
  "settings.danger.leave":    { viewer: true,  editor: true,  admin: true },
  "settings.danger.delete":   { viewer: false, editor: false, admin: true },
  "admin.view":               { viewer: false, editor: false, admin: false },
};

describe("can()", () => {
  for (const [action, byRole] of Object.entries(MATRIX) as [Action, Record<string, boolean>][]) {
    for (const role of ["viewer", "editor", "admin"] as const) {
      test(`${role} → ${action} = ${byRole[role]}`, () => {
        expect(can(t(role), action)).toBe(byRole[role]);
      });
    }
  }

  test("super-admin can do admin.view regardless of workspace role", () => {
    expect(can(t("viewer", true), "admin.view")).toBe(true);
    expect(can(t("editor", true), "admin.view")).toBe(true);
  });

  test("super-admin entering as viewer still gets settings edits via tenant context", () => {
    // TenantLayout already promotes super-admin to role:"admin" for non-member tenants,
    // so can() does not need to special-case this. Verify the contract:
    // a super-admin whose role is genuinely "viewer" (a real viewer who is also super-admin
    // in some other workspace context) is gated as a viewer here.
    expect(can(t("viewer", true), "settings.tokens.edit")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun run test test/permissions.test.ts 2>&1 | tail -5
```

Expected: module not found.

- [ ] **Step 3: Implement `permissions.ts`**

Create `app/src/lib/permissions.ts`:

```ts
import type { TenantContextValue } from "./tenant-context";

export type Action =
  | "account.profile.edit"
  | "settings.general.view"
  | "settings.general.edit"
  | "settings.members.view"
  | "settings.members.edit"
  | "settings.tokens.view"
  | "settings.tokens.edit"
  | "settings.scans.view"
  | "settings.scans.edit"
  | "settings.matching.view"
  | "settings.matching.edit"
  | "settings.warehouse.view"
  | "settings.audit.view"
  | "settings.appearance.edit"
  | "settings.danger.leave"
  | "settings.danger.delete"
  | "admin.view";

/**
 * Client-side permission check. Mirrors the role matrix in the spec.
 * Server enforces all mutations independently — this is UX only.
 *
 * Note: TenantLayout already promotes super-admin to role:"admin" when entering
 * a workspace they are not a member of, so most actions need only inspect the
 * effective role. admin.view is the one exception — it's super-admin only.
 */
export function can(t: TenantContextValue, action: Action): boolean {
  switch (action) {
    case "account.profile.edit":
    case "settings.appearance.edit":
    case "settings.danger.leave":
      return true;

    case "settings.general.view":
    case "settings.members.view":
    case "settings.scans.view":
    case "settings.matching.view":
    case "settings.warehouse.view":
    case "settings.audit.view":
      return true;

    case "settings.tokens.view":
      return t.role === "editor" || t.role === "admin";

    case "settings.scans.edit":
    case "settings.matching.edit":
      return t.role === "editor" || t.role === "admin";

    case "settings.general.edit":
    case "settings.members.edit":
    case "settings.tokens.edit":
    case "settings.danger.delete":
      return t.role === "admin";

    case "admin.view":
      return t.isSuperAdmin;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd app && bun run test test/permissions.test.ts 2>&1 | tail -5
```

Expected: 50+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/permissions.ts app/test/permissions.test.ts
git commit -m "feat(app): permissions can() helper + role matrix"
```

---

## Task 3: `RoleGate` primitive

Conditional render by action. Used by `SettingsSidebar` to filter nav items and by sections that should not mount at all for the current role.

**Files:**
- Create: `app/src/components/settings/RoleGate.tsx`

- [ ] **Step 1: Implement `RoleGate`**

Create `app/src/components/settings/RoleGate.tsx`:

```tsx
import type { ReactNode } from "react";
import { useTenant } from "../../lib/tenant-context";
import { can, type Action } from "../../lib/permissions";

export function RoleGate({
  action,
  children,
  fallback = null,
}: {
  action: Action;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const tenant = useTenant();
  return <>{can(tenant, action) ? children : fallback}</>;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/settings/RoleGate.tsx
git commit -m "feat(app): RoleGate primitive"
```

---

## Task 4: `ReadOnly` primitive

Visually disables form controls without unmounting them. Wraps content in `<fieldset disabled>` so every nested input/button/select becomes inert. `aria-disabled` for screen readers.

**Files:**
- Create: `app/src/components/settings/ReadOnly.tsx`
- Test: `app/test/read-only.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/test/read-only.test.tsx`:

```tsx
import { describe, expect, test } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReadOnly } from "../src/components/settings/ReadOnly";

describe("ReadOnly", () => {
  test("renders children when enabled=false", () => {
    render(
      <ReadOnly enabled={false}>
        <button>click me</button>
      </ReadOnly>,
    );
    const btn = screen.getByRole("button", { name: /click me/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  test("disables nested controls when enabled=true", () => {
    let clicked = 0;
    render(
      <ReadOnly enabled={true}>
        <button onClick={() => clicked++}>click me</button>
        <input data-testid="i" defaultValue="x" />
      </ReadOnly>,
    );
    const btn = screen.getByRole("button", { name: /click me/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(clicked).toBe(0);
    const i = screen.getByTestId("i") as HTMLInputElement;
    expect(i.disabled).toBe(true);
  });

  test("sets aria-disabled on the wrapper for screen readers", () => {
    render(
      <ReadOnly enabled={true}>
        <span data-testid="kid">x</span>
      </ReadOnly>,
    );
    const wrapper = screen.getByTestId("kid").parentElement!;
    expect(wrapper.getAttribute("aria-disabled")).toBe("true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun run test test/read-only.test.tsx 2>&1 | tail -5
```

Expected: module not found.

- [ ] **Step 3: Implement `ReadOnly`**

Create `app/src/components/settings/ReadOnly.tsx`:

```tsx
import type { ReactNode } from "react";

/**
 * Visually disables form controls inside without unmounting them. Uses native
 * <fieldset disabled> so every nested input/button/select/textarea becomes
 * inert with zero per-field plumbing. The wrapper carries aria-disabled
 * so assistive tech announces the state.
 *
 * Pass enabled={!can(tenant, "...edit")} from callers — keep the action lookup
 * at the call site so each section reads at a glance which permission gates it.
 */
export function ReadOnly({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <fieldset
      disabled={enabled}
      aria-disabled={enabled || undefined}
      className={enabled ? "opacity-70 cursor-not-allowed" : undefined}
    >
      {children}
    </fieldset>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd app && bun run test test/read-only.test.tsx 2>&1 | tail -5
```

Expected: 3 pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/settings/ReadOnly.tsx app/test/read-only.test.tsx
git commit -m "feat(app): ReadOnly primitive"
```

---

## Task 5: `SettingsShell` primitive

The 220px-left-rail + content shell. Pure layout — takes a `sidebar` slot and renders children on the right. Reused by `SettingsLayout` now and `Account` / `AdminLayout` in later PRs.

**Files:**
- Create: `app/src/components/settings/SettingsShell.tsx`

- [ ] **Step 1: Implement `SettingsShell`**

Create `app/src/components/settings/SettingsShell.tsx`:

```tsx
import type { ReactNode } from "react";

/**
 * Two-pane shell: 220px sidebar on the left, content on the right.
 * Pure layout. No nav logic, no active-route awareness — those live in the
 * sidebar component that the caller passes in.
 *
 * Used by:
 *   - SettingsLayout (workspace settings, this PR)
 *   - Account (PR B)
 *   - AdminLayout (PR C)
 */
export function SettingsShell({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8">
      <div className="flex gap-6 md:gap-8">
        <aside className="w-[220px] shrink-0">{sidebar}</aside>
        <main className="min-w-0 flex-1 space-y-4 md:space-y-6">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/settings/SettingsShell.tsx
git commit -m "feat(app): SettingsShell layout primitive"
```

---

## Task 6: `SettingsSidebar` — role-filtered nav

Renders the workspace settings nav as a grouped list. Each item is hidden when the current role can't view it. Active route gets the accent highlight.

**Files:**
- Create: `app/src/components/settings/SettingsSidebar.tsx`
- Test: `app/test/settings-sidebar.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `app/test/settings-sidebar.test.tsx`:

```tsx
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import { SettingsSidebar } from "../src/components/settings/SettingsSidebar";

function harness(role: "viewer" | "editor" | "admin", path = "/app/acme/settings/general") {
  const value: TenantContextValue = {
    id: "t1",
    slug: "acme",
    label: "Acme",
    role,
    isSuperAdmin: false,
  };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TenantProvider value={value}>
        <SettingsSidebar />
      </TenantProvider>
    </MemoryRouter>,
  );
}

describe("SettingsSidebar", () => {
  test("viewer does NOT see Tokens", () => {
    harness("viewer");
    expect(screen.queryByText(/general/i)).toBeTruthy();
    expect(screen.queryByText(/members/i)).toBeTruthy();
    expect(screen.queryByText(/tokens/i)).toBeNull();
  });

  test("editor sees Tokens", () => {
    harness("editor");
    expect(screen.queryByText(/tokens/i)).toBeTruthy();
  });

  test("admin sees every section", () => {
    harness("admin");
    for (const label of ["General", "Members", "Tokens", "Scans", "Matching", "Warehouse", "Appearance", "Audit", "Danger"]) {
      expect(screen.queryByText(new RegExp(`^${label}$`, "i"))).toBeTruthy();
    }
  });

  test("active route gets aria-current", () => {
    harness("admin", "/app/acme/settings/members");
    const active = screen.getByText(/^members$/i).closest("a");
    expect(active?.getAttribute("aria-current")).toBe("page");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun run test test/settings-sidebar.test.tsx 2>&1 | tail -5
```

Expected: module not found.

- [ ] **Step 3: Implement `SettingsSidebar`**

Create `app/src/components/settings/SettingsSidebar.tsx`:

```tsx
import { NavLink } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can, type Action } from "../../lib/permissions";
import { cx } from "../../lib/cx";

interface Item {
  label: string;
  to: string;
  action: Action;
}

const ITEMS: Item[] = [
  { label: "General",    to: "general",    action: "settings.general.view" },
  { label: "Members",    to: "members",    action: "settings.members.view" },
  { label: "Tokens",     to: "tokens",     action: "settings.tokens.view" },
  { label: "Scans",      to: "scans",      action: "settings.scans.view" },
  { label: "Matching",   to: "matching",   action: "settings.matching.view" },
  { label: "Warehouse",  to: "warehouse",  action: "settings.warehouse.view" },
  { label: "Appearance", to: "appearance", action: "settings.appearance.edit" },
  { label: "Audit",      to: "audit",      action: "settings.audit.view" },
  { label: "Danger",     to: "danger",     action: "settings.danger.leave" },
];

export function SettingsSidebar() {
  const tenant = useTenant();
  const visible = ITEMS.filter((i) => can(tenant, i.action));

  return (
    <nav aria-label="Settings sections" className="space-y-1">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-3 px-3 pb-2">
        Workspace
      </div>
      {visible.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end
          className={({ isActive }) =>
            cx(
              "block px-3 py-1.5 text-sm font-body transition-colors rounded-sm",
              isActive
                ? "bg-surface-2 text-ink"
                : "text-ink-2 hover:text-ink hover:bg-hover",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd app && bun run test test/settings-sidebar.test.tsx 2>&1 | tail -5
```

Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/settings/SettingsSidebar.tsx app/test/settings-sidebar.test.tsx
git commit -m "feat(app): SettingsSidebar role-filtered nav"
```

---

## Task 7: `SettingsSection` — extract the card shell

The current `Settings.tsx` defines a local `Section` component (lines 41–63) wrapping `<Card>` with a header strip. Lift it out as `SettingsSection` so extracted section files can reuse it.

**Files:**
- Create: `app/src/components/settings/SettingsSection.tsx`

- [ ] **Step 1: Read the original**

Open `app/src/routes/Settings.tsx` lines 41–63 to confirm the exact JSX.

- [ ] **Step 2: Implement `SettingsSection`**

Create `app/src/components/settings/SettingsSection.tsx`:

```tsx
import type { ReactNode } from "react";
import { Card } from "../Card";

export function SettingsSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-0">
      <div className="border-b border-line px-4 py-3 md:px-6 md:py-4">
        <div className="max-w-2xl">
          <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-ink-2">{hint}</p>}
        </div>
      </div>
      <div className="px-4 py-4 md:px-6 md:py-5">
        <div className="max-w-2xl space-y-5">{children}</div>
      </div>
    </Card>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/settings/SettingsSection.tsx
git commit -m "feat(app): lift SettingsSection card shell from Settings.tsx"
```

---

## Task 8: `_shared.ts` — extract sub-components used by multiple sections

`Settings.tsx` has many internal sub-components (RolePopover, MemberRoleControl, MemberRow, TeamRoster, RoleFilterPill, PendingInvitesList, ChipPill, HealthBadge, ScanStatus, relativeTime, etc.). Some are used only by one section; others (HealthBadge, relativeTime) are reused. Extract the genuinely shared helpers into `_shared.ts`. Per-section internals go into their own section file in later tasks.

**Files:**
- Create: `app/src/routes/settings/_shared.ts` (and `_shared.tsx` if it needs JSX — split if needed)

- [ ] **Step 1: Identify what's shared vs single-use**

Grep the existing file:

```bash
grep -nE "^function [A-Z]" /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx
```

Tag each function as:
- **Team-only** (used only inside `TeamSection`): RolePopover, MemberRoleControl, MemberRow, TeamRoster, RoleFilterPill, PendingInvitesList, ChipPill, plus the `Chip` type and `ROLE_META`. → Move to `Members.tsx` (Task 10).
- **Scans-only**: ScanStatus type, `relativeTime`. `relativeTime` may be needed by Audit too; check. → Move `relativeTime` and `ScanStatus` to `_shared.ts`; rest stays in `Scans.tsx` (Task 11).
- **Warehouse-only**: HealthBadge, `ago()` if separate. → Move to `Warehouse.tsx` (Task 13).
- **Tokens-only**: any token-list / token-create JSX → Move to `Tokens.tsx` (Task 12).
- **Matching-only**: threshold sliders → Move to `Matching.tsx` (Task 12 / 13 — clarified below).

Note: only put a helper in `_shared.ts` if **two or more** section files will import it. Otherwise it lives with its consumer.

- [ ] **Step 2: Create `_shared.ts` with the small genuinely-shared helpers**

Create `app/src/routes/settings/_shared.ts`:

```ts
export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
```

(`relativeTime` is used by Scans for "last scan at" and will be used by Audit for "x ago" timestamps. Two consumers → earns `_shared.ts`.)

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/settings/_shared.ts
git commit -m "refactor(app): extract relativeTime shared helper"
```

---

## Task 9: `Members.tsx` — extract Team section

Move `TeamSection()` and every Team-only helper (RolePopover, MemberRoleControl, MemberRow, TeamRoster, RoleFilterPill, PendingInvitesList, ChipPill, ROLE_META, the Chip type) from `Settings.tsx` into `app/src/routes/settings/Members.tsx`.

**Files:**
- Create: `app/src/routes/settings/Members.tsx`

- [ ] **Step 1: Identify the source range**

```bash
grep -nE "^(function |const |interface |type ) (RolePopover|MemberRoleControl|MemberRow|TeamRoster|RoleFilterPill|PendingInvitesList|ChipPill|TeamSection|Chip|ROLE_META|RoleKey|MemberRecord|InviteRecord)" /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx
```

These are all in the `function TeamSection()` block roughly lines 224–1040 of `Settings.tsx`.

- [ ] **Step 2: Create the new file**

Create `app/src/routes/settings/Members.tsx`. Copy the entire `TeamSection`-related block from `Settings.tsx` verbatim, renaming the exported component to `Members`:

```tsx
// Top of file: imports needed by TeamSection — copy from Settings.tsx's import block,
// keeping only what TeamSection uses. Verify with TypeScript after the move.
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { useTenant } from "../../lib/tenant-context";
import { cx } from "../../lib/cx";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { toast } from "../../components/Toast";
import { ConfirmDialog } from "../../components/ConfirmDialog";

// Paste in: RoleKey, ROLE_META, MemberRecord, InviteRecord, Chip,
//           RolePopover, MemberRoleControl, MemberRow, TeamRoster,
//           RoleFilterPill, PendingInvitesList, ChipPill —
// EXACTLY as they appear in Settings.tsx. Do not edit them.

// Replace TeamSection() with the exported Members component:
export function Members() {
  const tenant = useTenant();
  const isAdmin = can(tenant, "settings.members.edit");
  // ... rest of the original TeamSection() body, BUT:
  //   - The original wraps content in <Section title="Team" …>.
  //     Keep that as <SettingsSection title="Team" …>.
  //   - Wrap the body in <ReadOnly enabled={!isAdmin}> so non-admins
  //     see the roster + invites but cannot mutate.
}
```

- [ ] **Step 3: Wrap with ReadOnly**

The structure should be:

```tsx
return (
  <SettingsSection title="Team" hint="…">
    <ReadOnly enabled={!isAdmin}>
      {/* original TeamSection body — chip add, role popovers, member rows, pending invites */}
    </ReadOnly>
  </SettingsSection>
);
```

- [ ] **Step 4: Replace `isAdmin` derivation**

The original `TeamSection` derives `isAdmin` from `currentUser.role === "admin"` (the legacy global role). Replace every reference with `can(tenant, "settings.members.edit")`. There are multiple references inside `MemberRoleControl`, `MemberRow`, `TeamRoster` — pass `isAdmin` as a prop the same way the original does, but derive it from `can()` at the top.

- [ ] **Step 5: Typecheck and confirm no broken imports**

```bash
cd app && bun run typecheck 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 6: Keep Settings.tsx still importing `TeamSection` for now**

Don't delete `TeamSection` from `Settings.tsx` yet. Leave both files in place so existing tests stay green. The `Settings.tsx` deletion is Task 17.

- [ ] **Step 7: Commit**

```bash
git add app/src/routes/settings/Members.tsx
git commit -m "refactor(app): extract Members section"
```

---

## Task 10: `Scans.tsx` — extract Scans section

Move `ScansSection()` (lines 82–263 of `Settings.tsx`) into `app/src/routes/settings/Scans.tsx`. Add role gating via `ReadOnly enabled={!can(tenant, "settings.scans.edit")}`.

**Files:**
- Create: `app/src/routes/settings/Scans.tsx`

- [ ] **Step 1: Create the new file**

Create `app/src/routes/settings/Scans.tsx`:

```tsx
import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";
import { useTenant } from "../../lib/tenant-context";
import { usePreferences, setPreferences, scanSources } from "../../store";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { relativeTime } from "./_shared";

interface ScanStatus {
  lastScanAt: string | null;
  sourceCount: number;
  unmappedCount: number;
  lastAutoPublishAt?: string | null;
  lastAutoPublishDetail?: string | null;
}

export function Scans() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.scans.edit");
  // ... paste the entire body of the original ScansSection() function, EXCEPT:
  // 1. Replace the outer <Section title="Scans" …> with <SettingsSection title="Scans" …>.
  // 2. Wrap the body inside SettingsSection with <ReadOnly enabled={!canEdit}>.
  // 3. relativeTime is now imported from _shared.

  return (
    <SettingsSection title="Scans" hint="…">
      <ReadOnly enabled={!canEdit}>
        {/* original ScansSection body */}
      </ReadOnly>
    </SettingsSection>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/Scans.tsx
git commit -m "refactor(app): extract Scans section"
```

---

## Task 11: `Tokens.tsx` — extract API tokens section

The token UI lives roughly at lines 1321–1473 of `Settings.tsx` (the second top-level `<Section>` block). Extract into `app/src/routes/settings/Tokens.tsx` with `settings.tokens.edit` gating.

**Files:**
- Create: `app/src/routes/settings/Tokens.tsx`

- [ ] **Step 1: Find the source range**

```bash
sed -n '1280,1330p' /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx
```

Identify the wrapping function (it may be inlined inside `Settings`'s JSX rather than a named `TokensSection`). If inlined, extract the inline JSX + its hooks + handlers (`listApiTokens`, `createApiToken`, `revokeApiToken`, copy-to-clipboard) into a new `Tokens()` component.

- [ ] **Step 2: Create the new file**

Create `app/src/routes/settings/Tokens.tsx`:

```tsx
import { useState, useEffect } from "react";
import { Button } from "../../components/Button";
import {
  listApiTokens,
  createApiToken,
  revokeApiToken,
  type ApiToken,
  type CreatedApiToken,
} from "../../store";
import { useTenant } from "../../lib/tenant-context";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";
import { toast } from "../../components/Toast";

export function Tokens() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.tokens.edit");

  // Paste the token-related hooks (tokens list, createdToken, copy handler,
  // revoke handler) from Settings.tsx verbatim.

  return (
    <SettingsSection title="API tokens" hint="…">
      <ReadOnly enabled={!canEdit}>
        {/* token list + create form JSX from the original */}
      </ReadOnly>
    </SettingsSection>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/settings/Tokens.tsx
git commit -m "refactor(app): extract Tokens section"
```

---

## Task 12: `Matching.tsx` — extract matching defaults section

The matching defaults section is the final `<Section>` in `Settings.tsx` (around lines 1658+). Extract into `app/src/routes/settings/Matching.tsx` with `settings.matching.edit` gating.

**Files:**
- Create: `app/src/routes/settings/Matching.tsx`

- [ ] **Step 1: Find the source range**

```bash
sed -n '1650,1683p' /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx
```

- [ ] **Step 2: Create the new file**

Create `app/src/routes/settings/Matching.tsx`:

```tsx
import { ThresholdRange } from "../../components/ThresholdRange";
import { usePreferences, setPreferences } from "../../store";
import { useTenant } from "../../lib/tenant-context";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { can } from "../../lib/permissions";

export function Matching() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.matching.edit");
  const prefs = usePreferences();

  return (
    <SettingsSection title="Matching defaults" hint="…">
      <ReadOnly enabled={!canEdit}>
        {/* paste the ThresholdRange controls + their handlers from Settings.tsx */}
      </ReadOnly>
    </SettingsSection>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/settings/Matching.tsx
git commit -m "refactor(app): extract Matching section"
```

---

## Task 13: `Warehouse.tsx` — extract Workspace/Data flow section

The "Workspace info / Data flow" section (around lines 1542–1655 of `Settings.tsx`) plus its `HealthBadge` helper. Extract into `app/src/routes/settings/Warehouse.tsx`. Read-only for every role in Phase 1 — no `ReadOnly` wrapper needed because there are no editable controls here (it's a display).

**Files:**
- Create: `app/src/routes/settings/Warehouse.tsx`

- [ ] **Step 1: Find the source range**

```bash
sed -n '1470,1490p' /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx
sed -n '1540,1660p' /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx
```

- [ ] **Step 2: Create the new file**

Create `app/src/routes/settings/Warehouse.tsx`:

```tsx
import { useMemo } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import {
  useWorkspaceInfo,
  useDimensions,
  useAudit,
  useConnectionHealth,
  refreshConnectionHealth,
  type ConnectionHealth,
} from "../../store";
import { warehouseSyncStatusByDim } from "../dashboard-helpers";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { relativeTime } from "./_shared";

function HealthBadge({ state }: { state?: ConnectionHealth["warehouse"] }) {
  // paste the HealthBadge implementation from Settings.tsx verbatim
}

export function Warehouse() {
  // paste the body of the workspace/data-flow JSX from Settings.tsx,
  // wrapped in <SettingsSection title="Workspace" hint="…">.
}
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/settings/Warehouse.tsx
git commit -m "refactor(app): extract Warehouse section"
```

---

## Task 14: `Appearance.tsx` — extract Appearance section

The Appearance section (around lines 1520–1540 of `Settings.tsx`) hosts the theme toggle (implicit — driven from the AppShell top bar) and the engineer-mode switch. Extract into `app/src/routes/settings/Appearance.tsx`. Editable by everyone (`settings.appearance.edit` returns true for all roles).

**Files:**
- Create: `app/src/routes/settings/Appearance.tsx`

- [ ] **Step 1: Create the new file**

Create `app/src/routes/settings/Appearance.tsx`:

```tsx
import { FormField } from "../../components/FormField";
import { useEngineerMode } from "../../lib/engineer-mode";
import { SettingsSection } from "../../components/settings/SettingsSection";

export function Appearance() {
  const { engineer, setEngineer } = useEngineerMode();

  return (
    <SettingsSection title="Appearance" hint="Theme follows the toggle in the top bar.">
      <FormField label="Engineer details">
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={engineer}
            aria-label="Engineer details"
            onClick={() => setEngineer(!engineer)}
            className={
              engineer
                ? "h-5 w-9 rounded-full bg-accent transition-colors"
                : "h-5 w-9 rounded-full bg-line-2 transition-colors"
            }
          >
            <span
              className={
                engineer
                  ? "block h-4 w-4 translate-x-4 rounded-full bg-white shadow"
                  : "block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow"
              }
            />
          </button>
          <span className="text-sm text-ink-2">
            Show warehouse table names, SQL, and join warnings
          </span>
        </div>
      </FormField>
    </SettingsSection>
  );
}
```

(Confirm the exact toggle JSX against the source. If different, copy verbatim.)

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/Appearance.tsx
git commit -m "refactor(app): extract Appearance section"
```

---

## Task 15: `General.tsx`, `Audit.tsx`, `Danger.tsx` — new section stubs/lives

Three new section files. `General` shows workspace label + slug + created_at as read-only display. `Audit` reads existing `useAudit()` and renders a simple timeline. `Danger` is an empty placeholder.

**Files:**
- Create: `app/src/routes/settings/General.tsx`
- Create: `app/src/routes/settings/Audit.tsx`
- Create: `app/src/routes/settings/Danger.tsx`

- [ ] **Step 1: `General.tsx`**

Create `app/src/routes/settings/General.tsx`:

```tsx
import { useWorkspaceInfo } from "../../store";
import { useTenant } from "../../lib/tenant-context";
import { SettingsSection } from "../../components/settings/SettingsSection";

export function General() {
  const tenant = useTenant();
  const info = useWorkspaceInfo();

  return (
    <SettingsSection title="General" hint="Workspace identity. Slug is immutable.">
      <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-3 text-sm">
        <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-3 pt-0.5">
          Label
        </dt>
        <dd className="text-ink">{tenant.label}</dd>

        <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-3 pt-0.5">
          Slug
        </dt>
        <dd>
          <code className="font-mono text-accent">{tenant.slug}</code>
        </dd>

        {info?.createdAt && (
          <>
            <dt className="font-mono text-[11px] uppercase tracking-widest text-ink-3 pt-0.5">
              Created
            </dt>
            <dd className="text-ink-2">{new Date(info.createdAt).toLocaleString()}</dd>
          </>
        )}
      </dl>
      <p className="mt-4 text-xs text-ink-3">
        Renaming the workspace label is coming in a follow-up release.
      </p>
    </SettingsSection>
  );
}
```

(If `useWorkspaceInfo()` doesn't expose `createdAt`, drop that block. The `tenant.label` and `tenant.slug` are always available.)

- [ ] **Step 2: `Audit.tsx`**

Create `app/src/routes/settings/Audit.tsx`:

```tsx
import { useAudit } from "../../store";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { relativeTime } from "./_shared";

export function Audit() {
  const audit = useAudit();

  return (
    <SettingsSection
      title="Audit log"
      hint="Workspace activity. Newest first. Read-only for every role."
    >
      {audit.length === 0 ? (
        <p className="text-sm text-ink-3">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {audit.slice(0, 100).map((row) => (
            <li key={row.id} className="py-2.5 grid grid-cols-[180px_140px_1fr] gap-3 items-baseline text-sm">
              <span className="font-mono text-xs text-ink-3 tabular-nums">
                {relativeTime(row.at)}
              </span>
              <code className="font-mono text-xs text-accent truncate">{row.action}</code>
              <span className="text-ink-2 truncate">{row.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}
```

(Verify field names against `useAudit()`'s row shape — adjust `row.id`, `row.at`, `row.action`, `row.detail` to match.)

- [ ] **Step 3: `Danger.tsx`**

Create `app/src/routes/settings/Danger.tsx`:

```tsx
import { SettingsSection } from "../../components/settings/SettingsSection";

export function Danger() {
  return (
    <SettingsSection
      title="Danger zone"
      hint="Workspace destruction lives here. Leave & delete actions ship in the next release."
    >
      <p className="text-sm text-ink-3">No actions available yet.</p>
    </SettingsSection>
  );
}
```

- [ ] **Step 4: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/settings/General.tsx app/src/routes/settings/Audit.tsx app/src/routes/settings/Danger.tsx
git commit -m "feat(app): General/Audit/Danger section stubs"
```

---

## Task 16: `SettingsLayout` — host the sidebar + outlet

The layout component mounted at `/app/:slug/settings`. Wraps `SettingsShell` with the workspace sidebar and an `<Outlet />` for child routes.

**Files:**
- Create: `app/src/components/settings/SettingsLayout.tsx`

- [ ] **Step 1: Implement `SettingsLayout`**

Create `app/src/components/settings/SettingsLayout.tsx`:

```tsx
import { Outlet } from "react-router-dom";
import { SettingsShell } from "./SettingsShell";
import { SettingsSidebar } from "./SettingsSidebar";
import { PageHeader } from "../PageHeader";

export function SettingsLayout() {
  return (
    <>
      <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8 md:pb-0">
        <PageHeader kicker="Workspace" title="Settings" lede="Changes are saved as you make them." />
      </div>
      <SettingsShell sidebar={<SettingsSidebar />}>
        <Outlet />
      </SettingsShell>
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/settings/SettingsLayout.tsx
git commit -m "feat(app): SettingsLayout — sidebar + outlet"
```

---

## Task 17: Route table wiring + delete `Settings.tsx`

Restructure `main.tsx` to mount `SettingsLayout` with nested child routes, and delete the now-orphaned `Settings.tsx`.

**Files:**
- Modify: `app/src/main.tsx`
- Modify: `app/src/components/AppShell.tsx` (verify Settings nav link still works)
- Delete: `app/src/routes/Settings.tsx`
- Test: `app/test/settings-redirect.test.tsx`

- [ ] **Step 1: Write the failing redirect test**

Create `app/test/settings-redirect.test.tsx`:

```tsx
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import { SettingsLayout } from "../src/components/settings/SettingsLayout";

// Stub the child routes so we can detect which one rendered
function Stub({ name }: { name: string }) {
  return <div data-testid="active">{name}</div>;
}

function value(role: "viewer" | "editor" | "admin"): TenantContextValue {
  return { id: "t1", slug: "acme", label: "Acme", role, isSuperAdmin: false };
}

vi.mock("../src/store", async (orig) => {
  const a = await orig<typeof import("../src/store")>();
  return {
    ...a,
    useWorkspaceInfo: () => ({ adapter: "duckdb", writable: false }),
    useDimensions: () => [],
    useAudit: () => [],
    useConnectionHealth: () => undefined,
  };
});

describe("Settings redirect", () => {
  test("/settings → /settings/general for admin", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/settings"]}>
        <TenantProvider value={value("admin")}>
          <Routes>
            <Route path="/app/:slug/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<Stub name="general" />} />
            </Route>
          </Routes>
        </TenantProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("active").textContent).toBe("general");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && bun run test test/settings-redirect.test.tsx 2>&1 | tail -10
```

Expected: failure (route table not yet wired in main.tsx, but this test mounts its own — should pass if SettingsLayout imports correctly; if it fails it's because SettingsLayout imports useTenant which the harness doesn't supply — fix by ensuring TenantProvider wraps the test).

- [ ] **Step 3: Update `main.tsx` route table**

Open `app/src/main.tsx` and find the existing `<Route path="settings" element={<Settings />} />` line. Replace with:

```tsx
<Route path="settings" element={<SettingsLayout />}>
  <Route index element={<Navigate to="general" replace />} />
  <Route path="general" element={<General />} />
  <Route path="members" element={<Members />} />
  <Route path="tokens" element={<Tokens />} />
  <Route path="scans" element={<Scans />} />
  <Route path="matching" element={<Matching />} />
  <Route path="warehouse" element={<Warehouse />} />
  <Route path="appearance" element={<Appearance />} />
  <Route path="audit" element={<SettingsAudit />} />
  <Route path="danger" element={<Danger />} />
</Route>
```

Add the imports:

```tsx
import { SettingsLayout } from "./components/settings/SettingsLayout";
import { General } from "./routes/settings/General";
import { Members } from "./routes/settings/Members";
import { Tokens } from "./routes/settings/Tokens";
import { Scans } from "./routes/settings/Scans";
import { Matching } from "./routes/settings/Matching";
import { Warehouse } from "./routes/settings/Warehouse";
import { Appearance } from "./routes/settings/Appearance";
import { Audit as SettingsAudit } from "./routes/settings/Audit";
import { Danger } from "./routes/settings/Danger";
```

Remove the existing `import { Settings } from "./routes/Settings";` line and `Navigate` import if not already present.

- [ ] **Step 4: Verify the Settings nav item in AppShell still resolves**

Open `app/src/components/AppShell.tsx` line ~315. The nav item is:

```tsx
{ to: navLinks.settings, label: "Settings", Icon: IconSettings },
```

`navLinks.settings` is `/app/${slug}/settings` (per `use-tenant-navigate.ts` line 28). The new route table redirects that to `/general` via the index route. No AppShell change needed — verify by reading the file but don't edit.

- [ ] **Step 5: Delete `Settings.tsx`**

```bash
rm /Users/fhagelund/Documents/GitHub/zugzug/app/src/routes/Settings.tsx
```

- [ ] **Step 6: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -10
```

Expected: 0 errors. If `Settings` is referenced somewhere besides `main.tsx`, fix those callers (likely none — search to confirm):

```bash
grep -rn "from.*routes/Settings\|import.*Settings\b" app/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: empty.

- [ ] **Step 7: Lint**

```bash
cd app && bun run lint 2>&1 | tail -3
```

Expected: 0 errors.

- [ ] **Step 8: Run the redirect test + the existing api-tokens-settings test**

```bash
cd app && bun run test test/settings-redirect.test.tsx 2>&1 | tail -5
cd app && bun run test test/api-tokens-settings.test.tsx 2>&1 | tail -10
```

Expected: both pass.

If `api-tokens-settings.test.tsx` fails because it imports from `./routes/Settings`, update its imports to point at `./routes/settings/Tokens` instead. The test should still verify the same behavior.

- [ ] **Step 9: Run the full app suite**

```bash
cd app && bun run test 2>&1 | tail -5
```

Expected: full suite green (existing baseline plus the new tests from this PR).

- [ ] **Step 10: Commit**

```bash
git add app/src/main.tsx app/test/settings-redirect.test.tsx
git rm app/src/routes/Settings.tsx
git commit -m "feat(app): wire /settings/* nested routes; remove monolithic Settings.tsx"
```

---

## Task 18: Browser smoke test

Manual but mandatory — confirms the extraction didn't break anything visually.

**Files:** none.

- [ ] **Step 1: Start the stack**

```bash
cd server && bun run start
# In another terminal:
cd app && bun run dev
```

- [ ] **Step 2: Walk every section as admin**

In the browser, signed in as a workspace admin in tenant `default`:

- [ ] `/app/default/settings` redirects to `/app/default/settings/general`.
- [ ] Sidebar shows: General, Members, Tokens, Scans, Matching, Warehouse, Appearance, Audit, Danger.
- [ ] Click each item — content area updates, sidebar highlights the active item.
- [ ] In Members, invite a fresh email → it appears under "Pending invites" (unchanged behavior).
- [ ] In Tokens, create a token → it appears in the list (unchanged behavior).
- [ ] In Scans, toggle "Auto-publish at threshold" — preference persists (refresh page → still on).
- [ ] In Matching, drag a threshold slider — preference persists.
- [ ] In Warehouse, confirm the connection-health badge + workspace info still render.
- [ ] In Appearance, toggle engineer mode — sidebar table names show/hide.
- [ ] In Audit, confirm the timeline renders.
- [ ] In Danger, the placeholder text renders.

- [ ] **Step 3: Walk every section as a non-admin**

If you have an editor/viewer test account, sign in and confirm:

- [ ] Editor sees Tokens (read-only), can edit Scans + Matching, cannot edit Members.
- [ ] Viewer does NOT see Tokens in the sidebar at all. Sees all other sections with controls disabled.

If no editor/viewer test account exists, skip this step — `permissions.test.ts` covers the matrix.

- [ ] **Step 4: Verify no console errors / 404s**

Open DevTools → Network → confirm zero 4xx/5xx responses. Console → no red errors.

---

## Task 19: Final sweep + PR

- [ ] **Step 1: Lint, typecheck, full test**

```bash
cd app && bun run lint 2>&1 | tail -3
cd app && bun run typecheck 2>&1 | tail -3
cd app && bun run test 2>&1 | tail -5
```

Expected: 0 lint, 0 type, all tests green.

- [ ] **Step 2: Grep for orphan references**

```bash
grep -rn "from.*routes/Settings\b\|from .\\./Settings" app/src/ app/test/ --include="*.ts" --include="*.tsx"
```

Expected: empty.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin mt-pr5a-settings-ia
gh pr create --title "Settings IA PR A — Scaffold + role gating + extraction" --body "$(cat <<'EOF'
## Summary
- New `permissions.ts` (`can()` + `Action` truth table) + `RoleGate` + `ReadOnly` primitives.
- New `SettingsShell` primitive (220px sidebar + content) reused by Account/Admin in later PRs.
- `SettingsLayout` + `SettingsSidebar` mount at `/app/:slug/settings/*` with role-filtered nav.
- Each section extracted to its own file under `app/src/routes/settings/`: General, Members, Tokens, Scans, Matching, Warehouse, Appearance, Audit, Danger.
- 1683-line `Settings.tsx` deleted.

## Spec
`docs/superpowers/specs/2026-06-12-settings-ia-redesign.md`

## What's preserved (no behavior change)
- Team / API tokens / Scans / Matching / Workspace info — same fetches, same UX. Just extracted.
- Existing tests for `api-tokens-settings`, `available-modes`, etc. stay green.

## What's new
- Role-gated visibility: viewers don't see Tokens. Non-admins see disabled controls in Members.
- General + Audit sections (read-only).
- Danger placeholder (real Leave/Delete in PR B).

## Deferred to PR B
- `PATCH /api/auth/me`, `PATCH /api/t/:slug`, `POST /leave`, `DELETE` workspace.
- Account page (`/account/*`).
- Danger zone actions.
- Workspace switcher entries for Settings / Account.

## Test plan
- [ ] `bun run test` in `app/` — all green
- [ ] `bun run typecheck` + `bun run lint` — clean
- [ ] Manual: walk every section in browser as admin; confirm no console errors

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** Every Phase 1 deliverable in the spec maps to a task — permissions (Task 2), RoleGate (Task 3), ReadOnly (Task 4), SettingsShell (Task 5), SettingsSidebar (Task 6), SettingsSection (Task 7), each extracted section (Tasks 9–14), General/Audit/Danger stubs (Task 15), layout + route wiring (Tasks 16–17). PR B and PR C deliverables (Account, Danger actions, Admin console, server endpoints) are explicitly out of scope.
- **Type consistency:** `Action` is defined in Task 2 and consumed in Tasks 3, 6, 9–14. `TenantContextValue` is the existing type from `tenant-context.tsx`. `SettingsSection` props (`title`, `hint`, `children`) stable across Tasks 7 and 9–15.
- **Behavior preservation:** Tasks 9–14 each say "paste the body verbatim" because the goal is structural extraction, not behavioral change. The only added wrappers are `<SettingsSection>` (replacing the in-file `<Section>`) and `<ReadOnly enabled={!canEdit}>` for sections where the existing `isAdmin` check inside the component was an all-or-nothing gate.
- **Test scope:** `permissions.test.ts` covers the role matrix exhaustively. `settings-sidebar.test.tsx` covers role-filtered nav. `read-only.test.tsx` covers the disable wrapper. `settings-redirect.test.tsx` covers the `/settings` → `/settings/general` redirect. Existing tests for token/scan/team behavior continue to validate that extraction didn't break anything — they're the regression net.
- **Risk:** the verbatim-paste of `TeamSection`'s ~800 lines into `Members.tsx` is the largest extraction. Mitigation: do it in one commit, run `api-tokens-settings.test.tsx` and any team-related test, confirm green before moving on. If anything breaks, the diff is contained to one file.
