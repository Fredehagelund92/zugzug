# Self-referencing hierarchy (parent pointer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `linked` field target its own table so a record can point at another record as its parent, with write-time rejection of cycles.

**Architecture:** No new field type or schema. Unblock the self-target in `addField`, add a cycle guard to `setFieldValue`'s linked branch (covering inline edits and CSV import), include the current table in the link-target picker, and surface the new `HIERARCHY_CYCLE` error in the grid. Candidate loading already resolves a self-target with no change.

**Tech Stack:** TypeScript, Bun (server tests via `bun test`), React + Vitest (client tests), Postgres (`WITH RECURSIVE`).

## Global Constraints

- User-facing copy: plain words only, active voice; never surface jargon (canonical, raw, master, dimension, etc.). Design spec: `docs/superpowers/specs/2026-07-19-self-referencing-hierarchy-design.md`.
- Server tests need the test Postgres at `localhost:55432` (`npm run test:db:up`, or a running `zugzug-test-pg`).
- Match existing file style; keep changes surgical.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Deliberate behavior (do NOT "fix" later): an unknown linked FK coerces to null; a cyclic self-parent throws `HIERARCHY_CYCLE`.
- Deferred (out of scope, covered by the write-guard): excluding a record from its own parent-picker candidate list (needs row-aware filtering; disproportionate for MVP).

---

### Task 1: Unblock self-target + add the error code

**Files:**
- Modify: `server/src/errors.ts` (`ErrorCode` union)
- Modify: `server/src/repo-canonical.ts:1204` (`addField` self-target guard)
- Create: `server/src/self-link-hierarchy.test.ts`

**Interfaces:**
- Produces: `addField(dimId, label, "linked", undefined, { referencedDimId: dimId }, userId, tenantId)` now returns `{ field }` (was `null`). Error code `"HIERARCHY_CYCLE"` available on the `ErrorCode` union.

- [ ] **Step 1: Write the failing test**

Create `server/src/self-link-hierarchy.test.ts`:

```typescript
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import "../test/setup.ts";
import { pgRun, pgAll } from "./pg.ts";
import {
  addDimension,
  addCanonicalOne,
  addField,
  setFieldValue,
  listFields,
  getDimension,
} from "./repo-canonical.ts";

const T = "test_hierarchy";
const U = "u_test_hierarchy";

beforeAll(async () => {
  await pgRun(
    `INSERT INTO "zugzug_app"."tenant" (id, slug, label, created_at)
     VALUES ($1, $1, 'Hierarchy', now()) ON CONFLICT DO NOTHING`,
    [T],
  );
  await pgRun(
    `INSERT INTO "zugzug_app"."users" (id, name, email, initials, is_super_admin)
     VALUES ($1, 'Hierarchy Tester', 'h@example.test', 'HT', false) ON CONFLICT DO NOTHING`,
    [U],
  );
});

afterAll(async () => {
  const dims = await pgAll<{ dim_table: string; map_table: string }>(
    `SELECT dim_table, map_table FROM "zugzug_app"."dimension" WHERE tenant_id = $1`,
    [T],
  ).catch(() => []);
  for (const d of dims) {
    await pgRun(`DROP TABLE IF EXISTS ${d.dim_table}`).catch(() => {});
    await pgRun(`DROP TABLE IF EXISTS ${d.map_table}`).catch(() => {});
  }
  await pgRun(`DELETE FROM "zugzug_app"."canonical_version" WHERE tenant_id = $1`, [T]).catch(
    () => {},
  );
  await pgRun(`DELETE FROM "zugzug_app"."dimension" WHERE tenant_id = $1`, [T]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."users" WHERE id = $1`, [U]).catch(() => {});
  await pgRun(`DELETE FROM "zugzug_app"."tenant" WHERE id = $1`, [T]).catch(() => {});
});

describe("self-referencing linked field", () => {
  it("allows a linked field to target its own table", async () => {
    const dimId = await addDimension("Regions", [], { keyKind: "slug" }, U, T);
    const added = await addField(
      dimId,
      "Parent",
      "linked",
      undefined,
      { referencedDimId: dimId },
      U,
      T,
    );
    expect(added).not.toBeNull();
    const parent = (await listFields(dimId, T)).find((f) => f.field === "parent");
    expect(parent?.referencedDimId).toBe(dimId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && DATABASE_URL=postgres://zugzug:zugzug@localhost:55432/zugzug_test ATTACH_WAREHOUSE=false MOTHERDUCK_TOKEN=test-stub GOOGLE_CLIENT_ID=test-stub GOOGLE_CLIENT_SECRET=test-stub ZUGZUG_CURSOR_KEY=lhpj7+vHLZDQJXKzZXiC/Qa/m2SNY3ObTBgxn7Awis8= bun test src/self-link-hierarchy.test.ts`
Expected: FAIL — `added` is `null` (self-target still blocked), so `expect(added).not.toBeNull()` fails.

- [ ] **Step 3a: Add the error code**

In `server/src/errors.ts`, extend the `ErrorCode` union:

```typescript
  | "NO_SNAPSHOT"
  | "SECOND_PUBLISHER_REQUIRED"
  | "REQUIRED_FIELDS_EMPTY"
  | "HIERARCHY_CYCLE";
```

- [ ] **Step 3b: Unblock the self-target**

In `server/src/repo-canonical.ts`, inside `addField`'s `if (t === "linked")` block (~line 1204), remove the self-target rejection:

```typescript
  if (t === "linked") {
    if (!opts.referencedDimId) return null;
    const targetMeta = await dimMeta(opts.referencedDimId, tenantId);
    if (!targetMeta) return null;
```

(Delete only the line `if (opts.referencedDimId === dimId) return null;`. Leave the rest of the linked validation — target exists, displayFields exist — unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: (same command as Step 2)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/errors.ts server/src/repo-canonical.ts server/src/self-link-hierarchy.test.ts
git commit -m "feat(fields): allow a linked field to target its own table

Unblocks self-referencing links (parent pointers) and adds the
HIERARCHY_CYCLE error code the cycle guard will use.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Cycle guard in setFieldValue

**Files:**
- Modify: `server/src/repo-canonical.ts:1542` (`setFieldValue` linked branch)
- Test: `server/src/self-link-hierarchy.test.ts` (add cases)

**Interfaces:**
- Consumes: self-link creation + `HIERARCHY_CYCLE` code from Task 1.
- Produces: `setFieldValue` throws `AppError("HIERARCHY_CYCLE", …, 422)` when setting a self-link value would make a record its own parent or its own ancestor's child. Unknown-FK behavior (coerce to null) unchanged for non-self and non-cyclic sets.

- [ ] **Step 1: Write the failing tests**

Append to `server/src/self-link-hierarchy.test.ts`, inside the same `describe`:

```typescript
  it("builds a valid parent chain, rejects cycles and self-parenting", async () => {
    const dimId = await addDimension("Geo", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(dimId, "Europe", "europe", U, T);
    await addCanonicalOne(dimId, "Nordics", "nordics", U, T);
    await addCanonicalOne(dimId, "Denmark", "denmark", U, T);
    await addCanonicalOne(dimId, "France", "france", U, T);
    await addField(dimId, "Parent", "linked", undefined, { referencedDimId: dimId }, U, T);

    // Valid chain: Denmark -> Nordics -> Europe
    await setFieldValue(dimId, "nordics", "parent", "europe", T);
    await setFieldValue(dimId, "denmark", "parent", "nordics", T);
    const chain = await getDimension(dimId, T);
    expect(chain!.canonical.find((c) => c.key === "denmark")!.fields?.parent).toBe("nordics");

    // Cycle: Europe's parent = Denmark would close the loop
    await expect(setFieldValue(dimId, "europe", "parent", "denmark", T)).rejects.toThrow(/loop/i);

    // Self-parent is rejected
    await expect(setFieldValue(dimId, "europe", "parent", "europe", T)).rejects.toThrow(
      /own parent/i,
    );

    // Acyclic re-parent still works: France Europe -> Nordics
    await setFieldValue(dimId, "france", "parent", "europe", T);
    await setFieldValue(dimId, "france", "parent", "nordics", T);
    const after = await getDimension(dimId, T);
    expect(after!.canonical.find((c) => c.key === "france")!.fields?.parent).toBe("nordics");
  });

  it("a cross-table linked field still coerces an unknown key to null", async () => {
    const a = await addDimension("Alpha", [], { keyKind: "slug" }, U, T);
    const b = await addDimension("Beta", [], { keyKind: "slug" }, U, T);
    await addCanonicalOne(a, "One", "one", U, T);
    await addField(a, "BetaLink", "linked", undefined, { referencedDimId: b }, U, T);
    // Unknown FK on a NON-self link: no throw, coerced to null.
    await setFieldValue(a, "one", "betalink", "does_not_exist", T);
    const dim = await getDimension(a, T);
    expect(dim!.canonical.find((c) => c.key === "one")!.fields?.betalink ?? null).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: (same bun command as Task 1 Step 2)
Expected: FAIL — the cycle/self cases don't throw yet (setting a cyclic parent currently just writes the value), so the `rejects.toThrow` assertions fail.

- [ ] **Step 3: Add the cycle guard**

In `server/src/repo-canonical.ts`, replace the `linked` branch of `setFieldValue` (~lines 1542-1554):

```typescript
  } else if (f.type === "linked") {
    let fkValue: string | null = empty ? null : value!.trim();
    if (fkValue !== null && f.referencedDimId) {
      const tm = await dimMeta(f.referencedDimId, tenantId);
      if (tm) {
        const exists = await pgGet(`SELECT 1 FROM ${cq(tm.dimTable)} WHERE ${qid(tm.keyCol)} = $1`, [
          fkValue,
        ]);
        if (!exists) {
          fkValue = null;
        } else if (f.referencedDimId === dimId) {
          // Self-link = a parent pointer. Keep the data a valid tree: reject a
          // record parenting itself, or parenting a record it is already an
          // ancestor of (which would close a loop). Self-links were impossible
          // before this feature, so no pre-existing data can be cyclic and the
          // recursion always terminates.
          if (fkValue === key) {
            throw new AppError("HIERARCHY_CYCLE", "A record can't be its own parent.", 422);
          }
          const cyclic = await pgGet(
            `WITH RECURSIVE anc(p) AS (
               SELECT ${col} FROM ${cq(m.dimTable)} WHERE ${keyc} = $1
               UNION ALL
               SELECT d.${col} FROM ${cq(m.dimTable)} d JOIN anc ON d.${keyc} = anc.p
                WHERE anc.p IS NOT NULL
             )
             SELECT 1 FROM anc WHERE p = $2 LIMIT 1`,
            [fkValue, key],
          );
          if (cyclic) {
            throw new AppError("HIERARCHY_CYCLE", "Setting that parent would create a loop.", 422);
          }
        }
      }
    }
    await pgRun(`UPDATE ${cq(m.dimTable)} SET ${col} = $1 WHERE ${keyc} = $2`, [fkValue, key]);
  } else {
```

(`col`, `keyc`, and `m` are already in scope from the top of `setFieldValue`. `AppError` is already imported in this file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: (same bun command)
Expected: PASS (all cases in the file).

- [ ] **Step 5: Run the full server suite for regressions**

Run: `cd server && npm run test`
Expected: all pass (rerun once if a transient shared-DB failure appears in an unrelated suite).

- [ ] **Step 6: Commit**

```bash
git add server/src/repo-canonical.ts server/src/self-link-hierarchy.test.ts
git commit -m "feat(hierarchy): reject cycles when setting a self-link parent

setFieldValue now guards a self-referencing linked field: a record
cannot be its own parent, nor the child of a record it is already an
ancestor of (WITH RECURSIVE ancestor walk). Throws HIERARCHY_CYCLE.
Unknown-FK behavior on non-self links is unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Client — link picker + cycle-error surface

**Files:**
- Modify: `app/src/components/AddFieldPopover.tsx` (link-target `<select>`)
- Modify: `app/src/components/TablePane.tsx` (cell-edit catch, ~line 1373; imports)
- Test: `app/src/components/AddFieldPopover.test.tsx` (create if absent)

**Interfaces:**
- Consumes: server behavior from Tasks 1-2 (`HIERARCHY_CYCLE` on the wire; `apiInner` already throws `ApiCodeError` with `code`).
- Produces: the link-target picker lists the current table as `"<name> (this table)"`; a cyclic parent edit shows the server's message instead of the generic "try again" toast.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/AddFieldPopover.test.tsx`:

```tsx
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { AddFieldPopover } from "./AddFieldPopover";

afterEach(cleanup);

describe("AddFieldPopover link target", () => {
  it("offers the current table as a link target, marked as self", () => {
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <AddFieldPopover
        anchorRef={{ current: anchor }}
        onClose={() => {}}
        onSubmit={async () => {}}
        allDims={[
          { id: "regions", dimension: "Regions" },
          { id: "countries", dimension: "Countries" },
        ]}
        currentDimId="regions"
      />,
    );
    // Switch the new field's type to the linked type to reveal the picker.
    fireEvent.click(screen.getByText("Linked"));
    expect(screen.getByRole("option", { name: "Regions (this table)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Countries" })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run src/components/AddFieldPopover.test.tsx`
Expected: FAIL — the current table is filtered out, so `"Regions (this table)"` option is not found.

- [ ] **Step 3: Include the current table in the picker**

In `app/src/components/AddFieldPopover.tsx`, replace the linked-target options (the `.filter((d) => d.id !== currentDimId)` block, ~line 584):

```tsx
                <option value="">— pick a table —</option>
                {(allDims ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.id === currentDimId ? `${d.dimension} (this table)` : d.dimension}
                  </option>
                ))}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run src/components/AddFieldPopover.test.tsx`
Expected: PASS.

- [ ] **Step 5: Surface the cycle error in the grid**

In `app/src/components/TablePane.tsx`, add `ApiCodeError` to the store import (find the existing `from "../store"` import and add it to the named list):

```tsx
  ApiCodeError,
```

Then replace the cell-edit catch (~lines 1373-1377):

```tsx
                  try {
                    await setFieldValue(activeId, rowKey, field, v);
                  } catch (e) {
                    // Store reverted the optimistic value; surface the failure.
                    // A cycle rejection carries a specific, user-ready message.
                    const msg =
                      e instanceof ApiCodeError && e.code === "HIERARCHY_CYCLE"
                        ? e.message
                        : "Couldn't save that change — try again.";
                    toast(msg, "error");
                    return;
                  }
```

- [ ] **Step 6: Typecheck, lint, and run the app tests**

Run: `cd app && npm run typecheck && npm run lint && npm run test`
Expected: typecheck clean; lint 0 errors; all tests pass (including the new picker test).

- [ ] **Step 7: Manual verification (thin UI wiring not covered by automated tests)**

Run the app (`npm run dev` per project setup). In a table:
1. Add a field of type Linked, target `<this table> (this table)` — confirm it saves.
2. Give record B the parent A. Then try to set A's parent to B.
   Expected: a toast reading "Setting that parent would create a loop." and A's parent unchanged.
3. Try to set a record's parent to itself.
   Expected: toast "A record can't be its own parent."

- [ ] **Step 8: Commit**

```bash
git add app/src/components/AddFieldPopover.tsx app/src/components/AddFieldPopover.test.tsx app/src/components/TablePane.tsx
git commit -m "feat(hierarchy): self-link picker + cycle-error toast

The link-target picker now lists the current table as '<name> (this
table)', and a cyclic parent edit surfaces the server's HIERARCHY_CYCLE
message instead of the generic save-failed toast.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- The `dim_<id>` physical tables created by `addDimension` are dropped in the test's `afterAll` so the file is rerun-safe — keep that block if you add dims.
- Do not add per-row self-exclusion to the parent picker in this pass (see Global Constraints) — the write-guard rejects self-parenting with a clear toast.
- The recursive cycle query relies on there being no pre-existing cyclic data; that holds because self-links were impossible before Task 1.
