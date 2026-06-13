# Linked Fields UX Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make linked fields fully editable post-creation — surface a picker for which target-dim fields to bring along, branch the right-click menu by column kind, and replace the `↳` glyph with `Country › ISO Code` labels.

**Architecture:** No schema migration. Reuses the existing `field_config.displayFields: string[]` JSON shape on `dimension_field`. The server's `updateField` already accepts a `field_config` patch — this plan adds validation + audit. On the frontend, lookup columns are still synthesized in `TablePane`; we add a `columnKind` discriminator to `ColumnDef`, extract column synthesis into a testable helper, branch `DataGrid.buildMenuItems` on `columnKind`, and add a `ManageLinkedFieldsPopover` reachable from both the FK and the lookup column menus.

**Tech Stack:** Bun + TypeScript + `postgres.js` (server), Vite + React 18 + Tailwind (app). Server tests use `bun:test`. App tests use Vitest + `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-06-13-linked-fields-ux-design.md`

---

## File Structure

**Modify:**
- `server/src/repo-canonical.ts` (≈842-917 — `updateField`) — add `displayFields` validation + audit
- `app/src/store.ts` — add `updateFieldDisplayFields` action
- `app/src/data.ts` — add `LinkedFieldConfig` helper type (already inferred; just exporting for tests)
- `app/src/components/TablePane.tsx` (≈362-371) — set `columnKind`, `sourceField`, change lookup label
- `app/src/components/datagrid/types.ts` — extend `ColumnDef` with `columnKind` + `sourceField`
- `app/src/components/datagrid/DataGrid.tsx` (669-719 — `buildMenuItems`) — branch by `columnKind`
- `app/src/components/datagrid/cells/LinkedCell.tsx` — handle missing-record case for lookups (cell-level render)

**Create:**
- `app/src/components/linked/buildLinkedColumns.ts` — pure helper extracted from TablePane (testable)
- `app/src/components/linked/ManageLinkedFieldsPopover.tsx` — the picker
- `server/test/linked-fields-display-fields.test.ts` — server validation tests
- `app/test/store-update-display-fields.test.ts` — store action tests
- `app/test/build-linked-columns.test.ts` — column-synthesis tests
- `app/test/datagrid-linked-menu.test.tsx` — branched menu tests
- `app/test/manage-linked-fields-popover.test.tsx` — picker tests

Each task below is a complete TDD cycle producing one commit.

---

### Task 1: Server-side `displayFields` validation + audit

**Files:**
- Modify: `server/src/repo-canonical.ts:842-917`
- Test: `server/test/linked-fields-display-fields.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `server/test/linked-fields-display-fields.test.ts`:

```typescript
import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import * as repo from "../src/repo.ts";
import { pgAll } from "../src/pg.ts";
import { pg } from "../src/pg-name.ts";

const tenantId = "default";
const userId = "u_test";

async function setupLink(): Promise<{ srcDim: string; tgtDim: string; fkField: string }> {
  const tgtDim = await repo.addDimension("Country", [], {}, userId, tenantId);
  await repo.addField(tgtDim, "ISO Code", "text", undefined, { silent: true }, userId, tenantId);
  await repo.addField(tgtDim, "Region", "text", undefined, { silent: true }, userId, tenantId);
  const srcDim = await repo.addDimension("Partner", [], {}, userId, tenantId);
  await repo.addField(
    srcDim,
    "Country",
    "linked",
    undefined,
    {
      silent: true,
      fieldConfig: JSON.stringify({ type: "linked", targetDimId: tgtDim, displayFields: ["label"] }),
    },
    userId,
    tenantId,
  );
  return { srcDim, tgtDim, fkField: "country" };
}

beforeEach(async () => { await resetDb(); });

test("displayFields update accepts label + valid target fields", async () => {
  const { srcDim, fkField } = await setupLink();
  await repo.updateField(
    srcDim,
    fkField,
    { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code"] }) },
    userId,
    tenantId,
  );
  const dim = await repo.getDimension(srcDim, tenantId);
  const cfg = dim?.fields.find((f) => f.field === fkField);
  expect(cfg?.displayFields).toEqual(["label", "iso_code"]);
});

test("displayFields update rejects missing label", async () => {
  const { srcDim, fkField } = await setupLink();
  await expect(
    repo.updateField(
      srcDim,
      fkField,
      { fieldConfig: JSON.stringify({ displayFields: ["iso_code"] }) },
      userId,
      tenantId,
    ),
  ).rejects.toThrow(/must include "label"/i);
});

test("displayFields update rejects duplicates", async () => {
  const { srcDim, fkField } = await setupLink();
  await expect(
    repo.updateField(
      srcDim,
      fkField,
      { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code", "iso_code"] }) },
      userId,
      tenantId,
    ),
  ).rejects.toThrow(/duplicate/i);
});

test("displayFields update rejects field not on target dim", async () => {
  const { srcDim, fkField } = await setupLink();
  await expect(
    repo.updateField(
      srcDim,
      fkField,
      { fieldConfig: JSON.stringify({ displayFields: ["label", "does_not_exist"] }) },
      userId,
      tenantId,
    ),
  ).rejects.toThrow(/does_not_exist/);
});

test("displayFields update tolerates stale entries that were already stored (recovery path)", async () => {
  const { srcDim, fkField, tgtDim } = await setupLink();
  await repo.updateField(
    srcDim,
    fkField,
    { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code"] }) },
    userId,
    tenantId,
  );
  // Simulate target-dim field rename by replacing iso_code's row via direct UPDATE
  await pgAll(`UPDATE ${pg("dimension_field")} SET field = 'code' WHERE dim_id = $1 AND field = $2 AND tenant_id = $3`, [tgtDim, "iso_code", tenantId]);
  // The stored displayFields still references iso_code (stale). User keeps it and adds region — must succeed.
  await repo.updateField(
    srcDim,
    fkField,
    { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code", "region"] }) },
    userId,
    tenantId,
  );
  const dim = await repo.getDimension(srcDim, tenantId);
  const cfg = dim?.fields.find((f) => f.field === fkField);
  expect(cfg?.displayFields).toEqual(["label", "iso_code", "region"]);
});

test("targetDimId is immutable", async () => {
  const { srcDim, fkField } = await setupLink();
  const otherDim = await repo.addDimension("Channel", [], {}, userId, tenantId);
  await expect(
    repo.updateField(
      srcDim,
      fkField,
      { fieldConfig: JSON.stringify({ targetDimId: otherDim }) },
      userId,
      tenantId,
    ),
  ).rejects.toThrow(/targetDimId.*immutable/i);
});

test("displayFields update appends audit entry with before/after", async () => {
  const { srcDim, fkField } = await setupLink();
  await repo.updateField(
    srcDim,
    fkField,
    { fieldConfig: JSON.stringify({ displayFields: ["label", "iso_code"] }) },
    userId,
    tenantId,
  );
  const rows = await pgAll<{ action: string; metadata: string | null; detail: string }>(
    `SELECT action, metadata, detail FROM ${pg("audit_log")} WHERE tenant_id = $1 AND action = $2 ORDER BY created_at DESC`,
    [tenantId, "field.displayFields.update"],
  );
  expect(rows.length).toBe(1);
  expect(rows[0].detail).toBe(fkField);
  const meta = JSON.parse(rows[0].metadata ?? "{}");
  expect(meta.before).toEqual(["label"]);
  expect(meta.after).toEqual(["label", "iso_code"]);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
cd server && bun test test/linked-fields-display-fields.test.ts
```

Expected: all 7 tests fail — most because validation/audit is not yet implemented; `targetDimId` change currently goes through unchecked.

- [ ] **Step 3: Implement validation + audit in `updateField`**

In `server/src/repo-canonical.ts`, inside the `if (updates.fieldConfig !== undefined)` block (around line 855, immediately after `currentCfg` is built and before `mergedConfig = JSON.stringify(...)`):

```typescript
const incomingParsed: Record<string, unknown> = (() => {
  if (updates.fieldConfig == null) return {};
  try {
    const v: unknown = JSON.parse(updates.fieldConfig);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
})();

if ("targetDimId" in incomingParsed) {
  const incomingTarget = String(incomingParsed.targetDimId ?? "");
  const currentTarget = typeof currentCfg.targetDimId === "string" ? currentCfg.targetDimId : "";
  if (currentTarget !== "" && incomingTarget !== "" && incomingTarget !== currentTarget) {
    throw new Error("targetDimId is immutable after creation; delete and recreate the field");
  }
}

let beforeDisplayFields: string[] | null = null;
let afterDisplayFields: string[] | null = null;
if ("displayFields" in incomingParsed) {
  const incoming = incomingParsed.displayFields;
  if (!Array.isArray(incoming) || !incoming.every((v) => typeof v === "string")) {
    throw new Error("displayFields must be an array of strings");
  }
  if (!incoming.includes("label")) {
    throw new Error('displayFields must include "label"');
  }
  if (new Set(incoming).size !== incoming.length) {
    throw new Error("displayFields contains duplicate entries");
  }
  const targetDimId =
    (typeof currentCfg.targetDimId === "string" ? currentCfg.targetDimId : "") ||
    (typeof incomingParsed.targetDimId === "string" ? incomingParsed.targetDimId : "");
  if (targetDimId === "") {
    throw new Error("displayFields update requires a target dimension");
  }
  const targetFields = await pgAll<{ field: string }>(
    `SELECT field FROM ${pg("dimension_field")} WHERE dim_id = $1 AND tenant_id = $2`,
    [targetDimId, tenantId],
  );
  const validFields = new Set(targetFields.map((r) => r.field));
  const priorList = Array.isArray(currentCfg.displayFields)
    ? (currentCfg.displayFields as unknown[]).filter((v): v is string => typeof v === "string")
    : ["label"];
  const priorSet = new Set(priorList);
  for (const entry of incoming) {
    if (entry === "label") continue;
    if (validFields.has(entry)) continue;
    if (priorSet.has(entry)) continue; // stale-but-already-stored: tolerate
    throw new Error(`displayFields entry not found on target dimension: ${entry}`);
  }
  beforeDisplayFields = priorList;
  afterDisplayFields = incoming;
}
```

Then, after the existing `await pgRun(...UPDATE dimension_field...)` and the `if (incomingCfg !== null && "rules" in incomingCfg)` audit block, add:

```typescript
if (beforeDisplayFields !== null && afterDisplayFields !== null) {
  await appendAuditAs(userId, "field.displayFields.update", field, {
    tableId: dimId,
    tenantId,
    metadata: { before: beforeDisplayFields, after: afterDisplayFields },
  });
}
```

Make sure `pgAll` and `pg` are imported at the top of the file (verify imports; add `pgAll` to the `pg.ts` import line if missing).

- [ ] **Step 4: Run tests to confirm they pass**

```
cd server && bun test test/linked-fields-display-fields.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 5: Run the full server suite to confirm no regressions**

```
cd server && bun test
```

Expected: all tests pass (≥ 307 prior baseline).

- [ ] **Step 6: Typecheck**

```
cd server && bun run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/src/repo-canonical.ts server/test/linked-fields-display-fields.test.ts
git commit -m "feat(server): validate displayFields + audit log

- enforces label inclusion, no duplicates, valid target fields
- tolerates already-stored stale entries for rename recovery
- rejects targetDimId mutation (immutable post-creation)
- appends field.displayFields.update with before/after metadata"
```

---

### Task 2: Frontend store action `updateFieldDisplayFields`

**Files:**
- Modify: `app/src/store.ts` (mirror `updateFieldRules` around line 930)
- Test: `app/test/store-update-display-fields.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `app/test/store-update-display-fields.test.ts`:

```typescript
import { test, expect, vi, beforeEach } from "vitest";

const apiCalls: Array<{ path: string; init?: RequestInit }> = [];

vi.mock("../src/lib/api", () => ({
  api: async <T>(path: string, init?: RequestInit): Promise<T> => {
    apiCalls.push({ path, init });
    return undefined as T;
  },
  apiFetch: async () => new Response(""),
}));

// store.ts pulls a few effects on import that we don't want here; stub them
vi.mock("../src/lib/use-presence", () => ({ useTenantOptional: () => null }));

import { updateFieldDisplayFields } from "../src/store";

beforeEach(() => {
  apiCalls.length = 0;
});

test("updateFieldDisplayFields PATCHes the field with stringified field_config", async () => {
  await updateFieldDisplayFields("partner", "country", ["label", "iso_code", "region"]);
  expect(apiCalls.length).toBe(1);
  expect(apiCalls[0].path).toBe("/dimensions/partner/fields/country");
  expect(apiCalls[0].init?.method).toBe("PATCH");
  const body = JSON.parse(String(apiCalls[0].init?.body));
  const cfg = JSON.parse(body.field_config);
  expect(cfg.displayFields).toEqual(["label", "iso_code", "region"]);
});

test("encodes dim and field params for URL safety", async () => {
  await updateFieldDisplayFields("dim with space", "f/k", ["label"]);
  expect(apiCalls[0].path).toBe("/dimensions/dim%20with%20space/fields/f%2Fk");
});
```

- [ ] **Step 2: Run test to confirm failure**

```
cd app && bun run test test/store-update-display-fields.test.ts
```

Expected: FAIL — `updateFieldDisplayFields` is not exported from `store.ts`.

- [ ] **Step 3: Implement the action**

In `app/src/store.ts`, immediately after `updateFieldRules` (around line 941), add:

```typescript
export async function updateFieldDisplayFields(
  dimId: string,
  field: string,
  displayFields: string[],
): Promise<void> {
  await api<void>(
    `/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ field_config: JSON.stringify({ displayFields }) }),
    },
  );
  await refreshDim(dimId);
  emit();
}
```

(Patterned exactly on `updateFieldRules`.)

- [ ] **Step 4: Run test to confirm pass**

```
cd app && bun run test test/store-update-display-fields.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

```
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/store.ts app/test/store-update-display-fields.test.ts
git commit -m "feat(app): updateFieldDisplayFields store action"
```

---

### Task 3: Column kind metadata + new lookup naming

Extracts column synthesis from `TablePane` into a pure helper, sets `columnKind` ("fk" | "lookup") and `sourceField` on synthesized columns, and switches lookup labels to `"FK Label › Target Field Label"`.

**Files:**
- Modify: `app/src/components/datagrid/types.ts:56-72` (add `columnKind` + `sourceField` to `ColumnDef`)
- Create: `app/src/components/linked/buildLinkedColumns.ts`
- Modify: `app/src/components/TablePane.tsx:362-371` (use the helper)
- Test: `app/test/build-linked-columns.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `app/test/build-linked-columns.test.ts`:

```typescript
import { test, expect } from "vitest";
import { buildLinkedColumns } from "../src/components/linked/buildLinkedColumns";
import type { FieldDef } from "../src/data";

const fkField: FieldDef = {
  field: "country",
  label: "Country",
  type: "linked",
  referencedDimId: "dim_country",
  displayFields: ["label", "iso_code", "region"],
};

const targetMeta = {
  fieldLabels: new Map<string, string>([
    ["label", "Label"],
    ["iso_code", "ISO Code"],
    ["region", "Region"],
  ]),
  fieldExists: new Set<string>(["label", "iso_code", "region"]),
  candidates: [{ key: "DE", label: "Germany" }],
};

test("FK column carries columnKind 'fk'", () => {
  const [fkCol] = buildLinkedColumns(fkField, targetMeta);
  expect(fkCol.field).toBe("country");
  expect(fkCol.label).toBe("Country");
  expect(fkCol.columnKind).toBe("fk");
  expect(fkCol.config.type).toBe("linked");
});

test("lookup columns are generated for each non-label displayField with kind 'lookup' and sourceField pointing to FK", () => {
  const cols = buildLinkedColumns(fkField, targetMeta);
  expect(cols.length).toBe(3); // FK + iso_code + region
  const iso = cols.find((c) => c.field === "country__iso_code")!;
  expect(iso.columnKind).toBe("lookup");
  expect(iso.sourceField).toBe("country");
  expect(iso.editable).toBe(false);
  expect(iso.label).toBe("Country › ISO Code");
});

test("lookup column for a stale (missing) displayField is marked with a stale flag", () => {
  const staleField: FieldDef = {
    ...fkField,
    displayFields: ["label", "deleted_field"],
  };
  const cols = buildLinkedColumns(staleField, targetMeta);
  const stale = cols.find((c) => c.field === "country__deleted_field")!;
  expect(stale.columnKind).toBe("lookup");
  expect(stale.linkedStale).toBe(true);
  expect(stale.label).toContain("deleted_field"); // fallback to field name
});

test("label-only displayFields produces just the FK column", () => {
  const labelOnly: FieldDef = { ...fkField, displayFields: ["label"] };
  const cols = buildLinkedColumns(labelOnly, targetMeta);
  expect(cols.length).toBe(1);
  expect(cols[0].field).toBe("country");
});

test("FK candidates flow into config.candidates", () => {
  const [fkCol] = buildLinkedColumns(fkField, targetMeta);
  if (fkCol.config.type === "linked") {
    expect(fkCol.config.candidates).toEqual([{ key: "DE", label: "Germany" }]);
    expect(fkCol.config.targetDimId).toBe("dim_country");
    expect(fkCol.config.displayFields).toEqual(["label", "iso_code", "region"]);
  } else {
    throw new Error("FK col should be linked");
  }
});
```

- [ ] **Step 2: Run test to confirm failure**

```
cd app && bun run test test/build-linked-columns.test.ts
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Extend `ColumnDef` in `types.ts`**

In `app/src/components/datagrid/types.ts`, change `ColumnDef` (line 56):

```typescript
export interface ColumnDef<Row> {
  field: string;
  label: string;
  config: ColumnConfig;
  width?: number;
  hidden?: boolean;
  sortable?: boolean;
  editable?: boolean;
  pinnedLeft?: boolean;
  align?: "left" | "right";
  rules?: ConditionalRule[];
  description?: string;
  /** Discriminator used by the right-click menu and rendering layer. */
  columnKind?: "fk" | "lookup";
  /** For lookup columns, the FK column's field name. */
  sourceField?: string;
  /** Lookup column whose target-dim field no longer exists. */
  linkedStale?: boolean;
  render?: (row: Row, ctx: CellCtx<Row>) => ReactNode;
  edit?: (row: Row, ctx: EditCtx<Row>) => ReactNode;
}
```

- [ ] **Step 4: Create `buildLinkedColumns.ts`**

Create `app/src/components/linked/buildLinkedColumns.ts`:

```typescript
import type { ColumnDef } from "../datagrid/types";
import type { FieldDef } from "../../data";
import type { CanonicalValue } from "../../store";

export interface TargetMeta {
  /** Map from target field name → display label. */
  fieldLabels: Map<string, string>;
  /** Set of fields that currently exist on the target dimension. */
  fieldExists: Set<string>;
  /** Candidates for the FK cell editor. */
  candidates: { key: string; label: string }[];
}

export function buildLinkedColumns(
  field: FieldDef,
  target: TargetMeta,
): ColumnDef<CanonicalValue>[] {
  const displayFields = field.displayFields ?? ["label"];
  const targetDimId = field.referencedDimId ?? "";

  const fkCol: ColumnDef<CanonicalValue> = {
    field: field.field,
    label: field.label,
    config: {
      type: "linked",
      targetDimId,
      displayFields,
      candidates: target.candidates,
    },
    description: field.description,
    rules: field.rules,
    columnKind: "fk",
  };

  const lookupCols: ColumnDef<CanonicalValue>[] = displayFields
    .filter((df) => df !== "label")
    .map((df) => {
      const exists = target.fieldExists.has(df);
      const targetLabel = exists ? (target.fieldLabels.get(df) ?? df) : df;
      return {
        field: `${field.field}__${df}`,
        label: `${field.label} › ${targetLabel}`,
        config: { type: "text" } as const,
        editable: false,
        columnKind: "lookup",
        sourceField: field.field,
        linkedStale: !exists,
      };
    });

  return [fkCol, ...lookupCols];
}
```

- [ ] **Step 5: Run test to confirm pass**

```
cd app && bun run test test/build-linked-columns.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 6: Wire the helper into `TablePane.tsx`**

Open `app/src/components/TablePane.tsx`. Find the block at ~362-371 that builds `fkCol` + `lookupCols`. Replace with:

```typescript
import { buildLinkedColumns } from "./linked/buildLinkedColumns";
// (existing imports above)

// …inside the column-build loop, where the linked-field branch was:
const target = targets.get(f.referencedDimId ?? "");
const targetMeta = {
  fieldLabels: target?.fieldLabels ?? new Map<string, string>(),
  fieldExists: target?.fieldExists ?? new Set<string>(),
  candidates: target?.candidates ?? [],
};
return buildLinkedColumns(f, targetMeta);
```

(Adapt the variable names — `target`, `f`, etc. — to match the surrounding code. The crucial change is that the column synthesis now goes through `buildLinkedColumns` instead of inline construction. If the surrounding context doesn't already populate a `fieldExists` set, derive it from `target.fieldLabels.keys()` or from the target dim's fields list.)

If `targets` in TablePane only carries `fieldLabels` today, also populate `fieldExists` from the same source — derive `new Set(target.fieldLabels.keys())` if no separate set is exposed.

- [ ] **Step 7: Run the full app suite**

```
cd app && bun run test
```

Expected: pass. Existing tests that depend on the lookup label (e.g. any test asserting `↳ iso_code`) will fail — update them to the new format if so.

- [ ] **Step 8: Typecheck**

```
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add app/src/components/datagrid/types.ts app/src/components/linked/buildLinkedColumns.ts \
       app/src/components/TablePane.tsx app/test/build-linked-columns.test.ts
git commit -m "feat(app): extract linked column synthesis + columnKind metadata

- ColumnDef gains columnKind ('fk' | 'lookup'), sourceField, linkedStale
- TablePane delegates to buildLinkedColumns (pure helper, unit-tested)
- lookup labels are 'FK Label › Target Field Label' (was '↳ field')
- stale entries (target field removed) marked linkedStale for header UI"
```

---

### Task 4: Branched right-click menu in DataGrid

**Files:**
- Modify: `app/src/components/datagrid/DataGrid.tsx` (around 669-719 — `buildMenuItems` header branch)
- Test: `app/test/datagrid-linked-menu.test.tsx` (create)

The menu needs new optional handler props on the `DataGrid` to remain pure. Add:
- `onShowLinkedFields?: (fkField: string) => void`
- `onOpenTargetDimension?: (fkField: string) => void`
- `onChangeDisplayedField?: (lookupField: string) => void`
- `onManageLinkedFields?: (lookupField: string) => void`
- `onRemoveLookup?: (lookupField: string) => void`
- `onJumpToSourceColumn?: (fkField: string) => void`

- [ ] **Step 1: Write the failing tests**

Create `app/test/datagrid-linked-menu.test.tsx`:

```typescript
import { test, expect, describe, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row { id: string; country: string }
const rows: Row[] = [{ id: "1", country: "DE" }];

function fkColumn(): ColumnDef<Row> {
  return {
    field: "country",
    label: "Country",
    config: { type: "linked", targetDimId: "dim_country", displayFields: ["label", "iso_code"], candidates: [{ key: "DE", label: "Germany" }] },
    columnKind: "fk",
  };
}
function lookupColumn(): ColumnDef<Row> {
  return {
    field: "country__iso_code",
    label: "Country › ISO Code",
    config: { type: "text" },
    editable: false,
    columnKind: "lookup",
    sourceField: "country",
  };
}
function normalColumn(): ColumnDef<Row> {
  return { field: "id", label: "ID", config: { type: "text" } };
}

function openHeaderMenu(field: string, container: HTMLElement) {
  const h = container.querySelector(`[data-header="${field}"] span`) as HTMLElement;
  act(() => { fireEvent.contextMenu(h, { clientX: 50, clientY: 50, bubbles: true }); });
  return document.querySelector('[role="menu"]')!;
}

describe("right-click on FK column", () => {
  test("shows 'Show linked fields…' and 'Open target dimension →'", () => {
    const onShow = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={[normalColumn(), fkColumn()]} rowKey={(r) => r.id} onCommit={async () => {}}
          onShowLinkedFields={onShow} onOpenTargetDimension={onOpen} />
      </UndoStackProvider>,
    );
    const menu = openHeaderMenu("country", container);
    expect(menu.textContent).toContain("Show linked fields");
    expect(menu.textContent).toContain("Open target dimension");
    expect(menu.textContent).not.toContain("Change displayed field");
  });
});

describe("right-click on lookup column", () => {
  test("shows lookup-specific items and hides Rename/Change type", () => {
    const onChange = vi.fn();
    const onRemove = vi.fn();
    const onJump = vi.fn();
    const onManage = vi.fn();
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={[normalColumn(), fkColumn(), lookupColumn()]} rowKey={(r) => r.id} onCommit={async () => {}}
          onChangeDisplayedField={onChange} onRemoveLookup={onRemove} onJumpToSourceColumn={onJump} onManageLinkedFields={onManage} />
      </UndoStackProvider>,
    );
    const menu = openHeaderMenu("country__iso_code", container);
    expect(menu.textContent).toContain("Change displayed field");
    expect(menu.textContent).toContain("Manage linked fields");
    expect(menu.textContent).toContain("Jump to source column");
    expect(menu.textContent).toContain("Remove this lookup");
    expect(menu.textContent).not.toContain("Rename");
    expect(menu.textContent).not.toContain("Change type");
  });
});

describe("right-click on normal column", () => {
  test("does NOT include linked-field items", () => {
    const { container } = render(
      <UndoStackProvider>
        <DataGrid rows={rows} columns={[normalColumn(), fkColumn()]} rowKey={(r) => r.id} onCommit={async () => {}} />
      </UndoStackProvider>,
    );
    const menu = openHeaderMenu("id", container);
    expect(menu.textContent).toContain("Rename");
    expect(menu.textContent).not.toContain("Show linked fields");
    expect(menu.textContent).not.toContain("Change displayed field");
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```
cd app && bun run test test/datagrid-linked-menu.test.tsx
```

Expected: FAIL — new menu items don't exist; props don't exist.

- [ ] **Step 3: Add the new optional handler props to DataGrid**

In `app/src/components/datagrid/DataGrid.tsx`, find the `DataGridProps` (or the inline props the component receives). Add:

```typescript
onShowLinkedFields?: (fkField: string) => void;
onOpenTargetDimension?: (fkField: string) => void;
onChangeDisplayedField?: (lookupField: string) => void;
onManageLinkedFields?: (lookupField: string) => void;
onRemoveLookup?: (lookupField: string) => void;
onJumpToSourceColumn?: (fkField: string) => void;
```

- [ ] **Step 4: Branch `buildMenuItems` header path on `columnKind`**

In `app/src/components/datagrid/DataGrid.tsx`, locate the `surface.kind === "header"` block (around line 669). Replace its body with:

```typescript
const c = orderedVisible.find((col) => col.field === surface.field);
const kind = c?.columnKind ?? "normal";

const sort = (dir: "asc" | "desc") => ({
  label: `Sort ${dir === "asc" ? "ascending" : "descending"}`,
  onClick: () => setSort({ field: surface.field, dir }),
});
const conditional = {
  label: "Conditional formatting…",
  onClick: () => props.onOpenConditionalFormat?.(surface.field),
  disabled: !props.onOpenConditionalFormat,
};
const hide = {
  label: "Hide column",
  onClick: () => {
    const hidden = [...columns.filter((v) => v.hidden).map((v) => v.field), surface.field];
    props.onLayoutChange?.({ hidden });
  },
};
const sep = { separator: true, label: "", onClick: () => {} };

if (kind === "lookup") {
  return [
    sort("asc"),
    sort("desc"),
    conditional,
    sep,
    {
      label: "Change displayed field…",
      onClick: () => props.onChangeDisplayedField?.(surface.field),
      disabled: !props.onChangeDisplayedField,
    },
    {
      label: "Manage linked fields…",
      onClick: () => props.onManageLinkedFields?.(surface.field),
      disabled: !props.onManageLinkedFields,
    },
    {
      label: "Jump to source column →",
      onClick: () => props.onJumpToSourceColumn?.(c?.sourceField ?? surface.field),
      disabled: !props.onJumpToSourceColumn,
    },
    sep,
    hide,
    {
      label: "Remove this lookup",
      onClick: () => props.onRemoveLookup?.(surface.field),
      disabled: !props.onRemoveLookup,
    },
  ];
}

// Normal + FK share the standard column header items (Rename / Change type / etc),
// FK gets extras inserted before Hide/Delete.
const base = [
  sort("asc"),
  sort("desc"),
  {
    label: "Rename",
    onClick: () => {
      if (contextMenu) setMenuAnchorRect(new DOMRect(contextMenu.x, contextMenu.y, 0, 0));
      setMenuFor(surface.field);
    },
  },
  {
    label: "Change type",
    onClick: () => props.onOpenChangeType?.(surface.field),
    disabled: !props.onOpenChangeType,
  },
  conditional,
  {
    label: "Edit description",
    onClick: () => props.onEditDescription?.(surface.field),
    disabled: !props.onEditDescription,
  },
];

if (kind === "fk") {
  base.push(
    sep,
    {
      label: "Show linked fields…",
      onClick: () => props.onShowLinkedFields?.(surface.field),
      disabled: !props.onShowLinkedFields,
    },
    {
      label: "Open target dimension →",
      onClick: () => props.onOpenTargetDimension?.(surface.field),
      disabled: !props.onOpenTargetDimension,
    },
  );
}

base.push(
  sep,
  hide,
  {
    label: "Delete column",
    onClick: () => props.onDeleteColumn?.(surface.field),
    disabled: !props.onDeleteColumn || !!c?.pinnedLeft,
  },
);

return base;
```

(The exact menu-item array literals already in the file will be reorganized; preserve any items the existing code emits that aren't covered here — only the FK/lookup branches are new.)

- [ ] **Step 5: Run tests to confirm pass**

```
cd app && bun run test test/datagrid-linked-menu.test.tsx
```

Expected: 3 tests pass.

- [ ] **Step 6: Run existing menu test to confirm no regression**

```
cd app && bun run test test/datagrid-context-menu.test.tsx
```

Expected: pass (it asserts "Rename" + "Sort ascending" — still there for normal columns).

- [ ] **Step 7: Typecheck**

```
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add app/src/components/datagrid/DataGrid.tsx app/test/datagrid-linked-menu.test.tsx
git commit -m "feat(app): branch column context menu by columnKind

FK columns gain 'Show linked fields…' + 'Open target dimension →'.
Lookup columns gain 'Change displayed field…', 'Manage linked fields…',
'Jump to source column →', 'Remove this lookup'; drop Rename / Change type /
Edit description / Delete (auto-derived or moved to FK)."
```

---

### Task 5: `ManageLinkedFieldsPopover` component

**Files:**
- Create: `app/src/components/linked/ManageLinkedFieldsPopover.tsx`
- Create: `app/test/manage-linked-fields-popover.test.tsx`

The popover is pure UI: receives `targetFields`, `current`, `anchorRect`, callbacks. No store access — the parent wires `onApply` to `updateFieldDisplayFields`.

- [ ] **Step 1: Write the failing test**

Create `app/test/manage-linked-fields-popover.test.tsx`:

```typescript
import { test, expect, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { ManageLinkedFieldsPopover } from "../src/components/linked/ManageLinkedFieldsPopover";

const targetFields = [
  { field: "label", label: "Label", type: "text" as const },
  { field: "iso_code", label: "ISO Code", type: "text" as const },
  { field: "region", label: "Region", type: "text" as const },
  { field: "continent", label: "Continent", type: "linked" as const },
];

const baseProps = {
  fkLabel: "Country",
  targetFields,
  current: ["label", "iso_code"],
  anchorRect: new DOMRect(0, 0, 100, 30),
  onCancel: vi.fn(),
  onApply: vi.fn(),
};

test("renders all target fields with label checked + disabled", () => {
  const { container } = render(<ManageLinkedFieldsPopover {...baseProps} />);
  const labelRow = container.querySelector('[data-field="label"] input') as HTMLInputElement;
  expect(labelRow.checked).toBe(true);
  expect(labelRow.disabled).toBe(true);
  const isoRow = container.querySelector('[data-field="iso_code"] input') as HTMLInputElement;
  expect(isoRow.checked).toBe(true);
  expect(isoRow.disabled).toBe(false);
  const continentRow = container.querySelector('[data-field="continent"] input') as HTMLInputElement;
  expect(continentRow.checked).toBe(false);
  expect(continentRow.disabled).toBe(true);
});

test("search filters by label (case-insensitive)", () => {
  const { container } = render(<ManageLinkedFieldsPopover {...baseProps} />);
  const search = container.querySelector('input[type="search"]') as HTMLInputElement;
  act(() => { fireEvent.input(search, { target: { value: "iso" } }); });
  expect(container.querySelector('[data-field="iso_code"]')).not.toBeNull();
  expect(container.querySelector('[data-field="region"]')).toBeNull();
  expect(container.querySelector('[data-field="label"]')).not.toBeNull(); // always shown
});

test("Apply calls onApply with new array; Cancel calls onCancel", () => {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  const { container, getByText } = render(
    <ManageLinkedFieldsPopover {...baseProps} onApply={onApply} onCancel={onCancel} />,
  );
  const regionRow = container.querySelector('[data-field="region"] input') as HTMLInputElement;
  act(() => { fireEvent.click(regionRow); });
  act(() => { fireEvent.click(getByText("Apply")); });
  expect(onApply).toHaveBeenCalledWith(["label", "iso_code", "region"]);
  act(() => { fireEvent.click(getByText("Cancel")); });
  expect(onCancel).toHaveBeenCalled();
});

test("unchecking iso_code removes it from the applied array but keeps label", () => {
  const onApply = vi.fn();
  const { container, getByText } = render(
    <ManageLinkedFieldsPopover {...baseProps} onApply={onApply} />,
  );
  const isoRow = container.querySelector('[data-field="iso_code"] input') as HTMLInputElement;
  act(() => { fireEvent.click(isoRow); });
  act(() => { fireEvent.click(getByText("Apply")); });
  expect(onApply).toHaveBeenCalledWith(["label"]);
});
```

- [ ] **Step 2: Run test to confirm failure**

```
cd app && bun run test test/manage-linked-fields-popover.test.tsx
```

Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the popover**

Create `app/src/components/linked/ManageLinkedFieldsPopover.tsx`:

```typescript
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";

export interface TargetFieldOption {
  field: string;
  label: string;
  type: string;
}

interface Props {
  fkLabel: string;
  targetFields: TargetFieldOption[];
  current: string[];
  anchorRect: DOMRect;
  onCancel: () => void;
  onApply: (next: string[]) => void;
}

export function ManageLinkedFieldsPopover(props: Props): JSX.Element {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(props.current));

  const sortedFields = useMemo(() => {
    const label = props.targetFields.find((f) => f.field === "label");
    const others = props.targetFields.filter((f) => f.field !== "label");
    const checked = others.filter((f) => selected.has(f.field));
    const unchecked = others.filter((f) => !selected.has(f.field));
    unchecked.sort((a, b) => a.label.localeCompare(b.label));
    return [label, ...checked, ...unchecked].filter(Boolean) as TargetFieldOption[];
  }, [props.targetFields, selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return sortedFields;
    return sortedFields.filter(
      (f) => f.field === "label" || f.label.toLowerCase().includes(q),
    );
  }, [sortedFields, query]);

  const toggle = (field: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const apply = (): void => {
    const order: string[] = [];
    if (selected.has("label")) order.push("label");
    for (const f of props.targetFields) {
      if (f.field === "label") continue;
      if (selected.has(f.field)) order.push(f.field);
    }
    props.onApply(order);
  };

  return createPortal(
    <div
      role="dialog"
      className="fixed z-50 w-[320px] rounded-sm border border-line-2 bg-bg shadow-pop"
      style={{ top: props.anchorRect.bottom + 6, left: props.anchorRect.left }}
    >
      <div className="border-b border-line p-2">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
          Show linked fields — {props.fkLabel}
        </div>
        <input
          type="search"
          placeholder="Search fields…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-accent"
        />
      </div>
      <div className="max-h-[260px] overflow-y-auto p-2">
        {filtered.map((f) => {
          const disabled = f.field === "label" || f.type === "linked";
          const checked = selected.has(f.field) || f.field === "label";
          return (
            <label
              key={f.field}
              data-field={f.field}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1 font-mono text-[11px] hover:bg-bg-2 ${disabled ? "opacity-60" : ""}`}
              title={f.type === "linked" ? "Lookups through another link are not supported" : undefined}
            >
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(f.field)}
                />
                <span>{f.label}</span>
              </span>
              <span className="text-ink-3">{f.type}</span>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line p-2">
        <button
          onClick={props.onCancel}
          className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2"
        >
          Cancel
        </button>
        <button
          onClick={apply}
          className="rounded-sm border border-accent bg-accent px-3 py-1 font-mono text-[11px] text-bg hover:opacity-90"
        >
          Apply
        </button>
      </div>
    </div>,
    document.body,
  );
}
```

(Tailwind class names follow the existing codebase conventions; if the project uses different tokens — e.g. `text-fg` not `text-ink` — adapt to match nearby components like `AddFieldPopover.tsx`. The mechanics matter; the exact tokens don't.)

- [ ] **Step 4: Run test to confirm pass**

```
cd app && bun run test test/manage-linked-fields-popover.test.tsx
```

Expected: 4 tests pass.

- [ ] **Step 5: Typecheck**

```
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/linked/ManageLinkedFieldsPopover.tsx \
       app/test/manage-linked-fields-popover.test.tsx
git commit -m "feat(app): ManageLinkedFieldsPopover picker

Multi-select for displayFields with always-on 'label', search,
inline 'lookups through another link not supported' tooltip on
linked target fields, and ordered Apply payload (label first)."
```

---

### Task 6: Wire FK column menu handlers in TablePane

**Files:**
- Modify: `app/src/components/TablePane.tsx`

This wires "Show linked fields…" to the popover (`Task 5`) and "Open target dimension →" to React Router navigation.

- [ ] **Step 1: Wire `onShowLinkedFields` handler in TablePane**

In `app/src/components/TablePane.tsx`, find where `<DataGrid ... />` is rendered. Add state for the picker:

```typescript
const [linkPicker, setLinkPicker] = useState<{
  fkField: string;
  anchorRect: DOMRect;
} | null>(null);
```

Add the handler, passing the column header's bounding box as the anchor:

```typescript
const handleShowLinkedFields = (fkField: string): void => {
  if (!canEdit) return;
  const headerEl = document.querySelector(`[data-header="${CSS.escape(fkField)}"]`);
  const rect = headerEl?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0);
  setLinkPicker({ fkField, anchorRect: rect });
};
```

Pass to `<DataGrid onShowLinkedFields={handleShowLinkedFields} />`.

- [ ] **Step 2: Render the popover when state is set**

Below the DataGrid render, add:

```tsx
{linkPicker && (() => {
  const fkField = dim.fields.find((f) => f.field === linkPicker.fkField);
  const target = targets.get(fkField?.referencedDimId ?? "");
  if (!fkField || !target) return null;
  return (
    <ManageLinkedFieldsPopover
      fkLabel={fkField.label}
      targetFields={target.allFields.map((f) => ({ field: f.field, label: f.label, type: f.type }))}
      current={fkField.displayFields ?? ["label"]}
      anchorRect={linkPicker.anchorRect}
      onCancel={() => setLinkPicker(null)}
      onApply={async (next) => {
        setLinkPicker(null);
        try {
          await updateFieldDisplayFields(dim.id, fkField.field, next);
        } catch (err) {
          pushToast("error", `Couldn't update linked fields: ${err instanceof Error ? err.message : String(err)}`);
        }
      }}
    />
  );
})()}
```

(`targets.get(...).allFields` may not exist exactly under that shape; adapt to whatever metadata TablePane already loads for linked targets. The signal is: feed the popover a `TargetFieldOption[]` derived from the target dim's fields.)

- [ ] **Step 3: Wire `onOpenTargetDimension` to navigate**

In TablePane, get the tenant slug + router navigation hooks (look for an existing `useNavigate()` or `Link to=` pattern — the rest of the app uses React Router v6). Then:

```typescript
const navigate = useNavigate();
const handleOpenTargetDimension = (fkField: string): void => {
  const f = dim.fields.find((x) => x.field === fkField);
  const target = f?.referencedDimId;
  if (!target) return;
  // tenant slug is in the URL — use the existing route helper if there is one.
  navigate(`../${encodeURIComponent(target)}`);
};
```

Pass to `<DataGrid onOpenTargetDimension={handleOpenTargetDimension} />`.

- [ ] **Step 4: Manual smoke test**

```
cd app && bun run dev
# In browser: open a dim with a linked field, right-click the FK column header
# → "Show linked fields…" opens the popover
# → "Open target dimension →" navigates to the target dim's table
```

- [ ] **Step 5: Run the full app suite**

```
cd app && bun run test
```

Expected: all tests pass.

- [ ] **Step 6: Typecheck**

```
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "feat(app): wire FK column menu (Show linked fields, Open target dim)"
```

---

### Task 7: Wire lookup column menu handlers in TablePane

**Files:**
- Modify: `app/src/components/TablePane.tsx`

- [ ] **Step 1: Add handlers for the four lookup actions**

```typescript
const handleManageLinkedFields = (lookupField: string): void => {
  const fkField = dim.fields.find(
    (f) => f.type === "linked" && lookupField.startsWith(`${f.field}__`),
  );
  if (!fkField) return;
  handleShowLinkedFields(fkField.field);
};

const handleChangeDisplayedField = (lookupField: string): void => {
  // For now, route to the same picker — Sec 3.2 says it's the same popover
  // scoped to swap the existing entry. Picker UX handles add/remove uniformly.
  handleManageLinkedFields(lookupField);
};

const handleRemoveLookup = async (lookupField: string): Promise<void> => {
  if (!canEdit) return;
  const fkField = dim.fields.find(
    (f) => f.type === "linked" && lookupField.startsWith(`${f.field}__`),
  );
  if (!fkField) return;
  const targetField = lookupField.slice(fkField.field.length + 2);
  const next = (fkField.displayFields ?? ["label"]).filter((d) => d !== targetField);
  try {
    await updateFieldDisplayFields(dim.id, fkField.field, next);
  } catch (err) {
    pushToast("error", `Couldn't remove lookup: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const handleJumpToSourceColumn = (sourceField: string): void => {
  // Scroll the FK column header into view and focus it.
  const headerEl = document.querySelector(`[data-header="${CSS.escape(sourceField)}"]`) as HTMLElement | null;
  if (headerEl) {
    headerEl.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    headerEl.focus();
  }
};
```

Pass all four to `<DataGrid />`:

```tsx
<DataGrid
  /* … existing props … */
  onChangeDisplayedField={handleChangeDisplayedField}
  onManageLinkedFields={handleManageLinkedFields}
  onRemoveLookup={handleRemoveLookup}
  onJumpToSourceColumn={handleJumpToSourceColumn}
/>
```

- [ ] **Step 2: Manual smoke test**

```
cd app && bun run dev
# Open a dim with displayFields already showing iso_code.
# Right-click the "↳ iso_code" column header → "Remove this lookup" → column disappears.
# Right-click again → "Manage linked fields…" opens the picker.
# Right-click → "Jump to source column →" focuses the FK column.
```

- [ ] **Step 3: Run the full app suite**

```
cd app && bun run test
```

Expected: pass.

- [ ] **Step 4: Typecheck**

```
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/TablePane.tsx
git commit -m "feat(app): wire lookup column menu actions"
```

---

### Task 8: FK delete confirmation + stale lookup header indicator

**Files:**
- Modify: `app/src/components/TablePane.tsx` (delete-column handler — wrap with confirmation)
- Modify: `app/src/components/datagrid/DataGrid.tsx` (header rendering — ⚠️ icon on `linkedStale: true`)

- [ ] **Step 1: Confirmation when deleting an FK column**

In `app/src/components/TablePane.tsx`, locate the existing `onDeleteColumn` handler. Wrap it:

```typescript
const handleDeleteColumn = async (field: string): Promise<void> => {
  const target = dim.fields.find((f) => f.field === field);
  if (target?.type === "linked") {
    const lookupCount = (target.displayFields ?? []).filter((d) => d !== "label").length;
    const ok = await confirm({
      title: `Delete "${target.label}"?`,
      body: lookupCount > 0
        ? `This will also remove ${lookupCount} linked column${lookupCount === 1 ? "" : "s"} that depend on it.`
        : `This will remove the linked column.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
  }
  await deleteFieldUnconditional(field); // the existing delete-field call already in TablePane
};
```

If the project has a confirm-dialog helper (look for `confirm-dialog.test.tsx` in `app/test/`), use that helper's API. Otherwise wire a small inline `<ConfirmDialog>` — match the existing project pattern.

- [ ] **Step 2: Render ⚠️ on stale lookup column headers**

In `app/src/components/datagrid/DataGrid.tsx`, find where column headers render (search for `data-header=`). Insert next to the label:

```tsx
{column.linkedStale && (
  <span
    className="ml-1 text-warning"
    title="Source field was renamed — reconfigure"
    aria-label="Stale lookup"
  >
    ⚠
  </span>
)}
```

(Adapt `text-warning` to the project's warning color token.)

- [ ] **Step 3: Manual smoke test**

```
cd app && bun run dev
# Right-click an FK column with 2 lookups → Delete column → confirmation lists "2 linked columns".
# In DB (psql), rename a target field; reload the source dim → lookup header shows ⚠ with tooltip.
```

- [ ] **Step 4: Run the full app suite**

```
cd app && bun run test
```

Expected: pass.

- [ ] **Step 5: Typecheck**

```
cd app && bun run typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/components/TablePane.tsx app/src/components/datagrid/DataGrid.tsx
git commit -m "feat(app): FK delete confirmation + stale-lookup header indicator"
```

---

## Self-Review (already run)

- **Spec coverage:** §1 model — Task 1 + 3. §2 menu branching — Task 4 + 6 + 7. §3 picker — Task 5. §4 naming — Task 3. §5 edge cases — partial: stale indicator in Task 8, null FK already rendered by existing LinkedCell (`—`). §6 API — Task 1. §7 permissions — `canEdit` gates in Tasks 6 + 7; audit log in Task 1. §10 acceptance — every bullet maps to a step.
- **Placeholder scan:** clean — all code provided in full.
- **Type consistency:** `ColumnDef.columnKind`, `sourceField`, `linkedStale` defined in Task 3 are used in Tasks 4–8. `updateFieldDisplayFields(dimId, field, next)` signature consistent across Tasks 2/6/7. `ManageLinkedFieldsPopover` props match between Task 5 and Task 6.
- **Ambiguity check:** "Change displayed field…" in Task 7 routes to the same popover (per Spec §3.2 — same picker, just emphasized differently). Acceptable for now; future task can split if the swap-mode warrants its own UI.

## Notes For The Implementer

1. **Optimistic-update consistency:** `updateFieldDisplayFields` (Task 2) currently just `refreshDim` after the PATCH. If you see the lookup columns flicker on Apply, port the optimistic helper pattern from `setFieldValue` (around `store.ts` line 1030) — patch the local field's `displayFields` immediately, fire the API, roll back on error.
2. **Tailwind tokens:** the popover (Task 5) uses tokens like `text-ink`, `bg-bg`, `border-line` — confirm these match what's in `AddFieldPopover.tsx` and adjust if your theme uses different names.
3. **Engineer mode:** per spec §4, the lookup column header tooltip should reveal `country__iso_code` (backing field name) when engineer mode is on. If you ship Task 3 without that detail, add it as a Task 3.5 follow-up using the existing `useEngineerMode()` pattern.
4. **Audit log naming:** action is `field.displayFields.update` (Task 1) — dashboard/activity feed components key off action strings; if the activity feed has a switch on known actions, add a case for `field.displayFields.update` rendering `"changed displayed fields on <field>"`.
