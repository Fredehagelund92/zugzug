# Internal names match the interface

The UI settled long ago on plain words — a curated list is a **table**, an approved row is a **record**, a change awaiting publish is a **draft** — and the Language rule (CLAUDE.md, CONTEXT.md) bans the build-era vocabulary from anything a user sees. The database and server never followed. The core entity is still `dimension` (table `dimension`, ~10 `dim_id` foreign keys, plus `dimension_source` / `dimension_field` / `dimension_version`), and an approved row is still `canonical` (`canonical_version`, `repo-canonical.ts`, the `Canonical*` types and `/api/dimensions` routes). None of this reaches users, but it taxes every contributor — the schema says one thing, the screen another — and it is the first vocabulary a new contributor reads. Before the first public release we rename the internal entity `dimension → reference_table` and `canonical → record`, across schema **and** code, in one sweep. The published `dim_<x>` / `map_<x>` output tables are explicitly **not** renamed.

We do this now because the cost is asymmetric. Code-identifier renames cost the same whenever they happen; schema renames get monotonically more expensive as migrations and real self-hosted data accrete. Pre-launch the only installs are throwaway demo data, so the schema rename is one migration nobody has to nurse — deferring it just conscripts every future self-hoster into an upgrade migration we can avoid entirely by moving before anyone depends on the old names.

Two alternatives were rejected. **`dimension → table`** (matching the UI word literally) collides with an already-overloaded term — SQL tables, Postgres tables, the ORM's `app.table()` builder, the `dim_table` / `map_table` columns — so we use `reference_table`, which matches the UI's own "reference table" and stays unambiguous in code. **Keeping `dimension` internally** as legitimate Kimball/warehouse vocabulary is defensible, but a half-rename (only `canonical`) would leave the single largest term diverged from the product's language, defeating the point.

`dim_<x>` / `map_<x>` stay untouched for three converging reasons: they are a **dbt-facing contract** — the names appear verbatim in users' SQL joins; `dim_` is **correct Kimball vocabulary**, so `table_partner` would be less clear, not more; and they name a genuinely different thing (the materialized crosswalk + record output) from the internal `reference_table` entity, so keeping them introduces no inconsistency. Their delivery is settled separately in [ADR-0007](./0007-publish-is-pull-first.md).

## Decided mapping

The core renames; everything else follows the same rule.

| Today | Becomes | Notes |
|---|---|---|
| entity / table `dimension` | `reference_table` | plus `dimension_source` → `reference_table_source`, `dimension_field` → `reference_table_field`, `dimension_version` → `reference_table_version` |
| FK column `dim_id` (~10 tables) | `reference_table_id` | the bulk of the migration |
| `canonical_version` | `record_version` | |
| scan tables `dim_scan_value`, `dim_scan_occurrence` | `source_scan_value`, `source_scan_occurrence` | they hold scanned **source values**, not records — this aligns them with the UI term |
| `repo-canonical.ts`, `Canonical*` / `Dimension*` types & functions | `repo-record.ts`, `Record*` / `ReferenceTable*` | pure code refactor |
| REST + Pull API: `/api/dimensions`, `canonical` wire keys | `/api/tables`, `record` wire keys | standardizes on the UI word; `/api/tables/:id/...` routes already exist, so this removes an existing `tables`-vs-`dimensions` split. Safe pre-launch (no external API consumers) |
| **`dim_<x>` / `map_<x>` output tables** | **unchanged** | dbt contract + Kimball; see above |
| **`dim_table` / `map_table` columns** (store the output names) | **unchanged** | they reference the tables that keep their names |
| **`map_<x>.raw` column** | **unchanged** | the same dbt-facing argument as `map_<x>` itself: users join on it in their own SQL (`left join map_country m on m.raw = o.shipping_country` — README, [first mapping](../../docs-site/content/docs/first-mapping.mdx)), so renaming it breaks queries we do not control. "raw" stays banned in UI copy; the source value is a **source value** on screen |

## Consequences

- **One sweep, schema + code + wire together**, so the database and code never diverge into a half-renamed state. This is deliberately the larger single diff rather than a staged rename.
- **Migration by rename, not squash.** A single `ALTER TABLE … RENAME` / `RENAME COLUMN` migration on top of the existing history, so the handful of current demo installs upgrade cleanly; we do not rewrite the 39-migration baseline. Drizzle `schema.ts` export names and relations move to match.
- **Prior ADRs (0001, 0002, 0005) keep their original `dimension` / `canonical` wording** as a historical record of decisions as made at the time. Only new and living docs adopt the new words.
- The same sweep scrubs the remaining user-facing-doc leaks — `ARCHITECTURE.md` "master store", `CONTEXT.md` "canonical" — flagged during the go-live review.
- The Language rule is extended in spirit: the banned words are banned in schema and code identifiers too, not only in UI strings.
