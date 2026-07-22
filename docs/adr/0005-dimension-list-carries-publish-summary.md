# The dimension list carries a per-table publish summary

The Overview dashboard shows every table's published version, when it was last published, and how far its working copy is ahead (unpublished changes = drafts + edited records, per ADR-0002). None of that lives on the `/dimensions?full=true` list today — it only exists in `PublishState`, fetched one table at a time. Rather than fan out N `fetchPublishState` calls on the workspace's most-visited page, or derive an approximation from the audit log (which carries no version number and nothing about edited records), we extend the list endpoint to return a compact publish summary per table: `{ version, publishedAt, pendingDrafts, changedRecords }`.

## Considered options

- **N per-table `fetchPublishState` on mount** — no server change, but an N+1 on the landing page that grows with table count.
- **Derive from loaded client data (drafts map + audit log)** — free, but structurally can't supply the version number or the edited-record count, so the dashboard would silently misreport a table with pending record edits as "level with dbt." Rejected because it reintroduces the exact bug the redesign set out to fix.

## Consequences

- The redesign is not purely client-side; the list endpoint and its server-side `PublishState` computation share a summary path.
- `changedRecords` is a count only; the actual `changedKeys` stay in the per-table `PublishState` for the table view. The dashboard never needs the keys, only the size of the delta.
- "Unpublished" and "Published" become sortable columns backed by real fields, not audit-log guesses.
