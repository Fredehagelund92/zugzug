# Zugzug

Curation layer between a data warehouse and dbt: teams turn messy source values into approved records and maintain governed reference tables, exported as `dim_<x>` / `map_<x>` tables dbt joins directly.

## Language

Plain words first: a non-technical teammate — including non-native English
speakers — must understand every label without a glossary.

**Table**:
A curated list (country, channel, partner) with an approved set of records.
Materialized as a `dim_<x>` table for dbt. ("Dimension" survives only in the
dbt-facing `dim_`/`map_` output-table names — code and schema use
`reference_table`/`refTable`, per [ADR-0006](./docs/adr/0006-internal-names-match-the-interface.md).)
_Avoid_: dimension (user-facing), entity, master table

**Record**:
A single approved row in a table — a `key` + `label` pair plus attributes.
The thing source values map *to*. Qualify as "approved record" only where
ambiguity forces it.
_Avoid_: canonical record, golden record, master record

**Source value**:
A distinct string scanned from a registered warehouse column, awaiting
mapping. It comes from a source; hence the name.
_Avoid_: raw value, dirty value

**Mapping**:
The assignment of a source value to a record. Materialized in `map_<x>`
tables.
_Avoid_: match, matching, reconciliation, merge

**Draft**:
A mapping awaiting publish. Lives in app state, invisible to dbt.
Record edits are not drafted — they apply instantly to the working copy.
_Avoid_: staged (implementation term), pending

**Working copy**:
The current, editable state of a table (records + mappings + drafts)
as seen in the grid. Not yet what dbt consumes.

**Unpublished changes**:
The delta between a table's working copy and its last published version:
its drafts (mappings awaiting publish) plus the records edited since that
publish. Everything a single Publish would fold into the next version.
A table with zero unpublished changes is level with dbt.
_Avoid_: staged, pending, dirty, diff

**Publish**:
The single act that folds drafts and record edits into a new numbered
table version (v17 → v18) and materializes it for dbt.
_Avoid_: commit, staged (internal implementation terms), merge, sync

**Review**:
The cross-table inbox of unmapped source values, ordered by frequency.
_Avoid_: triage, workbench, inbox, queue

**Workspace**:
A switchable tenant (like a Linear team) holding its own tables, sources,
and members.
_Avoid_: tenant (implementation term), organization

**Source**:
A registered warehouse column that Zugzug scans for distinct source values.

**Warehouse adapter**:
The interface through which Zugzug reads (and optionally writes) a specific
warehouse technology.
