# Publish Lifecycle — Design

Sub-project B of the post-UX-review work (A: cleanup/hardening ✓ merged → **B: publish lifecycle** → C: settings IA). Decisions made with the maintainer 2026-07-12.

## Goal

Complete the publish story: every publish is restorable (rollback), reviewable (four-eyes inbox), and exact (what the preview shows is precisely what publishes). Together these close the three governance gaps deferred from the UX-review branch.

## Decisions (maintainer-approved)

1. **Rollback = snapshot + republish.** Each publish stores a content snapshot; rolling back republishes an older snapshot as a NEW version. History is immutable. The working copy is also reset to the restored content; staged drafts are preserved.
2. **Review inbox = lightweight.** A surface listing others' staged drafts; reviewer publishes or rejects-with-reason. No approval states beyond `rejected`, no request-review step, no notifications, no comments.
3. **Rollback is admin-only**, with typed confirmation. The four-eyes flag does not additionally gate rollback.

## Design

### D1 — Data model

- New table `dimension_version` (app schema, Drizzle migration): `id`, `tenant_id`, `dim_id`, `version` (int), `kind` (`'publish' | 'rollback'`), `restores_version` (int, null), `snapshot` (jsonb), `published_by` (user id), `created_at`. Unique on `(tenant_id, dim_id, version)`. RLS + `tenant_iso` policy like every tenant-scoped table.
- `snapshot` shape: `{ records: [{key, label, position, fields: {...}}], mappings: [{raw, targetKey}] }` — exactly what is needed to reconstruct the working copy and re-materialize. Reference tables are small; snapshots are KBs.
- Drafts gain `rejected` in the status domain plus `rejected_reason text` and `rejected_by` columns (migration). Existing statuses (`mapped`, `skipped`) unchanged.
- **Limitation stated in UI:** versions published before this feature have no snapshot; the version list shows them but rollback is disabled with the reason "published before version history existed".

### D2 — Commit-by-draft-list

- `commit(dimId, userId, tenantId, draftKeys?: string[])` — `draftKeys` are the raw values of the drafts to fold (drafts are keyed per (dim, raw)). When present: fold ONLY those drafts (validated: each exists, `status='mapped'`, `target_key` non-null, belongs to this dim/tenant; unknown keys → 400 VALIDATION_FAILED, nothing folded). When absent: fold all mapped drafts (back-compat: auto-publish scheduler, API-token publishes).
- The PublishPreviewDialog (both TablePane and Review surfaces) passes exactly the draft keys it is displaying at Confirm time. This closes the preview-snapshot-vs-live-commit gap: drafts staged after the preview opened are NOT swept into the publish.
- Record edits always ride along — per ADR-0002 they are already the working copy. The preview's existing "record edits already in the working copy" copy stands.
- The snapshot write (D1) happens inside the same commit transaction, after the fold, capturing the just-published content.
- Four-eyes gate unchanged in semantics, but its draft scope narrows to the folded set: with `draftKeys`, only those drafts must be non-self-authored.

### D3 — Review inbox

- Location: a distinct "Awaiting review" section at the top of the Review page (`/app/:slug/triage` route, page titled "Review"), rendered only when it has content, with its own count in the section header. The nav badge keeps its existing unmapped count — no nav change.
- Content: staged (`mapped`) drafts NOT authored by the viewer. System drafts (`u_system`, from rescans) are included — they need a human publisher — grouped under "System (rescan)". Grouping: table → author, with source value → target label rows, timestamps, AI/user provenance.
- Actions per selection: **Publish** — opens the existing PublishPreviewDialog scoped to the selected drafts, confirm runs the draft-scoped commit. **Reject** — required reason (one field), sets `status='rejected'` + reason + reviewer via new endpoint.
- Rejected drafts: appear in the author's Review list with a danger-tinted "rejected: <reason>" badge; author can re-stage (returns to `mapped`, clearing rejection fields) or discard (existing discard).
- Permissions: viewers see the section read-only (no actions); editors and admins can publish/reject others' drafts. Publishing from the inbox naturally satisfies the four-eyes gate.
- Endpoint: `POST /api/dimensions/:id/drafts/reject` `{raws: string[], reason: string}` — gated `curate`; reviewer identity recorded; rejecting your own draft is allowed (self-retraction with note).

### D4 — Rollback

- UI: the table's publish/history panel gains a version list from `dimension_version` (version, kind, publisher, date, counts). Each snapshotted version except the latest offers "Roll back to vN" — visible to admins only.
- Confirm dialog: typed confirmation (`v<N>`), summary of the delta (records: X now vs Y in vN; mappings: A vs B), and the sentence "This publishes a new version v<latest+1> with vN's content. Staged drafts are kept."
- Server: `POST /api/dimensions/:id/rollback` `{toVersion}` — gated on the requester's tenant role being exactly `admin` (an explicit role check like the workspace-delete gate, not an op-string check). In ONE transaction: load snapshot (404 if none), replace working-copy records+mappings with snapshot content, leave drafts untouched, then run the standard commit path with `kind='rollback'`, `restores_version=toVersion` (which also writes the new version's own snapshot). Serializes with concurrent publishes on the existing per-dimension commit path.
- Rollback of a rollback: naturally supported (it's just another snapshotted version).
- Drafts referencing records removed by the rollback: remain staged; the existing publish-time validation handles dangling targets.

### D5 — Events / downstream sync

Webhooks are the general integration surface for OTHER SYSTEMS syncing data and events (dbt itself just reads the published tables). No new event type: the existing `dimension.committed` outbound event gains additive fields `kind: 'publish' | 'rollback'` and `restores_version?: number`. Consumers that ignore the new fields observe a normal publish — which is exactly what a rollback is, materially. Webhook docs UI (PullApi/Webhooks pages) updated to document the two fields.

### D6 — Out of scope (YAGNI, stated)

Snapshot retention/compaction; notifications; draft comments; approval-then-publish two-step; per-record revert UI (issue #45's finer grain — the version list supersedes its broad case); backfilling snapshots for historical versions.

## Interfaces (cross-cutting contracts)

- `commit(dimId, userId, tenantId, draftKeys?)` — extended, back-compatible.
- `POST /api/dimensions/:id/drafts/reject {raws, reason}`; draft status domain += `rejected`.
- `POST /api/dimensions/:id/rollback {toVersion}` → same response shape as commit + `{restoredVersion}`.
- `GET /api/dimensions/:id/versions` → `[{version, kind, restoresVersion, publishedBy, at, counts, hasSnapshot}]`.
- Outbound `dimension.committed` += `{kind, restoresVersion?}` (additive).
- Client store: `fetchVersions`, `rollback`, `rejectDrafts`, draft type += rejection fields.

## Error handling

- Rollback to a snapshotless version → 409 `NO_SNAPSHOT` with the UI-stated reason.
- Rollback concurrent with a publish → second operation sees the new latest version; version list refreshes; no torn state (single transaction each).
- Reject with empty reason → 400 (reason required — it is the whole point).
- Draft-scoped commit with a stale key (draft discarded meanwhile) → 400 listing the missing keys; the preview refreshes.

## Testing

- Server: snapshot round-trip (publish → mutate working copy → rollback → working copy AND materialization equal snapshot); draft-scoped commit folds exactly the given keys and rejects stale/foreign keys; four-eyes narrows to the folded set; reject endpoint (status, reason, reviewer; empty-reason 400); rollback admin gate; NO_SNAPSHOT path; outbound event carries kind/restores_version.
- App: inbox renders others'+system drafts grouped correctly and hides for authors-only content; reject flow round-trip with badge; re-stage clears rejection; version list disables snapshotless rollback; preview passes displayed keys on confirm.

## Execution intent

Plan via superpowers:writing-plans, executed subagent-driven: sonnet implementers (server + UI), haiku for copy-level steps, opus reviewers on every governance-touching diff, Fable whole-branch judge. Merge-on-green pre-authorization NOT assumed for this one — publish semantics deserve the maintainer's morning look; the run stops at the report unless the maintainer says otherwise at plan approval.
