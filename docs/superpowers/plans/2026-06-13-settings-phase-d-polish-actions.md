# Settings — Phase D: Per-page polish actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the dozen small per-page gaps catalogued in Section 6 of the spec — saved indicators, last-admin guards, scan-progress feedback, filter chips, URL-persisted filters, etc.

**Architecture:** Mostly small, additive UI edits + 1 server endpoint (`PATCH /api/t/:slug/slug` for super-admin slug change). One commit per page. No new architecture.

**Tech Stack:** React, Bun, postgres.js.

**Spec reference:** Section 6 of `docs/superpowers/specs/2026-06-13-settings-functionality-completeness-design.md`.

**Depends on:** Phase A (so super-admin items work) and Phase B (so invalidate() is available).

---

## File Structure

**Modified (one task each):**
- `app/src/routes/account/Profile.tsx` — Saved indicator + Email "(coming soon)" hint
- `app/src/routes/account/Memberships.tsx` — last-admin handling
- `app/src/routes/settings/General.tsx` — slug-change action
- `server/src/server.ts` + `server/src/tenant.ts` — slug-change endpoint
- `app/src/routes/settings/Members.tsx` — disable last-admin demote, refetch pending invites
- `app/src/routes/settings/Matching.tsx` — verify persistence (likely no edit needed)
- `app/src/routes/settings/Warehouse.tsx` — scan progress pill, friendly default-tenant warning
- `app/src/routes/settings/Danger.tsx` — friendlier "cannot delete default"
- `app/src/routes/admin/Users.tsx` — filter chips + better confirm
- `app/src/routes/admin/Audit.tsx` — filter by event type + URL persistence

---

## Task 1: Profile — Saved indicator + Email hint

**Files:**
- Modify: `app/src/routes/account/Profile.tsx`

- [ ] **Step 1: Add Saved indicator next to name field**

Use the status returned by `useAutosave` (it already exposes `idle | saving | saved | error`). Render a small pill:

```tsx
{status === "saving" && <span className="text-xs text-zinc-400">Saving…</span>}
{status === "saved"  && <span className="text-xs text-emerald-500">Saved</span>}
{status === "error"  && <span className="text-xs text-red-500">Failed — retry</span>}
```

- [ ] **Step 2: Email row hint**

Below the email value:

```tsx
<p className="mt-1 text-xs text-zinc-500">Email changes coming soon.</p>
```

- [ ] **Step 3: Manual verify + commit**

```bash
git add app/src/routes/account/Profile.tsx
git commit -m "feat(profile): saved indicator + email change hint"
```

---

## Task 2: Memberships — last-admin handling on Leave

**Files:**
- Modify: `app/src/routes/account/Memberships.tsx`

- [ ] **Step 1: Use ConfirmDialog with phrase = workspace slug**

When the user clicks Leave on a workspace where they're the last admin, the existing server endpoint returns 409 `last_admin`. Surface this inline (not a toast):

```tsx
const [err, setErr] = useState<{ slug: string; msg: string } | null>(null);
async function leave(slug: string) {
  setErr(null);
  const r = await fetch(`/api/t/${slug}/leave`, { method: "POST", credentials: "include" });
  if (r.status === 409) {
    const body = await r.json();
    if (body.code === "last_admin") {
      setErr({ slug, msg: "You're the only admin. Promote another member or delete the workspace first." });
      return;
    }
  }
  if (!r.ok) {
    setErr({ slug, msg: `Failed (${r.status})` });
    return;
  }
  await invalidate.memberships();
}
```

Render `err.msg` next to the row when `err.slug === row.slug`.

- [ ] **Step 2: Commit**

```bash
git add app/src/routes/account/Memberships.tsx
git commit -m "feat(memberships): inline last-admin warning on Leave"
```

---

## Task 3: General — slug-change endpoint (server)

**Files:**
- Modify: `server/src/tenant.ts` — add `updateTenantSlug(currentSlug, newSlug)`
- Modify: `server/src/server.ts` — add `PATCH /api/t/:slug/slug` route

- [ ] **Step 1: Failing test**

Extend `server/src/tenant.test.ts` (create if missing):

```ts
import { describe, it, expect } from "bun:test";
import { updateTenantSlug } from "./tenant.ts";

describe("updateTenantSlug", () => {
  it("validates slug charset", async () => {
    await expect(updateTenantSlug("default", "Bad Slug")).rejects.toThrow(/VALIDATION_FAILED/);
  });
  it("refuses to change default", async () => {
    await expect(updateTenantSlug("default", "anything")).rejects.toThrow(/default/i);
  });
  // happy path requires test DB; document as TODO if not feasible in this harness
});
```

- [ ] **Step 2: Implement**

In `server/src/tenant.ts`:

```ts
export async function updateTenantSlug(currentSlug: string, newSlug: string): Promise<void> {
  const s = newSlug.trim();
  if (currentSlug === "default") {
    throw new AppError("FORBIDDEN", "cannot change slug of the default workspace", 403);
  }
  if (!TENANT_ID_RE.test(s)) {
    throw new AppError("VALIDATION_FAILED", `slug '${s}' must match ${TENANT_ID_RE.source}`, 400);
  }
  const dupe = await pgGet`SELECT 1 FROM tenants WHERE slug = ${s}`;
  if (dupe) throw new AppError("ALREADY_EXISTS", `slug '${s}' is taken`, 409);
  await pgRun`UPDATE tenants SET slug = ${s} WHERE slug = ${currentSlug}`;
}
```

- [ ] **Step 3: Route**

In `server.ts`, near the existing `PATCH /api/t/:slug` rename handler:

```ts
if (seg[1] === "t" && seg[3] === "slug" && method === "PATCH") {
  const gate = requireAdmin(tenantCtx);
  if (!gate.ok) return json({ error: "forbidden" }, 403);
  const body = (await req.json()) as { slug?: string };
  if (typeof body.slug !== "string") return json({ error: "slug required" }, 400);
  await updateTenantSlug(tenantSlugFromPath!, body.slug);
  return json({ ok: true, new_slug: body.slug });
}
```

- [ ] **Step 4: Commit**

```bash
git add server/src/tenant.ts server/src/server.ts server/src/tenant.test.ts 2>/dev/null
git commit -m "feat(tenant): PATCH /api/t/:slug/slug for super-admin slug change"
```

---

## Task 4: General — slug-change UI

**Files:**
- Modify: `app/src/routes/settings/General.tsx`

- [ ] **Step 1: Add a slug-change section, super-admin only**

```tsx
{tenant.isSuperAdmin && tenant.slug !== "default" && (
  <SettingsSection title="URL slug">
    <p className="text-sm text-zinc-500">
      Renaming the slug changes the URL for everyone using this workspace.
    </p>
    {/* input + Save button; on success: navigate to /app/<new>/settings/general and invalidate memberships */}
  </SettingsSection>
)}
```

On save success:

```tsx
await fetch(`/api/t/${tenant.slug}/slug`, { method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: newSlug }) });
await invalidate.memberships();
navigate(`/app/${newSlug}/settings/general`);
```

- [ ] **Step 2: Commit**

```bash
git add app/src/routes/settings/General.tsx
git commit -m "feat(settings): super-admin slug-change UI"
```

---

## Task 5: Members — disable role demote for last admin

**Files:**
- Modify: `app/src/routes/settings/Members.tsx`

- [ ] **Step 1: Compute last-admin flag**

```tsx
const admins = teamUsers.filter((u) => u.role === "admin");
const isLastAdmin = (u: TeamUser) => u.role === "admin" && admins.length <= 1;
```

- [ ] **Step 2: Disable the role dropdown for the last admin**

In the role-cell renderer:

```tsx
<RoleDropdown
  value={u.role}
  disabled={isLastAdmin(u)}
  title={isLastAdmin(u) ? "Cannot demote the only admin" : undefined}
  onChange={...}
/>
```

If the existing component doesn't accept `disabled` / `title`, extend it.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/Members.tsx
git commit -m "feat(members): disable demote for last admin"
```

---

## Task 6: Matching — verify persistence

**Files:**
- Inspect: `app/src/routes/settings/Matching.tsx`

- [ ] **Step 1: Manual audit**

Open each threshold/toggle, save it, reload. If anything fails to persist, file a follow-up issue and fix here. If everything sticks, no commit needed.

---

## Task 7: Warehouse — scan progress pill

**Files:**
- Modify: `app/src/routes/settings/Warehouse.tsx` (Scans section)

- [ ] **Step 1: Subscribe to the existing presence WS scan event**

Locate the realtime client (`grep -rn 'presence\|realtime' app/src/lib`). It already broadcasts scan state. Subscribe in the Scans section:

```tsx
const scanState = usePresence((p) => p.scan); // adapt to actual shape
// near the "Run scan now" button:
{scanState?.running && (
  <span className="ml-2 text-xs text-zinc-500">Scanning… {scanState.progress ?? ""}</span>
)}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/routes/settings/Warehouse.tsx
git commit -m "feat(scans): inline scan-progress pill"
```

---

## Task 8: Danger — friendlier default-tenant warning

**Files:**
- Modify: `app/src/routes/settings/Danger.tsx`

- [ ] **Step 1: Detect the default tenant up front and render disabled state with tooltip**

```tsx
{tenant.slug === "default" ? (
  <button disabled title="The default workspace cannot be deleted." className="opacity-50 ...">
    Delete workspace
  </button>
) : (
  <Button danger onClick={openConfirm}>Delete workspace</Button>
)}
```

Remove any code path that lets the click reach the server and surface a 403 toast.

- [ ] **Step 2: Commit**

```bash
git add app/src/routes/settings/Danger.tsx
git commit -m "fix(danger): pre-disable delete on default workspace"
```

---

## Task 9: Admin → Users filter chips + confirm text

**Files:**
- Modify: `app/src/routes/admin/Users.tsx`

- [ ] **Step 1: Add chips**

State: `const [filter, setFilter] = useState<"all" | "super_admin" | string>("all")`. (`string` for workspace slug filter.)

```tsx
<div className="mb-2 flex gap-1">
  <Chip active={filter === "all"} onClick={() => setFilter("all")}>All</Chip>
  <Chip active={filter === "super_admin"} onClick={() => setFilter("super_admin")}>Super-admins</Chip>
  {/* per-workspace chips iterating memberships, optional */}
</div>
```

Filter rows accordingly.

- [ ] **Step 2: Confirm dialog copy**

```tsx
<ConfirmDialog
  title={isPromoting ? `Grant super-admin to ${u.name}?` : `Revoke super-admin from ${u.name}?`}
  body={`Email: ${u.email}. This grants full system access across every workspace.`}
  onConfirm={...}
/>
```

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/admin/Users.tsx
git commit -m "feat(admin-users): filter chips + clearer confirm copy"
```

---

## Task 10: Admin → Audit — event-type filter + URL persistence

**Files:**
- Modify: `app/src/routes/admin/Audit.tsx`

- [ ] **Step 1: Read URL search params on mount and persist on change**

```tsx
import { useSearchParams } from "react-router-dom";
const [params, setParams] = useSearchParams();
const type = params.get("type") ?? "";
const tenant = params.get("tenant") ?? "";

// to update:
function setType(v: string) {
  const next = new URLSearchParams(params);
  if (v) next.set("type", v); else next.delete("type");
  setParams(next, { replace: true });
}
```

- [ ] **Step 2: Render multi-select chips for the distinct event types in the loaded set**

```tsx
const types = useMemo(() => Array.from(new Set(rows.map((r) => r.kind))).sort(), [rows]);
// render a chip per type; selecting one filters
```

Combine with the Phase A "Super-admin actions" chip.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/admin/Audit.tsx
git commit -m "feat(admin-audit): event-type filter + URL-persistent chips"
```

---

## Task 11: End-to-end smoke

- [ ] **Step 1: Walk each item in Section 6 of the spec** and confirm it works as described.

- [ ] **Step 2: Confirm no regression** in Phase A or Phase B behavior.

---

## Self-review checklist

- [ ] Spec Section 6.1 → Task 1.
- [ ] Spec Section 6.2 → Task 2.
- [ ] Spec Section 6.3 → Tasks 3, 4 (slug change).
- [ ] Spec Section 6.4 → Task 5.
- [ ] Spec Section 6.5 → Task 6.
- [ ] Spec Section 6.6 → Task 7.
- [ ] Spec Section 6.7 → covered in Phase B Task 12 (tokens refetch).
- [ ] Spec Section 6.8 → Task 8.
- [ ] Spec Section 6.10 → Task 9.
- [ ] Spec Section 6.11 → Task 10.
- [ ] Spec Section 6.12 → Phase C.
- [ ] Spec Section 6.9 (Admin → Workspaces) → Phase E (carved out as its own plan).
