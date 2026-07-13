# Settings IA Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two settings trees — workspace settings absorbing integrations, account staying separate — cross-linked, with all old URLs redirecting (spec: `docs/superpowers/specs/2026-07-13-settings-ia-design.md`).

**Architecture:** Routing-only restructure: the four integrations pages mount under the existing `SettingsLayout`; the `integrations/*` group becomes redirects (one param-preserving component for `webhooks/:id`); `SettingsSidebar` gains sections + an account cross-link; `navLinks.integrations*` values retarget (nav + palette follow automatically). No visual redesign, no permission changes, page component files stay in `routes/integrations/`.

**Tech Stack:** React Router v6, React + TS, vitest.

## Global Constraints

- Old URLs must keep working: `integrations`, `integrations/pull-api`, `integrations/webhooks`, `integrations/webhooks/:id` (param preserved!), `integrations/service-accounts` all redirect to their `settings/*` equivalents; `settings/tokens` retargets to `../service-accounts` (no redirect chains).
- No permission changes: the `integrations.*` action strings and each page's own gates stay untouched.
- Page component files stay in `app/src/routes/integrations/` — only `IntegrationsLayout.tsx` (and its sidebar, if separate) is deleted.
- Copy glossary: sidebar section labels are exactly "Workspace", "Integrations", "Danger"; cross-links "Your account →" / "Workspace settings →".
- Bar after every task: `cd app && bun run typecheck && bun run test && bun run lint` all clean (baseline 79 files passed / 1 skipped). Server untouched (assert by diff).
- Commits: conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Branch `settings-ia` off main.
- Merge-on-green IS authorized: clean final whole-branch review → merge to main locally, no push.

---

### Task 1: Routes — integrations under settings, redirects behind `[sonnet]`

**Files:**
- Modify: `app/src/main.tsx` (settings group ~line 115-131; integrations group ~line 132-139; drop the `IntegrationsLayout` import at line 31)
- Create: `app/src/routes/integrations/WebhookDetailRedirect.tsx`
- Delete: `app/src/routes/integrations/IntegrationsLayout.tsx` (check first whether it embeds or imports a sidebar component used nowhere else — delete that too; `grep -rn "IntegrationsSidebar" app/src`)
- Test: `app/test/settings-ia-redirects.test.tsx`

**Interfaces:**
- Produces: new route paths `settings/pull-api`, `settings/webhooks`, `settings/webhooks/:id`, `settings/service-accounts` (Tasks 2–4 link to them).

- [ ] **Step 1: Failing redirect tests** (`app/test/settings-ia-redirects.test.tsx`) — follow the app's existing route-test harness style (see `app/test/audit-route.test.tsx` for the MemoryRouter + mocked store pattern; reuse its mock shape):

```tsx
// Four cases, all rendering the app's route tree at an old URL inside a
// MemoryRouter and asserting the destination page's heading renders:
it("integrations/pull-api redirects to settings/pull-api", ...);
it("integrations/webhooks redirects to settings/webhooks", ...);
it("integrations/webhooks/:id redirects preserving the id", ...);   // assert WebhookDetail renders for that id (mock its fetch as the existing WebhookDetail tests do)
it("integrations/service-accounts redirects to settings/service-accounts", ...);
```

- [ ] **Step 2: Run → FAIL** (`cd app && bun run test -- settings-ia-redirects`).
- [ ] **Step 3: Param-preserving redirect** (`app/src/routes/integrations/WebhookDetailRedirect.tsx`):

```tsx
import { Navigate, useParams } from "react-router-dom";

/** integrations/webhooks/:id → settings/webhooks/:id — <Navigate> alone
 *  cannot carry a path param, so this tiny component reads it. */
export function WebhookDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`../../settings/webhooks/${id}`} replace />;
}
```

- [ ] **Step 4: Rewire main.tsx.** Inside the `settings` route group, after the existing entries, add:

```tsx
<Route path="pull-api" element={<PullApi />} />
<Route path="webhooks" element={<Webhooks />} />
<Route path="webhooks/:id" element={<WebhookDetail />} />
<Route path="service-accounts" element={<ServiceAccounts />} />
```

Retarget the tokens ghost (line ~121): `<Navigate to="../../integrations/service-accounts" replace />` → `<Navigate to="../service-accounts" replace />`.

Replace the whole `integrations` group with redirects (no layout element):

```tsx
<Route path="integrations">
  <Route index element={<Navigate to="../settings/pull-api" replace />} />
  <Route path="pull-api" element={<Navigate to="../../settings/pull-api" replace />} />
  <Route path="webhooks" element={<Navigate to="../../settings/webhooks" replace />} />
  <Route path="webhooks/:id" element={<WebhookDetailRedirect />} />
  <Route path="service-accounts" element={<Navigate to="../../settings/service-accounts" replace />} />
</Route>
```

Remove the `IntegrationsLayout` import; delete the file (+ orphaned sidebar if any).

- [ ] **Step 5: Run → PASS; full bar clean. Commit** (`feat(settings): integrations pages move under settings with redirects`).

---

### Task 2: Sidebars — sections + cross-links `[sonnet]`

**Files:**
- Modify: `app/src/components/settings/SettingsSidebar.tsx`, `app/src/components/settings/AccountSidebar.tsx`
- Test: extend `app/test/settings-sidebar.test.tsx`

**Interfaces:**
- Consumes: Task 1's `settings/*` paths; `integrations.pull_api.view` / `integrations.webhooks.view` / `integrations.service_accounts.view` actions (already in permissions.ts — verify names by reading its Action union).

- [ ] **Step 1: Failing tests** — extend `settings-sidebar.test.tsx` (read it first; it mocks tenant role):

```tsx
it("renders Workspace, Integrations and Danger sections", ...);      // three section kickers
it("Integrations section lists Pull API, Webhooks, Service accounts", ...);
it("renders the account cross-link", ...);                            // link "Your account →"
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Restructure SettingsSidebar.** Replace the flat `ITEMS` + single "Workspace" kicker with sections, reusing the existing item-rendering JSX unchanged (extract it to a local `SideItem` function so each section maps over it):

```tsx
const SECTIONS: { label: string; items: Item[] }[] = [
  {
    label: "Workspace",
    items: [
      { label: "General", to: "general", action: "settings.general.view", Icon: IconSettings },
      { label: "Members", to: "members", action: "settings.members.view", Icon: IconUsers },
      { label: "Mapping", to: "mapping", action: "settings.matching.view", Icon: IconWand },
      { label: "Warehouse", to: "warehouse", action: "settings.warehouse.view", Icon: IconDatabase },
    ],
  },
  {
    label: "Integrations",
    items: [
      { label: "Pull API", to: "pull-api", action: "integrations.pull_api.view", Icon: IconIntegrations },
      { label: "Webhooks", to: "webhooks", action: "integrations.webhooks.view", Icon: IconIntegrations },
      { label: "Service accounts", to: "service-accounts", action: "integrations.service_accounts.view", Icon: IconUsers },
    ],
  },
  {
    label: "Danger",
    items: [{ label: "Danger", to: "danger", action: "settings.danger.leave", Icon: IconOctagonAlert }],
  },
];
```

Each section renders the existing kicker div (label + hairline) then its visible items; a section whose items are ALL permission-filtered renders nothing (no orphan kicker). Icon choices: reuse `IconIntegrations` from Icons (AppShell imports it — check the export name); if a distinct webhook/api icon exists in Icons.tsx prefer it, else IconIntegrations for all three is fine.

Footer cross-link after the sections (styling: reuse the item row classes minus the active state):

```tsx
<div className="mt-4 border-t border-line pt-3">
  <NavLink to="../account/profile" className="flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm text-ink-2 hover:text-ink hover:bg-hover rounded-sm">
    Your account →
  </NavLink>
</div>
```

(Verify the relative path resolves from the settings layout — the sidebar renders under `/app/:slug/settings/*`, so `../account/profile` may resolve against the current leaf; safer: build it from `useNavLinks().base` + `/account/profile` — the sidebar already imports tenant context; choose whichever the router actually resolves correctly and assert it in the test via the link's href.)

- [ ] **Step 4: AccountSidebar footer** — same pattern, label `Workspace settings →`, target `settings/general` (same relative-path caution).
- [ ] **Step 5: Run → PASS; full bar clean. Commit** (`feat(settings): sectioned workspace sidebar with account cross-links`).

---

### Task 3: navLinks retarget `[haiku]`

**Files:**
- Modify: `app/src/lib/use-tenant-navigate.ts:29-32`

**Interfaces:**
- Produces: `navLinks.integrations` → `/app/${slug}/settings/webhooks`; `integrationsPullApi` → `/settings/pull-api`; `integrationsWebhooks` → `/settings/webhooks`; `integrationsServiceAccounts` → `/settings/service-accounts`. Key NAMES stay (all call sites keep compiling); only values change. AppShell's nav item AND the palette entry both read these — no AppShell edit needed.

- [ ] **Step 1: Edit the four values:**

```ts
integrations: `/app/${slug}/settings/webhooks`,
integrationsPullApi: `/app/${slug}/settings/pull-api`,
integrationsWebhooks: `/app/${slug}/settings/webhooks`,
integrationsServiceAccounts: `/app/${slug}/settings/service-accounts`,
```

- [ ] **Step 2: Sweep consumers** — `grep -rn "navLinks.integrations\|integrationsPullApi\|integrationsWebhooks\|integrationsServiceAccounts" app/src` — every hit now points into settings; confirm none constructs child paths by string-appending to `navLinks.integrations` (which now ends in `/webhooks` — appending would break; if any such construction exists, switch it to the specific key).
- [ ] **Step 3: Full bar clean. Commit** (`feat(settings): nav and palette target the settings-tree integration pages`).

---

### Task 4: Test-path sweep + old-page tests `[sonnet]`

**Files:**
- Modify: `app/src/routes/integrations/WebhookDetail.test.tsx`, `app/src/routes/integrations/Webhooks.test.tsx` (grep for others: `grep -rln "integrations/" app/test app/src --include="*.test.tsx"`)

- [ ] **Step 1:** Update any test that renders/asserts the OLD paths to the new `settings/*` paths (behavior assertions unchanged — path strings only). Tests that render the components directly without routing need no change.
- [ ] **Step 2:** Full bar: typecheck, FULL suite (expect 80+ files with Task 1's new test file), lint. Also `git diff --stat main..HEAD -- server/` must be EMPTY (spec: server untouched).
- [ ] **Step 3: Commit** (`test(settings): integration page tests target settings paths`).

---

### Task 5: Final verification, whole-branch review, merge-on-green `[controller + fable judge]`

- [ ] **Step 1:** Full bar; glossary sweep over changed files; `git diff --stat main..HEAD -- server/` empty.
- [ ] **Step 2:** Whole-branch review (most capable model): redirect completeness (every old URL incl. param case), no orphaned integrations references (`grep -rn '"/integrations\|/integrations/' app/src` — remaining hits must be the redirect routes themselves), sidebar permission-gating per section, cross-link resolution, ledger open-notes triage.
- [ ] **Step 3:** Report to `docs/superpowers/plans/2026-07-13-settings-ia.REPORT.md`; commit.
- [ ] **Step 4:** Merge-on-green (authorized): clean verdict → `git checkout main && git merge settings-ia --no-edit && git branch -d settings-ia`, post-merge app suite sanity. No push. Otherwise stop at the report.
