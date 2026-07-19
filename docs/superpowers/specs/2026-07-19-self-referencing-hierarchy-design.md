# Self-referencing hierarchy (parent pointer)

**Date:** 2026-07-19
**Status:** Approved — ready for implementation plan
**Scope:** P2 item from the create-table audit. Let a `linked` field target its
own table, so a record can point at another record in the same table as its
parent (City → Region → Country). Minimal parent pointer only.

## Goal

Unblock modelling a hierarchy inside one table by allowing a self-referencing
`linked` field, while guaranteeing the stored data is always a valid tree (no
cycles).

## Non-goals (explicitly out of scope this pass)

- No tree/indented view of records (the grid stays flat).
- No roll-ups / aggregation of child values to parents.
- No breadcrumbs or depth badges.
- No new field type, no schema/DDL change.

These can be built later on top of the parent pointer.

## Design

### 1. Storage (unchanged)

A "parent" is nothing new — it is a `linked` field whose target is its own
table. It is stored exactly like any linked field: a `VARCHAR` column on the
`dim_<id>` table holding the parent record's key, with
`field_config = { targetDimId: <self dimId>, displayFields: ["label"] }`. No
migration, no new column type.

### 2. Creation — unblock the self-target

- **Server:** `addField` (`server/src/repo-canonical.ts`, ~line 1204) currently
  rejects a self-target: `if (opts.referencedDimId === dimId) return null;`.
  Remove that early return. All other linked validations stay: the target must
  exist, and every `displayField` must exist on the target (for a self-link the
  target is the same table, so `"label"` and any own field qualify).
- **Client:** the link-target picker in `AddFieldPopover.tsx` filters out the
  current table (`allDims.filter((d) => d.id !== currentDimId)`). Include the
  current table as an option, labelled so it reads as self (e.g.
  `"<name> (this table)"`). Everything else about the linked-field form is
  unchanged.

### 3. Cycle enforcement (correctness core)

One guard, added to the existing `linked` branch of `setFieldValue`
(`server/src/repo-canonical.ts`, ~line 1542). This single point covers **both**
inline cell edits and CSV import, because `importCanonical` sets field values
through `setFieldValue`.

When the field being set is a self-link (`f.referencedDimId === dimId`) and the
new value (`fkValue`) is non-null:

1. Reject if `fkValue === key` (a record cannot be its own parent).
2. Reject if `key` is already an ancestor of `fkValue` — walk up `fkValue`'s
   parent chain via `WITH RECURSIVE` over the self-link column; if `key` appears,
   setting `key`'s parent to `fkValue` would close a loop.

Sketch (column names quoted via `qid`, values bound as params):

```sql
WITH RECURSIVE anc(p) AS (
  SELECT <parentCol> FROM <dimTable> WHERE <keyCol> = $1   -- $1 = fkValue
  UNION ALL
  SELECT d.<parentCol>
    FROM <dimTable> d
    JOIN anc ON d.<keyCol> = anc.p
   WHERE anc.p IS NOT NULL
)
SELECT 1 FROM anc WHERE p = $2 LIMIT 1;                    -- $2 = key (the record)
```

If the direct-self check trips, or the query returns a row, the set is a cycle.

On a cycle, `setFieldValue` throws `AppError("HIERARCHY_CYCLE", <message>, 422)`
naming the offending relationship, instead of the silent coerce-to-null that an
invalid FK gets today. This is a deliberate behaviour difference: an invalid FK
is "unknown key → clear it"; a cyclic parent is "valid key, illegal shape →
tell the user".

Termination: self-links were previously impossible (the guard in §2 blocked
them), so no pre-existing data can be cyclic and the recursion always
terminates. No defensive depth cap is required, though implementers may add a
`LIMIT`/depth guard if trivial.

### 4. Editing a parent (UI reuse)

A self-link is an ordinary linked cell, so it reuses the existing linked-cell
picker and candidate loading — no new editor is written. Two integration points
to verify during implementation:

- Candidate loading (`linkedTargets` / `buildLinkedColumns` in `TablePane.tsx`)
  resolves a target that **is** the current table (today targets are always
  other tables).
- A record is excluded from its own candidate list (you cannot parent yourself;
  the write-guard rejects it regardless, but the picker should not offer it).

### 5. Error handling

- Add `"HIERARCHY_CYCLE"` to the `ErrorCode` union (`server/src/errors.ts`).
- The client already surfaces coded errors: `apiInner` throws `ApiCodeError`
  with `code` + `details` (added during the required-fields work), so the grid /
  edit host can branch on `code === "HIERARCHY_CYCLE"` and show a clear message.
- CSV import behaviour: a cyclic parent in an imported file makes that
  `setFieldValue` throw, which aborts the import with the `HIERARCHY_CYCLE`
  message. This is intended — importing a loop is worse than a failed import the
  user can correct. (Records are inserted before field values are applied, so
  parent references resolve; only a genuinely cyclic file fails.)

## Touch points

| Change | File | Approx location |
|---|---|---|
| Allow self-target | `server/src/repo-canonical.ts` | `addField`, ~1204 |
| Cycle guard | `server/src/repo-canonical.ts` | `setFieldValue` linked branch, ~1542 |
| New error code | `server/src/errors.ts` | `ErrorCode` union |
| Include current table in picker | `app/src/components/AddFieldPopover.tsx` | link-target `<select>` |
| Self-target candidates + exclude-self | `app/src/components/TablePane.tsx` | `buildLinkedColumns` / `linkedTargets` |
| Client error surface | wherever linked-cell edits catch errors | branch on `HIERARCHY_CYCLE` |

## Testing

DB-backed integration tests in the existing `repo-canonical` / `repo-drafts`
test style (env-stub header, tenant + user setup, table cleanup):

1. **Valid chain holds** — create a table with a self-link "Parent"; set
   Denmark→Nordics, Nordics→Europe; assert the parents are stored.
2. **Cycle rejected** — attempt to set Europe's parent = Denmark; assert it
   throws `HIERARCHY_CYCLE` and Europe's parent is unchanged.
3. **Self-parent rejected** — set Europe's parent = Europe; assert
   `HIERARCHY_CYCLE`.
4. **Acyclic re-parent still works** — move France from Europe to Nordics;
   assert it succeeds.
5. **Non-self linked field unaffected** — a normal cross-table linked field
   still coerces an unknown FK to null (no cycle path taken).

## Risks / notes

- The behaviour split (invalid FK → null vs. cyclic parent → throw) is
  intentional and documented here so it is not "fixed" later by accident.
- CSV import aborting on a cyclic file is intended, not a regression.
- No schema change → nothing to migrate or roll back; the feature is inert until
  a user creates a self-linked field.
