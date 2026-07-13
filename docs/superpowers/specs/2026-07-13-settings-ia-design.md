# Settings IA Consolidation — Design

Sub-project C, the last of the post-UX-review decomposition (A: cleanup ✓ merged → B: publish lifecycle ✓ merged → **C: settings IA**). Resolves review finding IA-001 (three parallel settings shells with no cross-navigation). Maintainer chose the **two-trees** model 2026-07-13.

## Goal

One predictable workspace-settings tree (workspace config + integrations) and one small account tree (personal preferences), cross-linked — instead of three sibling shells that never reference each other.

## The chosen model (over alternatives)

**Workspace + Account, two trees.** Integrations fold INTO workspace settings — webhooks, service accounts, and the pull API are workspace-scoped configuration and belong there. Account (profile, appearance, memberships) stays its own small tree reached from the existing avatar-menu "Account settings" entry — personal scope never mixes into the workspace list (the Linear/GitHub pattern, matching this app's workspaces-as-teams model). Rejected: everything-in-one-tree (mixes scopes) and cross-tabs-over-three-shells (papers over the split).

## Design

### D1 — Routes (app/src/main.tsx)

Inside the existing `settings` route group (`SettingsLayout`), add:
- `pull-api` → `<PullApi />`
- `webhooks` → `<Webhooks />`
- `webhooks/:id` → `<WebhookDetail />`
- `service-accounts` → `<ServiceAccounts />`

The `integrations` route group becomes redirects only (then the `IntegrationsLayout` element is dropped):
- `integrations` → `../settings/pull-api`
- `integrations/pull-api` → `../../settings/pull-api`
- `integrations/webhooks` → `../../settings/webhooks`
- `integrations/webhooks/:id` → **param-preserving** redirect to `settings/webhooks/:id` (a tiny redirect component reading `useParams` — `<Navigate>` alone cannot carry `:id`)
- `integrations/service-accounts` → `../../settings/service-accounts`

Existing ghost redirect `settings/tokens` retargets to `../service-accounts` (sibling, one hop, no double redirect through the old integrations path).

### D2 — One workspace sidebar (components/settings/SettingsSidebar.tsx)

Sections with the house uppercase-kicker style (same visual language as elsewhere):
- **Workspace**: General, Members, Mapping, Warehouse
- **Integrations**: Pull API, Webhooks, Service accounts
- **Danger**: Danger zone

Ordering keeps today's items in today's relative order; the Integrations section slots between Workspace and Danger. Delete `routes/integrations/IntegrationsLayout.tsx` and any integrations-only sidebar component; the four pages render under `SettingsLayout` unchanged internally (their own permission gates — `integrations.*` actions in permissions.ts — stay as they are; no permission changes).

### D3 — Cross-links (the IA-001 fix proper)

- Workspace sidebar footer: "Your account →" linking to `account/profile`.
- `AccountSidebar` footer: "Workspace settings →" linking to `settings/general`.
Both use the sidebars' existing link styling; nothing else about AccountSidebar changes.

### D4 — Nav and command palette (components/AppShell.tsx)

- The "Integrations" nav item retargets `navLinks.integrations` → the new `settings/webhooks` path (or the nav item's `to` changes directly — whichever the navLinks helper makes cleaner; read `use-tenant-navigate.ts` first). Label unchanged.
- Command-palette entries for the moved pages update their `action` targets; keywords unchanged.
- The Members / Warehouse / Preferences / Sources shortcuts stay exactly as they are — deep links into one tree are now coherent shortcuts, not evidence of a split.

### D5 — Out of scope (YAGNI, stated)

No visual restyle; no account-tree changes beyond the one footer link; no permission model changes; no renaming of the `integrations.*` permission action strings or component file paths under `routes/integrations/` (files stay where they are — only routing and layout change; moving files is churn without user value).

## Error handling / edges

- Old URLs (bookmarks, webhook detail links in emails/docs) land on redirects — including the parameterized webhook-detail case.
- A user ON an integrations page mid-session when the app updates: their current URL redirects on next navigation; no dead ends.
- The `settings/tokens` redirect no longer chains through a second redirect.

## Testing

- Route tests: each old `integrations/*` URL (including `webhooks/:id` with a real id) resolves to the new settings path with params intact.
- Sidebar test (`settings-sidebar` test file exists): asserts the three section headers and the Integrations items; asserts the account cross-link renders.
- Existing Webhooks/PullApi/ServiceAccounts/WebhookDetail tests: paths updated, behavior assertions unchanged (no weakening).
- Full bar: app typecheck + test + lint all clean (79 files / 1 skip baseline), server suite untouched (no server changes — assert by diff, not by run).

## Execution intent

Plan via writing-plans; subagent-driven: haiku/sonnet implementers (~6 tasks, mostly mechanical route/sidebar work), one opus/fable whole-branch review. Merge-on-green pre-authorization follows the sub-project A precedent (small, UI-only, fully redirect-compatible) — the run merges on a clean final review unless the maintainer objects at plan approval.
