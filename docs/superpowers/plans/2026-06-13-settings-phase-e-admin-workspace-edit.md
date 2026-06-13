# Settings — Phase E: Admin → Workspace edit + columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin → Workspaces becomes a real management surface. Super-admin can rename existing workspaces inline. Each row shows member count and last-activity. The list reflects mutations without reload.

**Architecture:** New endpoint `PATCH /api/admin/tenants/:id` for label edits. Extended `GET /api/admin/tenants` shape returns `memberCount` and `lastActivityAt`. UI: inline-editable label cell, two new columns, hooks into the existing Phase B `invalidate.tenantList()`.

**Tech Stack:** TypeScript, Bun, postgres.js, React.

**Spec reference:** Section 6.9 of `docs/superpowers/specs/2026-06-13-settings-functionality-completeness-design.md`.

**Depends on:** Phase A (super-admin gate), Phase B (invalidate.tenantList).

---

## File Structure

**Modified:**
- `server/src/tenant.ts` — `updateTenantLabelAdmin(id, label)` (or reuse existing)
- `server/src/admin.ts` — extend `listTenants()` (or wherever the admin list query lives) to compute `memberCount`, `lastActivityAt`
- `server/src/server.ts` — `PATCH /api/admin/tenants/:id` route
- `app/src/routes/admin/Workspaces.tsx` — inline-editable label cell + two new columns

---

## Task 1: Failing test for admin tenant label update

**Files:**
- Extend: `server/src/tenant.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { updateTenantLabelById } from "./tenant.ts";

describe("updateTenantLabelById", () => {
  it("rejects empty label", async () => {
    await expect(updateTenantLabelById("any", "")).rejects.toThrow(/empty/i);
  });
  it("rejects whitespace-only label", async () => {
    await expect(updateTenantLabelById("any", "   ")).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && bun test src/tenant.test.ts`
Expected: FAIL.

---

## Task 2: Implement `updateTenantLabelById`

**Files:**
- Modify: `server/src/tenant.ts`

- [ ] **Step 1: Implement**

```ts
export async function updateTenantLabelById(id: string, label: string): Promise<void> {
  const l = label.trim();
  if (!l) throw new AppError("VALIDATION_FAILED", "label cannot be empty", 400);
  await pgRun`UPDATE tenants SET label = ${l} WHERE id = ${id}`;
}
```

(The existing `updateTenantLabel(slug, label)` works by slug; the new variant works by id for the admin path. Reuse if the existing one already accepts id — verify in source.)

- [ ] **Step 2: Run test to verify it passes**

Run: `cd server && bun test src/tenant.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/src/tenant.ts server/src/tenant.test.ts
git commit -m "feat(tenant): updateTenantLabelById for admin path"
```

---

## Task 3: PATCH /api/admin/tenants/:id route

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: Add the route**

Near the existing `POST /api/admin/tenants` (server.ts:236) and `POST /api/admin/tenants/:id/teardown` (server.ts:253):

```ts
if (seg[1] === "admin" && seg[2] === "tenants" && seg.length === 4 && method === "PATCH") {
  if (!sessionUser.isSuperAdmin) return json({ error: "forbidden" }, 403);
  const id = seg[3];
  const body = (await req.json()) as { label?: string };
  if (typeof body.label !== "string") return json({ error: "label required" }, 400);
  await updateTenantLabelById(id, body.label);
  // writeAudit({ tenant_id: id, kind: "admin.tenant.label_update", actor_id: sessionUser.id, metadata: { actor_super_admin: true, new_label: body.label } });
  return json({ ok: true });
}
```

- [ ] **Step 2: Manual smoke test**

```bash
curl -sX PATCH http://localhost:8787/api/admin/tenants/sportsbook \
  -H 'Cookie: session=<super-admin-session>' \
  -H 'content-type: application/json' -d '{"label":"Sportsbook (renamed)"}'
```

Expected: `200 {"ok":true}`. Confirm via `psql` or app.

- [ ] **Step 3: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(admin): PATCH /api/admin/tenants/:id"
```

---

## Task 4: Extend `GET /api/admin/tenants` shape

**Files:**
- Modify: the function in `server/src/tenant.ts` that backs `GET /api/admin/tenants` (likely `listTenantsForAdmin` or similar)

- [ ] **Step 1: Extend the SQL**

Add subqueries:

```sql
SELECT
  t.id, t.slug, t.label, t.warehouse_id, t.created_at,
  (SELECT count(*) FROM tenant_member tm WHERE tm.tenant_id = t.id) AS member_count,
  (SELECT max(created_at) FROM audit_log a WHERE a.tenant_id = t.id) AS last_activity_at
FROM tenants t
ORDER BY t.created_at;
```

(Adjust to the actual schema and audit table name.)

- [ ] **Step 2: Update return type**

```ts
export interface TenantAdminRow extends TenantRecord {
  member_count: number;
  last_activity_at: Date | null;
}
```

- [ ] **Step 3: Run typecheck**

Run: `cd server && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/tenant.ts
git commit -m "feat(admin): tenants list includes member_count + last_activity_at"
```

---

## Task 5: Workspaces UI — inline label edit + two new columns

**Files:**
- Modify: `app/src/routes/admin/Workspaces.tsx`

- [ ] **Step 1: Add columns**

In the table header, add `Members`, `Last activity`. In the row renderer:

```tsx
<td className="tabular-nums">{row.member_count}</td>
<td className="text-zinc-500">{row.last_activity_at ? timeAgo(row.last_activity_at) : "—"}</td>
```

Use the project's existing `timeAgo` helper (`grep -rn 'timeAgo\|formatRelative' app/src/lib`); if absent, inline a 5-line implementation.

- [ ] **Step 2: Inline editable label cell**

Replace the static label cell with an input-on-click pattern:

```tsx
const [editing, setEditing] = useState<string | null>(null);
const [draft, setDraft] = useState("");

// in the label cell:
{editing === row.id ? (
  <input
    autoFocus
    value={draft}
    onChange={(e) => setDraft(e.target.value)}
    onBlur={async () => {
      if (draft.trim() && draft !== row.label) {
        await fetch(`/api/admin/tenants/${row.id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: draft }),
        });
        await invalidate.tenantList();
        await invalidate.memberships(); // for switcher
      }
      setEditing(null);
    }}
    onKeyDown={(e) => { if (e.key === "Escape") setEditing(null); }}
    className="w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800"
  />
) : (
  <button onClick={() => { setDraft(row.label); setEditing(row.id); }} className="text-left">
    {row.label}
  </button>
)}
```

- [ ] **Step 3: Manual verify**

Click a label in Admin → Workspaces. Edit. Blur. The cell shows the new label; WorkspaceSwitcher (Phase B Task 8) updates too.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/admin/Workspaces.tsx
git commit -m "feat(admin-workspaces): inline label edit + member/activity columns"
```

---

## Task 6: End-to-end smoke

- [ ] **Step 1: Walk the flow**
- [ ] Admin → Workspaces shows three columns: Label (editable), Members, Last activity.
- [ ] Inline-edit a label → succeeds → WorkspaceSwitcher reflects.
- [ ] Admin → Audit shows the label-update row with `actor_super_admin: true`.

---

## Self-review checklist

- [ ] Spec Section 6.9 → Tasks 1–5.
- [ ] No reload needed for any of the new affordances.
- [ ] `member_count` matches `select count(*) from tenant_member where tenant_id = ?` for at least one row.
