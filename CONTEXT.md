# Zugzug

Curation layer between a data warehouse and dbt: teams turn messy raw values into canonical dimensions and maintain governed reference tables, exported as `dim_<x>` / `map_<x>` tables dbt joins directly.

## Language

**Dimension**:
A curated entity type (country, channel, partner) with a canonical set of records. Materialized as a `dim_<x>` table.
_Avoid_: entity, table, list

**Canonical record**:
A single approved row in a dimension — a `key` + `label` pair plus attributes. The thing raw values map *to*.
_Avoid_: golden record, master record

**Raw value**:
A distinct string scanned from a registered warehouse column, awaiting mapping.
_Avoid_: source value, dirty value

**Mapping**:
The assignment of a raw value to a canonical record. Materialized in `map_<x>` tables.
_Avoid_: match, reconciliation, merge

**Reference table**:
A dimension curated as a maintained list in its own right (e.g. Country), with an owner and published versions — rather than emerging only from mapping raw values.
_Avoid_: lookup table, master list

**Draft**:
A staged mapping assignment awaiting publish. Lives in app state, invisible to dbt. Canonical-record edits are not drafted — they apply instantly to the working copy.

**Working copy**:
The current, editable state of a dimension (canonical records + mappings + staged drafts) as seen in the grid. Not yet what dbt consumes.

**Publish**:
The single act that folds staged drafts and canonical edits into a new numbered dimension version (v17 → v18) and materializes it for dbt.
_Avoid_: commit (internal implementation term), merge, sync

**Unpublished changes**:
Everything touched in the working copy since the last publish — derived, not a staging queue.
_Avoid_: pending drafts (drafts are only the mapping subset)

**Triage**:
The cross-dimension inbox of unmapped raw values, ordered by frequency.
_Avoid_: inbox, queue

**Workspace**:
A switchable tenant (like a Linear team) holding its own dimensions, sources, and members.
_Avoid_: tenant (implementation term), organization

**Source**:
A registered warehouse column that Zugzug scans for distinct raw values.

**Warehouse adapter**:
The interface through which Zugzug reads (and optionally writes) a specific warehouse technology.
