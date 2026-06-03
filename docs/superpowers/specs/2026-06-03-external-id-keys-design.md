# External-ID keys with live-resolved names

**Date:** 2026-06-03
**Status:** Approved design, pending implementation plan
**Repo:** trust-me-bro (Zug Zug)

## Problem

A master table (dimension) keyed by a human-readable slug works when the canonical
identity *is* the name. But sometimes the canonical identity is an opaque external
identifier from the warehouse — e.g. `partner_id` — and the name is a separate
attribute. Users still need to *see the name* next to the ID to know what they are
mapping toward, even though the relationship is stored against the ID.

The governing principle: **store the ID, render the name.** The ID is the stable
link (IDs don't change); the name is a projection for humans, never the stored
source of truth for the relationship.

## Decisions (locked during brainstorming)

1. **The key column itself is an external ID.** This is a property of the dimension:
   its canonical identity is a real warehouse ID (e.g. `partner_id`), not a
   name-derived slug.
2. **Names are resolved live from the warehouse.** The canonical row stores only the
   ID. The name is joined in from the warehouse source on read — always fresh, no
   second source of truth. (Rejected: snapshot-at-derive, and snapshot-with-resync.)
3. **Unresolvable names show the raw ID, flagged "unresolved."** When the warehouse
   is detached (`ATTACH_WAREHOUSE` off) or the ID no longer exists in the source, the
   grid shows the key in mono with a subtle "unresolved" badge — honest, never a fake
   name. (Rejected: cached last-known name; plain ID with no flag.)

## Current state (ground truth)

- `dim_<x>` is `(<keyCol> VARCHAR PRIMARY KEY, label VARCHAR NOT NULL)` plus enrichment
  columns ALTERed in (`repo.ts:346`, `addDimension`).
- `deriveCanonical` reads **one** warehouse column, slugs it into `key`, and copies the
  same value into `label` (`repo.ts:197-225`).
- `getDimension` reads the display name straight from the stored `d.label` column
  (`repo.ts:290-298`).
- The DuckDB connection ATTACHes both Postgres (canonical `dim_/map_` + app state) and
  the MotherDuck warehouse, so a single query can join across them (`ARCHITECTURE.md`,
  the "bridge"). Warehouse access is gated by `env.attachWarehouse`.
- `CanonicalValue` shape: `{ key, label, variants?, fields? }` (`repo.ts:15`).

## Design

### 1. Dimension gains `key_kind` + a name binding

New **nullable** columns on the `dimension` registry table (`schema.ts:23`):

| Column | Meaning |
|---|---|
| `key_kind` | `'slug'` (default, current behavior) or `'external_id'` |
| `name_table` | warehouse table holding the names (external_id only) |
| `name_id_col` | column in `name_table` to join `key` against |
| `name_col` | column in `name_table` to display as the name |

For an `external_id` dimension, the `dim_` table is created with `label` **nullable**
(unused — names live in the warehouse). `key` holds the raw ID `CAST(... AS VARCHAR)`,
**not** a slug.

Backfill: existing dimensions get `key_kind = 'slug'`; their behavior is unchanged.

### 2. Read path resolves the name live

`getDimension`'s canonical query (`repo.ts:290`) branches on `key_kind`:

- `slug` → unchanged: project `d.label`.
- `external_id` → `LEFT JOIN <warehouse>.<name_table> w ON CAST(w.<id_col> AS VARCHAR)
  = d.<key>`, projecting `w.<name_col>` as the label and `w.<id_col> IS NULL` as an
  `unresolved` flag. When `env.attachWarehouse` is false, skip the join entirely →
  every row is `unresolved`.

`CanonicalValue` gains `unresolved?: boolean`. For unresolved rows, `label` falls back
to the key string.

The join is **batched** (one query loads the whole list with names) — never per-row —
honoring the cost rule "never round-trip the warehouse per UI interaction."

### 3. Derive captures the binding

`deriveCanonical` for an `external_id` dimension takes **two** columns:
`id_col → key` (no slugging) and `name_col`. It records the name binding
(`name_table`, `name_id_col`, `name_col`) on the registry. The crosswalk `map_` still
maps raw→key as today.

### 4. UI honors "store the ID, render the name" (`MasterTables.tsx`)

- Resolved → name in bold + ID in mono (unchanged, lines 197-200).
- `unresolved` → ID in mono + a subtle **"unresolved"** badge, no fake name.
- **Rename disabled** for `external_id` dimensions — the name isn't ours to edit
  (`renameCanonical` `repo.ts:394`; button at `MasterTables.tsx:206`).
- The "New canonical … / slug-from-label" add-row (lines 234-238) is **hidden** for
  these dimensions in v1 (deriving from the source is the path that makes sense for
  external IDs). Manual add-by-ID is a follow-up.

## Out of scope (v1) — follow-ups

- **Value-mapping screen** target picker showing live names for external-ID dimensions.
- **Commit path** label handling: drafts carry a snapshotted `target_label`
  (`repo.ts:500-507`, `commit` at 516-555). For external-ID dimensions we would store
  `key` only and resolve the name on display. Not built in v1.

## Testing

- `getDimension` on an `external_id` dimension: resolved names project from the join;
  rows whose `key` is absent in the warehouse return `unresolved = true`; with
  `attachWarehouse` off, all rows are `unresolved` and label falls back to key.
- `deriveCanonical` two-column path: keys are raw IDs (not slugged), name binding is
  persisted, crosswalk maps raw→id-key.
- `slug` dimensions are entirely unaffected (regression).
- UI: rename and slug-add affordances are absent for `external_id` dimensions; the
  "unresolved" badge renders when `unresolved` is set.
