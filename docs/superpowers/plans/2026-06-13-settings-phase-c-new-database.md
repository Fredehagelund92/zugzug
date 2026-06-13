# Settings — Phase C: New database flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Super-admins can create a new MotherDuck database from the Admin → Warehouses page. The new database appears in the workspace-creation picker without reload.

**Architecture:** New endpoint `POST /api/admin/warehouses` validates a database name, calls `CREATE DATABASE "<name>"` via the existing writable DuckDB connection, returns the refreshed warehouse list. UI: a "+ New database" button on `routes/admin/Warehouses.tsx` opens a dialog. On 403 (read-only token), surface a clear remediation message inline.

**Tech Stack:** Bun, `@duckdb/node-api`, TypeScript, React. No new dependencies.

**Spec reference:** Section 5 of `docs/superpowers/specs/2026-06-13-settings-functionality-completeness-design.md`.

**Depends on:** Phase A (super-admin elevation) for the gating to make sense; not strictly blocking.

---

## File Structure

**Modified:**
- `server/src/server.ts` — add `POST /api/admin/warehouses` route
- `server/src/admin.ts` — add `createWarehouseDatabase(name)`
- `app/src/routes/admin/Warehouses.tsx` — "+ New database" button + dialog
- `app/src/routes/settings/Warehouse.tsx` — super-admin deep-link footer

**Created:**
- `app/src/routes/admin/CreateDatabaseDialog.tsx` — small focused dialog

---

## Task 1: Failing test for name validation

**Files:**
- Create or extend: `server/src/admin.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/admin.test.ts
import { describe, it, expect } from "bun:test";
import { validateWarehouseName } from "./admin.ts";

describe("validateWarehouseName", () => {
  it("accepts valid names", () => {
    expect(validateWarehouseName("ws_default")).toEqual({ ok: true });
    expect(validateWarehouseName("sportsbook")).toEqual({ ok: true });
    expect(validateWarehouseName("a1b")).toEqual({ ok: true });
  });
  it("rejects names that don't match the charset", () => {
    expect(validateWarehouseName("1leading_digit")).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateWarehouseName("UpperCase")).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateWarehouseName("ab")).toEqual({ ok: false, reason: expect.any(String) }); // too short
    expect(validateWarehouseName("")).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateWarehouseName("has space")).toEqual({ ok: false, reason: expect.any(String) });
    expect(validateWarehouseName("with-hyphen")).toEqual({ ok: false, reason: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && bun test src/admin.test.ts`
Expected: FAIL — `validateWarehouseName` not exported.

---

## Task 2: Implement validation + creation in admin.ts

**Files:**
- Modify: `server/src/admin.ts` (42 lines today; add ~40)

- [ ] **Step 1: Add the validator + creator**

Append to `server/src/admin.ts`:

```ts
import { getWritableDuckDB } from "./warehouse/duckdb/index.ts"; // adapt to actual export
import { AppError } from "./errors.ts";

const NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;

export function validateWarehouseName(
  name: string,
): { ok: true } | { ok: false; reason: string } {
  if (!name) return { ok: false, reason: "name is required" };
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `name must match ${NAME_RE.source} (lowercase, starts with a letter, 3-63 chars)`,
    };
  }
  return { ok: true };
}

/**
 * Runs CREATE DATABASE "<name>" against the configured MotherDuck token.
 * Returns the freshly enumerated warehouse list on success.
 * Throws AppError with status 400 / 403 / 409 for known failure modes.
 */
export async function createWarehouseDatabase(name: string): Promise<string[]> {
  const v = validateWarehouseName(name);
  if (!v.ok) throw new AppError("VALIDATION_FAILED", v.reason, 400);

  const duck = await getWritableDuckDB();
  // Uniqueness check
  const existing = await duck.run(`SELECT database_name FROM duckdb_databases();`);
  const names = existing.rows.map((r: any) => String(r.database_name));
  if (names.includes(name)) {
    throw new AppError("ALREADY_EXISTS", `warehouse "${name}" already exists`, 409);
  }

  try {
    await duck.run(`CREATE DATABASE "${name}"`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/read[- _]?only|permission denied|forbidden/i.test(msg)) {
      throw new AppError(
        "READ_ONLY_TOKEN",
        "Your MotherDuck token has read-only scaling. Update MOTHERDUCK_TOKEN to a write-capable token or create the database manually in MotherDuck and refresh this list.",
        403,
      );
    }
    throw e;
  }

  const after = await duck.run(`SELECT database_name FROM duckdb_databases();`);
  return after.rows.map((r: any) => String(r.database_name));
}
```

(Adapt `getWritableDuckDB()` to the actual export — see `server/src/warehouse/duckdb/writable.ts`. If that file exposes a different name, use it instead.)

- [ ] **Step 2: Run test to verify it passes**

Run: `cd server && bun test src/admin.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `cd server && bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/admin.ts server/src/admin.test.ts
git commit -m "feat(admin): createWarehouseDatabase + name validator"
```

---

## Task 3: Wire the route in server.ts

**Files:**
- Modify: `server/src/server.ts`

- [ ] **Step 1: Locate the existing admin routes block**

Find the existing `GET /api/admin/warehouses` handler (around `server.ts:340`).

- [ ] **Step 2: Add POST handler adjacent to it**

```ts
if (seg[1] === "admin" && seg[2] === "warehouses") {
  if (method === "GET") {
    // existing handler stays
  }
  if (method === "POST") {
    if (!sessionUser.isSuperAdmin) return json({ error: "forbidden" }, 403);
    const body = (await req.json()) as { name?: string };
    if (typeof body.name !== "string") return json({ error: "name required" }, 400);
    try {
      const { createWarehouseDatabase } = await import("./admin.ts");
      const list = await createWarehouseDatabase(body.name.trim());
      // audit
      // writeAudit({ tenant_id: null, kind: "admin.warehouse.create", actor_id: sessionUser.id, metadata: { name: body.name, actor_super_admin: true } });
      return json({ warehouses: list });
    } catch (e) {
      if (e instanceof AppError) return json({ error: e.message, code: e.code }, e.status);
      throw e;
    }
  }
}
```

Use the actual audit writer in the project (locate via `grep -rn 'writeAudit\|audit.*insert' server/src`). If it doesn't accept `tenant_id: null`, use the admin-tenant convention already in use for the existing super-admin audit rows (find via `grep 'admin\.' server/src/server.ts`).

- [ ] **Step 3: Manual smoke test**

```bash
curl -sX POST http://localhost:8787/api/admin/warehouses \
  -H 'Cookie: session=<super-admin-session>' \
  -H 'content-type: application/json' \
  -d '{"name":"zz_test_db"}'
```

Expected:
- On a write-capable token: `200` with `{ "warehouses": [..., "zz_test_db"] }`.
- On a read-only token: `403` with the remediation text.
- On invalid name: `400` with the validator reason.

- [ ] **Step 4: Commit**

```bash
git add server/src/server.ts
git commit -m "feat(server): POST /api/admin/warehouses creates MotherDuck DB"
```

---

## Task 4: CreateDatabaseDialog component

**Files:**
- Create: `app/src/routes/admin/CreateDatabaseDialog.tsx`

- [ ] **Step 1: Implement the dialog**

```tsx
// app/src/routes/admin/CreateDatabaseDialog.tsx
import { useState } from "react";
import { invalidate } from "../../store";

const NAME_RE = /^[a-z][a-z0-9_]{2,62}$/;

export function CreateDatabaseDialog({
  existing,
  onClose,
  onCreated,
}: {
  existing: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const localError =
    !name ? null
    : !NAME_RE.test(name) ? "Lowercase letters, digits, underscore. 3-63 chars. Starts with a letter."
    : existing.includes(name) ? "A database with this name already exists."
    : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (localError) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/warehouses", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        setErr(body.error || `Failed (${r.status})`);
        return;
      }
      await invalidate.warehouses();
      onCreated();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <form onSubmit={submit} className="w-[420px] rounded bg-white p-4 shadow-lg dark:bg-zinc-900">
        <h2 className="mb-2 text-base font-semibold">New database</h2>
        <p className="mb-3 text-sm text-zinc-500">
          Creates a fresh MotherDuck database in your account. It will appear in the workspace picker immediately.
        </p>
        <label className="block text-xs uppercase tracking-wide text-zinc-500">Database name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="acme_prod"
          className="mt-1 w-full rounded border border-zinc-300 px-2 py-1 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-800"
        />
        {(localError || err) && (
          <p className="mt-2 text-sm text-red-600">{localError || err}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="px-3 py-1 text-sm">
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !!localError || !name}
            className="rounded bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
```

(Adapt classNames to the project's existing token system — if there's a shared `<Dialog>` or `<Button>` component, use it. Don't introduce a new modal primitive.)

- [ ] **Step 2: Typecheck**

Run: `cd app && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/admin/CreateDatabaseDialog.tsx
git commit -m "feat(admin): CreateDatabaseDialog component"
```

---

## Task 5: Wire button into Admin → Warehouses

**Files:**
- Modify: `app/src/routes/admin/Warehouses.tsx`

- [ ] **Step 1: Add the button + dialog state**

```tsx
import { useState } from "react";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";
// ...
const [open, setOpen] = useState(false);
// in the page header actions slot (PageHeader.actions per the 06-13 polish spec):
<button onClick={() => setOpen(true)} className="...">+ New database</button>
{open && (
  <CreateDatabaseDialog
    existing={warehouses.map((w) => w.name)}
    onClose={() => setOpen(false)}
    onCreated={() => { /* warehouses refetched via invalidate already */ }}
  />
)}
```

If `<PageHeader>` doesn't yet support an `actions` slot (depends on the polish-spec phase landing first), place the button just below the page title with `className="mb-3"`. The polish spec will absorb it later.

- [ ] **Step 2: Manual verify**

Sign in as super-admin. Visit `/app/admin/warehouses`. Click "+ New database". Submit `zz_smoke_test`. Verify:
- Row appears in the list without reload.
- Visit `/app/admin/workspaces` → "+ Create workspace" → the warehouse picker shows `zz_smoke_test`.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/admin/Warehouses.tsx
git commit -m "feat(admin): + New database button on Warehouses page"
```

---

## Task 6: Super-admin deep-link from workspace Warehouse settings

**Files:**
- Modify: `app/src/routes/settings/Warehouse.tsx`

- [ ] **Step 1: Add a small footer link, super-admin only**

```tsx
import { Link } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
// ...
const t = useTenant();
// at the bottom of the Connection section:
{t.isSuperAdmin && (
  <p className="mt-4 text-sm text-zinc-500">
    Need a fresh database?{" "}
    <Link to="/app/admin/warehouses" className="underline">
      Manage warehouses →
    </Link>
  </p>
)}
```

- [ ] **Step 2: Manual verify**

As super-admin, visit Workspace Settings → Warehouse. Link renders. As regular admin, link is absent.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/settings/Warehouse.tsx
git commit -m "feat(settings): super-admin deep-link to Admin > Warehouses"
```

---

## Task 7: End-to-end smoke + audit verification

- [ ] **Step 1: Reset the test database** (delete any `zz_smoke_test` from MotherDuck if present)

- [ ] **Step 2: Walk the flow**

- [ ] As super-admin, Admin → Warehouses → "+ New database" → `zz_demo` → Create → row appears
- [ ] Admin → Audit → "Super-admin actions" filter (Phase A) → the create-database row is visible with `actor_super_admin: true`
- [ ] Admin → Workspaces → "+ Create workspace" → picker contains `zz_demo`
- [ ] Provision a workspace pointed at `zz_demo` → it works end-to-end

- [ ] **Step 3: Negative test** — submit `ZZ_Bad`, `1leading`, `ab`. Each surfaces the validator message inline, no network call leaks past 400.

- [ ] **Step 4: Read-only token test (skip if not feasible)** — temporarily set a read-only token and submit. Surface the 403 remediation text.

---

## Self-review checklist

- [ ] Spec Section 5.1 → Tasks 1, 2, 3.
- [ ] Spec Section 5.2 → Tasks 4, 5.
- [ ] Spec Section 5.3 → Task 5 (verified via picker).
- [ ] Spec Section 5.4 → Task 6.
- [ ] Spec Section 5.5 → Tasks 1, 7.
