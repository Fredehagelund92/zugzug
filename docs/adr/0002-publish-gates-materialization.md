# Publish gates materialization, not editing

For the reference-table surface (ADR-0001) we had to decide what "publish" gates. Canonical-record edits stay instant in Zugzug's working copy — the Sheets-like feel is the UX bar — and **publish** is the single act that folds staged mappings and canonical edits into a new numbered dimension version (vN) and materializes it to the warehouse/export. What dbt consumes is always the last published version.

The rejected alternative was staging every canonical edit as a draft requiring approval before it touches the table (the mockup's literal reading). That would double the review machinery and make cell edits feel heavy; role gating already controls who can edit. The "changes in review" panel is therefore *derived* (everything touched since the last publish), not a staging queue.

## Consequences

- "Commit" disappears from the user-facing language; the existing commit transaction and per-dimension monotonic version counter (`dimension.committed` outbound events) become the internal implementation of publish.
- Governance reuses the existing role model (publish stays role-gated); mandatory four-eyes review is not required and can be added later without changing the model.
- No row-level snapshots per version — rollback/revert remains issue #45's scope.
