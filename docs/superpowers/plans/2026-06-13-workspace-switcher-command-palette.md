# Workspace Switcher — Command Palette + Workspace Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the workspace dropdown with a searchable command-palette modal and give each workspace a color-backed avatar (initials + color) set at creation and editable in settings.

**Architecture:** `color` is added to the tenant table (nullable, falls back to indigo in application code). The `MembershipLite` and `TenantContextValue` types gain `color`, so the sidebar trigger and the command palette both read it without extra fetches. The `WorkspaceSwitcher` component is fully rewritten to a portal-based modal; a new `WorkspaceColorPicker` component is shared between the create form and settings.

**Tech Stack:** Bun + Drizzle (server), React 18 + Tailwind v4 (app), vitest (app tests), bun:test (server tests).

---

## File map

| File | Action |
|------|--------|
| `server/drizzle/schema.ts` | Add `color varchar` to tenant table |
| `server/drizzle/migrations/` | Generated migration (do not hand-edit) |
| `server/src/tenant.ts` | Add `WORKSPACE_COLORS`, `updateTenantColor`, wire color through SELECT / INSERT |
| `server/src/server.ts` | Accept `color` in POST /tenants, PATCH /admin/tenants/:id, PATCH /t/:slug; include in memberships response |
| `server/src/tenant.test.ts` | Tests for color validation |
| `app/src/lib/workspace-colors.ts` | New — `WORKSPACE_COLORS`, `workspaceInitials`, `workspaceColor` helpers |
| `app/src/store.ts` | `MembershipLite` gains `color: string \| null` |
| `app/src/components/TenantLayout.tsx` | `Membership` gains `color`; `TenantContextValue` gains `color` |
| `app/src/lib/tenant-context.tsx` | `TenantContextValue` gains `color: string \| null` |
| `app/src/components/WorkspaceColorPicker.tsx` | New shared swatch picker |
| `app/src/components/WorkspaceSwitcher.tsx` | Full rewrite → command palette modal with avatar trigger |
| `app/src/routes/admin/Workspaces.tsx` | Create form gains `WorkspaceColorPicker`; list rows show colored dot |
| `app/src/routes/settings/General.tsx` | New "Workspace color" settings section |

---

## Task 1: DB schema — add `color` column

**Files:**
- Modify: `server/drizzle/schema.ts`

- [ ] **Step 1: Add `color` to the tenant table definition**

In `server/drizzle/schema.ts`, find the `tenant` table (around line 274) and add the `color` field:

```ts
export const tenant = app.table(
  "tenant",
  {
    id:           varchar("id").primaryKey(),
    slug:         varchar("slug").notNull(),
    label:        varchar("label").notNull(),
    color:        varchar("color"),           // ← add this line
    warehouse_id: varchar("warehouse_id").notNull(),
    created_at:   timestamp("created_at").notNull(),
    deleted_at:   timestamp("deleted_at"),
  },
  // ... constraints unchanged
```

- [ ] **Step 2: Generate the migration**

```bash
cd server && bun run db:generate
```

Expected: a new file in `server/drizzle/migrations/` containing `ALTER TABLE "zugzug_app"."tenant" ADD COLUMN "color" varchar;`

- [ ] **Step 3: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/drizzle/schema.ts server/drizzle/migrations/
git commit -m "feat(db): add color column to tenant table"
```

---

## Task 2: Server — `WORKSPACE_COLORS`, `updateTenantColor`, wire through tenant.ts

**Files:**
- Modify: `server/src/tenant.ts`
- Modify: `server/src/tenant.test.ts`

- [ ] **Step 1: Write failing tests for color validation**

Append to `server/src/tenant.test.ts`:

```ts
import { WORKSPACE_COLORS, updateTenantColor } from "./tenant.ts";

describe("WORKSPACE_COLORS", () => {
  it("has 10 entries", () => {
    expect(WORKSPACE_COLORS).toHaveLength(10);
  });
  it("includes indigo as first entry", () => {
    expect(WORKSPACE_COLORS[0]).toBe("#6366f1");
  });
});

describe("updateTenantColor", () => {
  it("rejects an invalid hex", async () => {
    await expect(updateTenantColor("any", "#000000")).rejects.toThrow(/invalid color/i);
  });
  it("rejects empty string", async () => {
    await expect(updateTenantColor("any", "")).rejects.toThrow(/invalid color/i);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd server && bun test src/tenant.test.ts
```

Expected: FAIL — `WORKSPACE_COLORS` and `updateTenantColor` not exported.

- [ ] **Step 3: Add `WORKSPACE_COLORS` constant and `updateTenantColor` to `tenant.ts`**

Near the top of `server/src/tenant.ts` (after imports), add:

```ts
export const WORKSPACE_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
  "#f59e0b", "#10b981", "#14b8a6", "#3b82f6", "#64748b",
] as const;

function assertValidColor(color: string): void {
  if (!(WORKSPACE_COLORS as readonly string[]).includes(color)) {
    throw new AppError("VALIDATION_FAILED", `invalid color '${color}'`, 400);
  }
}
```

Then add `updateTenantColor` near `updateTenantLabel`:

```ts
export async function updateTenantColor(tenantId: string, color: string): Promise<void> {
  assertValidColor(color);
  await pgRun(`UPDATE "zugzug_app"."tenant" SET color = $1 WHERE id = $2`, [color, tenantId]);
}
```

- [ ] **Step 4: Add `color` to `TenantRecord` and all SELECT queries**

Find the `TenantRecord` interface (around line 14) and add `color`:

```ts
export interface TenantRecord {
  id: string;
  slug: string;
  label: string;
  color: string | null;
  warehouse_id: string;
  created_at: Date;
}
```

Then update every SQL string that selects from `tenant` to include `color`. There are four:

In `listTenants` (around line 113):
```ts
`SELECT id, slug, label, color, warehouse_id, created_at
   FROM "zugzug_app"."tenant"
  WHERE deleted_at IS NULL
  ORDER BY id`
```

In `listTenantsForAdmin` (around line 127):
```ts
`SELECT t.id, t.slug, t.label, t.color, t.warehouse_id, t.created_at, ...`
```

In `tenantBySlug` (around line 145):
```ts
`SELECT id, slug, label, color, warehouse_id, created_at
   FROM "zugzug_app"."tenant"
  WHERE slug = $1 AND deleted_at IS NULL`
```

In `listMembershipsForUser` (around line 163):
```ts
`SELECT t.id AS tid, t.slug, t.label, t.color, t.warehouse_id, t.created_at, tm.role
   FROM "zugzug_app"."tenant_member" tm
   JOIN "zugzug_app"."tenant" t ON t.id = tm.tenant_id
  WHERE tm.user_id = $1 AND t.deleted_at IS NULL
  ORDER BY t.label`
```

Also update the mapping in `listMembershipsForUser` return:
```ts
rows.map((r) => ({
  tenant: {
    id: r.tid,
    slug: r.slug,
    label: r.label,
    color: r.color,
    warehouse_id: r.warehouse_id,
    created_at: r.created_at,
  },
  role: r.role,
}))
```

(The raw query result needs `color` in the row type too — add `color: string | null` to the inline type in `pgAll<{...}>`.)

- [ ] **Step 5: Wire `color` into `provisionTenant`**

In `provisionTenant`, add `color?: string` to opts and validate + insert it:

```ts
export async function provisionTenant(opts: {
  id: string;
  label: string;
  slug?: string;
  warehouseId?: string;
  color?: string;
}): Promise<TenantRecord> {
  const id = opts.id.trim();
  const slug = (opts.slug ?? id).trim();
  const label = opts.label.trim();
  const warehouseId = (opts.warehouseId ?? "default").trim();
  const color = opts.color ?? null;

  // ... existing validations ...

  if (color !== null) assertValidColor(color);

  const row = await pgGet<TenantRecord>(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, color, warehouse_id, created_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT DO NOTHING
     RETURNING id, slug, label, color, warehouse_id, created_at`,
    [id, slug, label, color, warehouseId],
  );
  // ... rest unchanged
```

- [ ] **Step 6: Run tests**

```bash
cd server && bun test src/tenant.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add server/src/tenant.ts server/src/tenant.test.ts
git commit -m "feat(server): add WORKSPACE_COLORS, updateTenantColor, wire color through tenant.ts"
```

---

## Task 3: Server — wire color through server.ts routes

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: Import `updateTenantColor` and `WORKSPACE_COLORS`**

Find the import block from `./tenant.ts` (around line 35) and add the two new exports:

```ts
import {
  provisionTenant,
  listTenants,
  listTenantsForAdmin,
  tenantBySlug,
  memberRole,
  teardownTenant,
  listMembershipsForUser,
  listMembersForTenant,
  listInvitesForTenant,
  createInvite,
  revokeInvite,
  setMemberRole,
  countAdmins,
  removeMember,
  updateTenantLabel,
  updateTenantColor,    // ← add
  updateTenantSlug,
  leaveTenant,
} from "./tenant.ts";
```

- [ ] **Step 2: Accept `color` in `POST /api/admin/tenants`**

Find the POST handler for `/api/admin/tenants` (around line 255). Change the body type and forward color:

```ts
const body = (await req.json()) as {
  id: string;
  label: string;
  slug?: string;
  warehouseId?: string;
  color?: string;
};
const tenant = await provisionTenant({
  id: body.id,
  label: body.label,
  slug: body.slug,
  warehouseId: body.warehouseId,
  color: body.color,
});
return json(tenant, 201);
```

- [ ] **Step 3: Accept `color` in `PATCH /api/admin/tenants/:id`**

Find the PATCH handler for `/api/admin/tenants/:id` (around line 272). Extend it to handle color independently of label:

```ts
if (seg[2] === "tenants" && seg.length === 4 && method === "PATCH") {
  const targetId = decodeURIComponent(seg[3]!);
  const body = (await req.json()) as { label?: string; color?: string };
  try {
    if (typeof body.label === "string") {
      await updateTenantLabel(targetId, body.label);
      await appendAuditAs(
        me,
        "admin.tenant.label_update",
        `renamed workspace ${targetId} to "${body.label.trim()}"`,
        { tenantId: "default", metadata: { actor_super_admin: true } },
      );
    }
    if (typeof body.color === "string") {
      await updateTenantColor(targetId, body.color);
    }
  } catch (e) {
    if (e instanceof AppError) {
      return json({ error: e.code, message: e.message }, e.status);
    }
    throw e;
  }
  return json({ ok: true });
}
```

- [ ] **Step 4: Accept `color` in `PATCH /api/t/:slug`**

Find the PATCH handler for `PATCH /api/t/:slug` (around line 489). Extend it to handle both `label` and `color`:

```ts
if (tenantSlugFromPath !== null && seg.length === 1 && method === "PATCH") {
  const gate = requireAdmin(tenantCtx);
  if (!gate.ok) return json({ error: "forbidden" }, 403);
  const body = (await req.json()) as { label?: string; color?: string };
  if (typeof body.label === "string") {
    await updateTenantLabel(tenantCtx.tenantId, body.label);
    await appendAuditAs(me, "workspace.rename", `renamed workspace to "${body.label}"`, {
      tenantId: tenantCtx.tenantId,
      metadata: { actor_super_admin: gate.elevated },
    });
  }
  if (typeof body.color === "string") {
    await updateTenantColor(tenantCtx.tenantId, body.color);
  }
  return noContent();
}
```

- [ ] **Step 5: Include `color` in `/api/me/memberships` response**

Find the memberships handler (around line 221). The super-admin and normal branches both need `color`:

```ts
if (pathname === "/api/me/memberships" && method === "GET") {
  const memberships = await listMembershipsForUser(sessionUser.id);
  let workspaces: { slug: string; label: string; role: string; color: string | null }[];
  if (sessionUser.isSuperAdmin) {
    const allTenants = await listTenants();
    const memberMap = new Map(memberships.map((m) => [m.tenant.id, m.role]));
    workspaces = allTenants.map((t) => ({
      slug: t.slug,
      label: t.label,
      role: memberMap.get(t.id) ?? "admin",
      color: t.color ?? null,
    }));
  } else {
    workspaces = memberships.map((m) => ({
      slug: m.tenant.slug,
      label: m.tenant.label,
      role: m.role,
      color: m.tenant.color ?? null,
    }));
  }
  return json({ isSuperAdmin: sessionUser.isSuperAdmin, memberships: workspaces });
}
```

- [ ] **Step 6: Typecheck**

```bash
cd server && bun run typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): wire workspace color through all tenant routes and memberships"
```

---

## Task 4: Frontend — workspace-colors utility

**Files:**
- Create: `app/src/lib/workspace-colors.ts`
- Create (test): `app/src/lib/workspace-colors.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/src/lib/workspace-colors.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { workspaceInitials, workspaceColor, WORKSPACE_COLORS } from "./workspace-colors";

describe("workspaceInitials", () => {
  it("takes first letter of first two words", () => {
    expect(workspaceInitials("Acme Corp")).toBe("AC");
  });
  it("uses first two chars for single word", () => {
    expect(workspaceInitials("Acme")).toBe("AC");
  });
  it("uppercases result", () => {
    expect(workspaceInitials("global ops")).toBe("GO");
  });
  it("handles extra whitespace", () => {
    expect(workspaceInitials("  North  America  ")).toBe("NA");
  });
  it("handles single character label", () => {
    expect(workspaceInitials("A")).toBe("A");
  });
});

describe("workspaceColor", () => {
  it("returns the color if it is in the palette", () => {
    expect(workspaceColor("#ef4444")).toBe("#ef4444");
  });
  it("returns indigo default for null", () => {
    expect(workspaceColor(null)).toBe(WORKSPACE_COLORS[0]);
  });
  it("returns indigo default for an unknown hex", () => {
    expect(workspaceColor("#000000")).toBe(WORKSPACE_COLORS[0]);
  });
});

describe("WORKSPACE_COLORS", () => {
  it("has 10 entries", () => {
    expect(WORKSPACE_COLORS).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd app && bun run test -- workspace-colors
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/src/lib/workspace-colors.ts`**

```ts
export const WORKSPACE_COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444", "#f97316",
  "#f59e0b", "#10b981", "#14b8a6", "#3b82f6", "#64748b",
] as const;

export type WorkspaceColor = typeof WORKSPACE_COLORS[number];

/** 2-letter initials from a workspace label. */
export function workspaceInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0]! + words[1][0]!).toUpperCase();
}

/** Resolve a workspace color — falls back to indigo for null or unknown values. */
export function workspaceColor(color: string | null): string {
  if (color && (WORKSPACE_COLORS as readonly string[]).includes(color)) return color;
  return WORKSPACE_COLORS[0];
}
```

- [ ] **Step 4: Run tests**

```bash
cd app && bun run test -- workspace-colors
```

Expected: all PASS.

- [ ] **Step 5: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/workspace-colors.ts app/src/lib/workspace-colors.test.ts
git commit -m "feat(app): add workspace-colors utility (initials, color, palette)"
```

---

## Task 5: Frontend — carry `color` through types and context

**Files:**
- Modify: `app/src/store.ts`
- Modify: `app/src/lib/tenant-context.tsx`
- Modify: `app/src/components/TenantLayout.tsx`

- [ ] **Step 1: Add `color` to `MembershipLite` in `store.ts`**

Find `MembershipLite` (around line 1156) and add `color`:

```ts
export interface MembershipLite {
  slug: string;
  label: string;
  role: "admin" | "editor" | "viewer";
  color: string | null;
}
```

- [ ] **Step 2: Add `color` to `TenantContextValue` in `tenant-context.tsx`**

```ts
export interface TenantContextValue {
  id: string;
  slug: string;
  label: string;
  color: string | null;
  role: "admin" | "editor" | "viewer";
  isSuperAdmin: boolean;
}
```

- [ ] **Step 3: Wire `color` into `TenantLayout.tsx`**

The `Membership` interface (local to TenantLayout) also needs `color`:

```ts
export interface Membership {
  slug: string;
  label: string;
  role: "admin" | "editor" | "viewer";
  color: string | null;
}
```

And the `ctx` object built from `m`:

```ts
const ctx: TenantContextValue = useMemo(
  () => ({
    id: m?.slug ?? tenantSlug ?? "",
    slug: tenantSlug ?? "",
    label: m?.label ?? tenantSlug ?? "",
    color: m?.color ?? null,
    role: m?.role ?? "admin",
    isSuperAdmin,
  }),
  [tenantSlug, m, isSuperAdmin],
);
```

- [ ] **Step 4: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors. TypeScript will surface any consumer of `TenantContextValue` or `MembershipLite` that fails to handle `color` — fix each one by accessing `tenant.color` where needed (the palette modal and settings will do this in later tasks).

- [ ] **Step 5: Commit**

```bash
git add app/src/store.ts app/src/lib/tenant-context.tsx app/src/components/TenantLayout.tsx
git commit -m "feat(app): carry workspace color through MembershipLite, TenantContextValue, TenantLayout"
```

---

## Task 6: `WorkspaceColorPicker` shared component

**Files:**
- Create: `app/src/components/WorkspaceColorPicker.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { WORKSPACE_COLORS, workspaceColor } from "../lib/workspace-colors";

interface Props {
  value: string | null;
  onChange: (hex: string) => void;
  disabled?: boolean;
}

export function WorkspaceColorPicker({ value, onChange, disabled }: Props) {
  const selected = workspaceColor(value);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {WORKSPACE_COLORS.map((hex) => (
        <button
          key={hex}
          type="button"
          onClick={() => !disabled && onChange(hex)}
          disabled={disabled}
          aria-label={hex}
          aria-pressed={hex === selected}
          className="w-[22px] h-[22px] rounded-[5px] transition-transform hover:scale-110 focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: hex,
            boxShadow:
              hex === selected
                ? `0 0 0 2px var(--surface), 0 0 0 4px ${hex}`
                : undefined,
          }}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/components/WorkspaceColorPicker.tsx
git commit -m "feat(app): add WorkspaceColorPicker shared swatch component"
```

---

## Task 7: Rewrite `WorkspaceSwitcher` → command palette modal

**Files:**
- Modify: `app/src/components/WorkspaceSwitcher.tsx`

- [ ] **Step 1: Rewrite the component**

Replace the entire file:

```tsx
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { authFetch } from "../api";
import { useMemberships } from "../store";
import { useTenant } from "../lib/tenant-context";
import { workspaceColor, workspaceInitials } from "../lib/workspace-colors";
import { cx } from "../lib/cx";

function WorkspaceAvatar({ label, color, size }: { label: string; color: string | null; size: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        background: workspaceColor(color),
        borderRadius: 6,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <span style={{ fontSize: size <= 22 ? 9 : 10, fontWeight: 700, color: "#fff", lineHeight: 1 }}>
        {workspaceInitials(label)}
      </span>
    </div>
  );
}

export function WorkspaceSwitcher() {
  const tenant = useTenant();
  const memberships = useMemberships();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const navigate = useNavigate();
  const location = useLocation();
  const searchRef = useRef<HTMLInputElement>(null);

  const others = memberships.filter((m) => m.slug !== tenant.slug);
  const filtered = query
    ? others.filter((m) => m.label.toLowerCase().includes(query.toLowerCase()))
    : others;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setFocusedIdx(-1);
    // Defer so the portal is mounted before we focus
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIdx((i) => Math.min(i + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIdx((i) => Math.max(i - 1, -1));
      } else if (e.key === "Enter" && focusedIdx >= 0 && filtered[focusedIdx]) {
        switchTo(filtered[focusedIdx]!.slug);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, focusedIdx, filtered]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = (slug: string) => {
    setOpen(false);
    if (slug === tenant.slug) return;
    const rest = location.pathname.replace(/^\/app\/[^/]+/, "") || "";
    navigate(`/app/${slug}${rest}`);
  };

  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() => window.location.replace("/login"));

  return (
    <>
      {/* ── Trigger ── */}
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-2 w-full text-left"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <WorkspaceAvatar label={tenant.label} color={tenant.color} size={22} />
        <span className="font-medium truncate flex-1 text-sm">{tenant.label}</span>
        <span aria-hidden className="shrink-0 text-ink-3 text-[10px]">▾</span>
      </button>

      {/* ── Modal ── */}
      {open && createPortal(
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/30" onClick={() => setOpen(false)} />

          {/* Panel */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Switch workspace"
            className="relative w-[360px] rounded-xl border border-line bg-surface shadow-2xl overflow-hidden"
          >
            {/* Search */}
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-line">
              <svg className="h-3.5 w-3.5 text-ink-3 shrink-0" viewBox="0 0 16 16" fill="none">
                <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setFocusedIdx(-1); }}
                placeholder="Switch workspace…"
                className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-3 focus:outline-none"
              />
              <kbd className="font-mono text-[10px] text-ink-3 bg-surface-2 border border-line px-1.5 py-0.5 rounded">
                ESC
              </kbd>
            </div>

            {/* Current workspace */}
            <div className="py-1">
              <div className="px-3.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-3">
                Current
              </div>
              <div className="px-3.5 py-1.5 flex items-center gap-2.5 bg-hover">
                <WorkspaceAvatar label={tenant.label} color={tenant.color} size={26} />
                <span className="flex-1 text-sm font-medium text-ink truncate">{tenant.label}</span>
                <span className="text-[10px] text-ink-3 bg-surface-2 border border-line rounded px-1.5 py-0.5 shrink-0">
                  {tenant.role}
                </span>
              </div>
            </div>

            {/* All workspaces */}
            {filtered.length > 0 && (
              <div className="border-t border-line py-1">
                <div className="px-3.5 py-1 font-mono text-[10px] uppercase tracking-widest text-ink-3">
                  All workspaces
                </div>
                <div className="max-h-[240px] overflow-y-auto">
                  {filtered.map((m, i) => (
                    <button
                      key={m.slug}
                      onClick={() => switchTo(m.slug)}
                      className={cx(
                        "w-full flex items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors",
                        focusedIdx === i ? "bg-hover" : "hover:bg-hover",
                      )}
                    >
                      <WorkspaceAvatar label={m.label} color={m.color} size={26} />
                      <span className="flex-1 text-sm text-ink truncate">{m.label}</span>
                      <span className="text-[10px] text-ink-3 bg-surface-2 border border-line rounded px-1.5 py-0.5 shrink-0">
                        {m.role}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center gap-4 px-3.5 py-2 border-t border-line">
              {tenant.isSuperAdmin && (
                <Link
                  to="/app/admin"
                  onClick={() => setOpen(false)}
                  className="text-[11px] text-ink-3 hover:text-ink transition-colors"
                >
                  Admin console
                </Link>
              )}
              <button
                onClick={() => { setOpen(false); navigate(`/app/${tenant.slug}/account`); }}
                className="text-[11px] text-ink-3 hover:text-ink transition-colors"
              >
                Account
              </button>
              <button
                onClick={signOut}
                className="text-[11px] text-ink-3 hover:text-ink transition-colors ml-auto"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Run app tests**

```bash
cd app && bun run test
```

Expected: all PASS (no tests directly cover WorkspaceSwitcher, but existing tests should not regress).

- [ ] **Step 4: Commit**

```bash
git add app/src/components/WorkspaceSwitcher.tsx
git commit -m "feat(app): rewrite WorkspaceSwitcher as command palette modal with avatar trigger"
```

---

## Task 8: Admin Workspaces — color picker in create form + colored dot in list

**Files:**
- Modify: `app/src/routes/admin/Workspaces.tsx`

- [ ] **Step 1: Add color state and picker to the create form**

At the top of the `Workspaces` component, add color state (after the existing `useState` calls):

```ts
import { WorkspaceColorPicker } from "../../components/WorkspaceColorPicker";
import { WORKSPACE_COLORS } from "../../lib/workspace-colors";

// inside Workspaces():
const [color, setColor] = useState<string>(WORKSPACE_COLORS[0]);
```

Reset color on successful create (alongside the other resets):
```ts
setColor(WORKSPACE_COLORS[0]);
```

Include `color` in the POST body:
```ts
body: JSON.stringify({ slug, label, warehouseId, color }),
```

- [ ] **Step 2: Add the color picker field to the create form UI**

In the create form section (`{showForm && ...}`), add a color row below the existing three-column grid:

```tsx
<div className="mt-4 space-y-1.5">
  <label className="block font-mono text-[10px] uppercase tracking-widest text-ink-3">
    Color
  </label>
  <div className="flex items-center gap-4">
    <WorkspaceColorPicker value={color} onChange={setColor} />
    {/* Live avatar preview */}
    <div className="flex items-center gap-2 px-2 py-1 border border-line bg-surface rounded">
      <div
        style={{ width: 22, height: 22, borderRadius: 5, background: color, flexShrink: 0,
          display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <span style={{ fontSize: 9, fontWeight: 700, color: "#fff" }}>
          {label
            ? (() => {
                const words = label.trim().split(/\s+/).filter(Boolean);
                return words.length === 1
                  ? words[0].slice(0, 2).toUpperCase()
                  : (words[0][0]! + words[1]![0]!).toUpperCase();
              })()
            : "??"}
        </span>
      </div>
      <span className="text-xs text-ink-2 truncate max-w-[140px]">{label || "Preview"}</span>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add `color` to the `Tenant` interface and show colored dot in list**

Update the `Tenant` interface at the top of the file:
```ts
interface Tenant {
  id: string;
  slug: string;
  label: string;
  color: string | null;
  warehouse_id: string;
  member_count?: number;
  last_activity_at?: string | null;
}
```

In the list row, replace the accent bar `<div className="w-0.5 h-6 bg-accent ...">` with a colored dot:

```tsx
{/* workspace color dot */}
<div
  className="w-2 h-2 rounded-full shrink-0"
  style={{ background: t.color ?? WORKSPACE_COLORS[0] }}
/>
```

- [ ] **Step 4: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/admin/Workspaces.tsx
git commit -m "feat(app): add color picker to workspace create form; colored dots in workspace list"
```

---

## Task 9: Settings → General — workspace color row

**Files:**
- Modify: `app/src/routes/settings/General.tsx`

- [ ] **Step 1: Add imports**

At the top of `General.tsx`, add:

```ts
import { WorkspaceColorPicker } from "../../components/WorkspaceColorPicker";
import { invalidate } from "../../store";
```

(`invalidate` may already be imported — check first.)

- [ ] **Step 2: Add the color settings section**

Add a new `<SettingsSection>` block after the existing General section (before the `canChangeSlug` slug section). Place it only when the user can edit settings:

```tsx
{canEdit && (
  <SettingsSection
    title="Workspace color"
    hint="Used as the avatar background in the workspace switcher."
  >
    <FormField label="Color">
      <WorkspaceColorPicker
        value={tenant.color}
        onChange={async (hex) => {
          await apiFetch("", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ color: hex }),
          });
          await invalidate.memberships();
        }}
      />
    </FormField>
  </SettingsSection>
)}
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
cd app && bun run test
cd server && bun test
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/routes/settings/General.tsx
git commit -m "feat(app): add workspace color picker to Settings → General"
```

---

## Self-review checklist

- [x] **Palette constant** — defined in both server (`tenant.ts`) and client (`workspace-colors.ts`), both 10 entries with indigo first
- [x] **DB migration** — Task 1 generates it via `db:generate`, no hand-edit
- [x] **Null fallback** — `workspaceColor(null)` returns indigo; no DB default needed
- [x] **Color validation server-side** — `assertValidColor` used in `provisionTenant`, `updateTenantColor`; both PATCH routes call `updateTenantColor`
- [x] **Color in memberships response** — both super-admin and normal branches include `color`
- [x] **TenantContextValue carries color** — Task 5 threads it through `MembershipLite` → `TenantLayout` ctx → `useTenant()`
- [x] **WorkspaceAvatar initials** — single-word labels use first 2 chars; two-word labels use first char of each word
- [x] **Command palette keyboard** — ↑↓ navigate filtered list, Enter switches, Esc closes
- [x] **Backdrop closes modal** — `onClick={() => setOpen(false)}` on the backdrop div
- [x] **Portal rendering** — `createPortal(…, document.body)` so modal escapes sidebar stacking context
- [x] **Admin console link** — `Link` not `<a>` (SPA navigation, preserves theme)
- [x] **Color in admin create form** — `color` sent in POST body, reset on success
- [x] **Color in settings** — auto-saves on swatch click, then `invalidate.memberships()` to refresh context
- [x] **Admin-only gate on settings color** — wrapped in `{canEdit && ...}` which checks `can(tenant, "settings.general.edit")`
