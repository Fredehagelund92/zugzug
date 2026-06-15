# Outbound Integrations — PR4: Integrations UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the client-only Integrations surface — top-level *Integrations* nav, Pull API reference page, Webhooks list+detail+modals, Service Accounts page — so admins can manage workspace-scoped credentials and webhook subscriptions, and developers can copy-paste a working `curl` line against the v1 endpoints already running server-side from PR2/PR3.

**Architecture:** Client-only React work that consumes the existing `/api/t/:slug/v1/...` endpoints. The only server-side change is extending the `/v1/` auth wrapper to fall back to session cookies — today it is bearer-only, which would force the UI to round-trip through a personal API token. With cookie fallback, the same handlers serve both UI and SDK traffic without parallel routes. UI follows the established `SettingsShell`/`SettingsSidebar` pattern; permissions extend `lib/permissions.ts` with new `integrations.*` actions matching the matrix in §9 of the design.

**Tech Stack:** React 18, react-router-dom 6, Tailwind v4, Vitest for unit tests, existing `apiFetch` (cookie-credentialed) for client calls, existing `ConfirmDialog`, `SettingsShell`, `SettingsSection`, `Button`, `Badge`, `EmptyState`, `Skeleton`, `Toast` primitives.

**Source-of-truth references:**
- Design: `docs/superpowers/specs/2026-06-14-outbound-integrations-design.md` §6 (UI surface), §9 (permissions matrix), §5.5 (wire shapes), §10 Phase 2 (rollout).
- Server v1 routes: `server/src/v1-routes.ts` (already shipping every endpoint PR4 consumes).
- Existing settings shell: `app/src/components/settings/SettingsShell.tsx` + `SettingsSidebar.tsx` (visual template).
- Existing Tokens page: `app/src/routes/settings/Tokens.tsx` (functional template for Service Accounts).

---

## Baseline test-failure list

Before starting, capture both client and server baselines:

```bash
cd app && bun run test 2>&1 | grep -E "FAIL" | sort -u > /tmp/zugzug_pr4_app_baseline.txt
cd ../server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr4_server_baseline.txt
wc -l /tmp/zugzug_pr4_app_baseline.txt /tmp/zugzug_pr4_server_baseline.txt
```

After every task, regression-check by diffing fresh runs against these files. The regression standard is `diff` empty OR only lines starting with `<` (failures that now pass) — never lines starting with `>` (new failures).

---

## File Map

**Server — modified**
- `server/src/v1-routes.ts` — extend auth: if `authenticateBearer` returns null, fall back to `getSessionUser`; then synthesise `AuthedRequest` without `serviceAccount`. Roughly 15 lines.

**Server — new tests**
- `server/src/v1-routes-session-auth.test.ts` — verify cookie-authed UI request to `/v1/webhooks` succeeds and a no-auth request still 401s.

**Client — new**
- `app/src/lib/integrations-api.ts` — typed wrappers for every v1 webhook + service-account endpoint. ~250 LOC.
- `app/src/lib/integrations-api.test.ts` — unit tests for URL building + error normalisation.
- `app/src/components/integrations/IntegrationsSidebar.tsx` — three-item nav, role-gated.
- `app/src/components/integrations/DeveloperDetails.tsx` — `<details data-testid="developer-details">` disclosure, admin-only, localStorage'd open state.
- `app/src/components/integrations/SigningRecipeBlock.tsx` — copyable TypeScript recipe (the §5.5 snippet, verbatim).
- `app/src/routes/integrations/IntegrationsLayout.tsx` — `SettingsShell`-shaped outlet wrapper.
- `app/src/routes/integrations/PullApi.tsx` — tabs (`Endpoints` default, `Webhooks` recipe), banner, endpoints list, dimensions table, pagination panel, rate-limits panel.
- `app/src/routes/integrations/Webhooks.tsx` — list table + empty state + *+ New webhook*.
- `app/src/routes/integrations/CreateWebhookModal.tsx` — create form (URL + events checkboxes + description).
- `app/src/routes/integrations/SecretRevealModal.tsx` — shared one-shot reveal (used by create + rotate).
- `app/src/routes/integrations/WebhookDetail.tsx` — Overview, Send test, Delivery log, Danger zone.
- `app/src/routes/integrations/ServiceAccounts.tsx` — list + inline create form + revoke.

**Client — modified**
- `app/src/lib/permissions.ts` — add the `integrations.*` actions; map each to a role per §9.
- `app/src/lib/permissions.test.ts` — extend with the new actions.
- `app/src/lib/use-tenant-navigate.ts` — add `integrations` to `useNavLinks`.
- `app/src/components/Icons.tsx` — add `IconIntegrations` (outbound-arrow circle).
- `app/src/components/AppShell.tsx` — insert Integrations entry between Activity and Settings; add command-palette entry.
- `app/src/App.tsx` — register `/integrations/*` routes nested under `AppShell`.
- `app/src/routes/settings/Warehouse.tsx` — **verification only** (the "Master records" section was already removed in commit `e67d936`).

**Client — new tests**
- `app/src/lib/permissions.test.ts` — new cases for the matrix.
- `app/src/lib/integrations-api.test.ts` — see above.
- `app/src/routes/integrations/Webhooks.test.tsx` — duplicate-URL chip, status badge mapping.
- `app/src/routes/integrations/WebhookDetail.test.tsx` — kid badge visibility during grace, viewer payload masking.

---

## Task 1: Server — session-cookie fallback on `/v1/` auth wrapper

**Goal:** Allow `/api/t/:slug/v1/...` requests authenticated via session cookie (i.e. UI traffic) to proceed identically to bearer requests. Service-account traffic continues to use bearer.

**Files:**
- Modify: `server/src/v1-routes.ts:91` (the existing `authenticateBearer` call).
- Test: `server/src/v1-routes-session-auth.test.ts` (new).

- [ ] **Step 1: Write the failing test**

Create `server/src/v1-routes-session-auth.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "bun:test";
import { resetDb, withTenant, withCookie } from "./test-helpers.ts";
import { dispatchV1Route } from "./v1-routes.ts";

describe("v1 session-cookie fallback", () => {
  beforeAll(async () => { await resetDb(); });

  it("admin cookie request to /v1/webhooks returns 200", async () => {
    const { slug, cookie } = await withTenant({ role: "admin" });
    const req = new Request(`http://localhost/api/t/${slug}/v1/webhooks`, {
      headers: { cookie },
    });
    const res = await dispatchV1Route(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
  });

  it("no auth at all returns 401", async () => {
    const { slug } = await withTenant({ role: "admin" });
    const req = new Request(`http://localhost/api/t/${slug}/v1/webhooks`);
    const res = await dispatchV1Route(req);
    expect(res!.status).toBe(401);
  });

  it("bearer SA traffic still works", async () => {
    const { slug, saToken } = await withTenant({ role: "admin", withServiceAccount: true });
    const req = new Request(`http://localhost/api/t/${slug}/v1/dimensions`, {
      headers: { authorization: `Bearer ${saToken}` },
    });
    const res = await dispatchV1Route(req);
    expect(res!.status).toBe(200);
  });
});
```

Note: this assumes a `withTenant({ role, withServiceAccount? })` test helper. If it doesn't exist, inline the test using the existing PR3 test patterns (look at `server/src/v1-routes.test.ts` or `repo-webhooks.test.ts` for the canonical setup style and copy it; do NOT invent a helper that does not exist).

- [ ] **Step 2: Run test to verify it fails**

```bash
cd server && bun test v1-routes-session-auth.test.ts 2>&1 | tail -20
```

Expected: the cookie-authed test fails with `401`.

- [ ] **Step 3: Extend `/v1/` auth wrapper**

In `server/src/v1-routes.ts`, locate the existing block at line ~91:

```ts
  // Auth.
  const authed = await authenticateBearer(req);
  if (!authed) return jsonError(401, "unauthorized");
```

Replace with:

```ts
  // Auth. Bearer (SA or personal token) is the primary path for /v1/. UI traffic
  // on cookies falls back so the same handlers serve both surfaces; SA-only
  // semantics (synthetic viewer role, scope gates) only kick in when the bearer
  // branch resolved a service account.
  let authed = await authenticateBearer(req);
  if (!authed) {
    const sessionUser = await getSessionUser(req);
    if (sessionUser) authed = { user: sessionUser };
  }
  if (!authed) return jsonError(401, "unauthorized");
```

Add the import at the top of the file if not present:

```ts
import { getSessionUser } from "./auth.ts";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server && bun test v1-routes-session-auth.test.ts 2>&1 | tail -20
cd server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr4_server_after_t1.txt
diff /tmp/zugzug_pr4_server_baseline.txt /tmp/zugzug_pr4_server_after_t1.txt
```

Expected: new test passes; diff shows no new failures.

- [ ] **Step 5: Commit**

```bash
git add server/src/v1-routes.ts server/src/v1-routes-session-auth.test.ts
git commit -m "feat(server): /v1/ auth accepts session cookies as fallback

UI traffic uses session cookies; the existing bearer-only gate forced
the new Integrations page to round-trip through a personal API token.
Fall back to getSessionUser so the same /v1/ handlers serve UI calls."
```

---

## Task 2: Client — permissions actions for Integrations

**Goal:** Add the actions from §9 of the design to `lib/permissions.ts`; cover them with tests.

**Files:**
- Modify: `app/src/lib/permissions.ts`
- Modify: `app/src/lib/permissions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/permissions.test.ts`:

```ts
describe("integrations actions (§9 matrix)", () => {
  const viewer = ctx("viewer");
  const editor = ctx("editor");
  const admin = ctx("admin");

  it("everyone sees the Pull API docs page", () => {
    expect(can(viewer, "integrations.pull_api.view")).toBe(true);
    expect(can(editor, "integrations.pull_api.view")).toBe(true);
    expect(can(admin, "integrations.pull_api.view")).toBe(true);
  });

  it("everyone sees the webhooks list + delivery log metadata", () => {
    for (const t of [viewer, editor, admin]) {
      expect(can(t, "integrations.webhooks.view")).toBe(true);
      expect(can(t, "integrations.webhooks.delivery_log_view")).toBe(true);
    }
  });

  it("viewer cannot see delivery payloads; editor and admin can", () => {
    expect(can(viewer, "integrations.webhooks.delivery_payload_view")).toBe(false);
    expect(can(editor, "integrations.webhooks.delivery_payload_view")).toBe(true);
    expect(can(admin, "integrations.webhooks.delivery_payload_view")).toBe(true);
  });

  it("only admin can edit webhooks", () => {
    expect(can(viewer, "integrations.webhooks.edit")).toBe(false);
    expect(can(editor, "integrations.webhooks.edit")).toBe(false);
    expect(can(admin, "integrations.webhooks.edit")).toBe(true);
  });

  it("viewer cannot see service accounts; editor sees, admin edits", () => {
    expect(can(viewer, "integrations.service_accounts.view")).toBe(false);
    expect(can(editor, "integrations.service_accounts.view")).toBe(true);
    expect(can(admin, "integrations.service_accounts.view")).toBe(true);
    expect(can(viewer, "integrations.service_accounts.edit")).toBe(false);
    expect(can(editor, "integrations.service_accounts.edit")).toBe(false);
    expect(can(admin, "integrations.service_accounts.edit")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && bun run test src/lib/permissions.test.ts 2>&1 | tail -20
```

Expected: type errors on the new action strings, then assertion failures.

- [ ] **Step 3: Extend the Action union and switch**

In `app/src/lib/permissions.ts`, add to the `Action` union:

```ts
  | "integrations.pull_api.view"
  | "integrations.webhooks.view"
  | "integrations.webhooks.delivery_log_view"
  | "integrations.webhooks.delivery_payload_view"
  | "integrations.webhooks.edit"
  | "integrations.service_accounts.view"
  | "integrations.service_accounts.edit"
```

And add cases to the `switch` in `can()` (place these grouped above the `admin.view` case):

```ts
    case "integrations.pull_api.view":
    case "integrations.webhooks.view":
    case "integrations.webhooks.delivery_log_view":
      return true;

    case "integrations.webhooks.delivery_payload_view":
    case "integrations.service_accounts.view":
      return t.role === "editor" || t.role === "admin";

    case "integrations.webhooks.edit":
    case "integrations.service_accounts.edit":
      return t.role === "admin";
```

Also append the new actions to the test file's `EDIT_ACTIONS` array (the super-admin-covers-everything tests rely on it):

```ts
const EDIT_ACTIONS: Action[] = [
  // ... existing entries ...
  "integrations.webhooks.edit",
  "integrations.service_accounts.edit",
];
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && bun run test src/lib/permissions.test.ts 2>&1 | tail -20
```

Expected: all permissions tests green, including the super-admin loop now covering the new edit actions.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/permissions.ts app/src/lib/permissions.test.ts
git commit -m "feat(app): integrations.* permission actions

Adds the integrations matrix from the outbound-integrations spec §9 —
viewer/editor/admin role mapping for Pull API docs, webhooks list,
delivery payload visibility (editor+), webhook edit (admin), and
service account view/edit."
```

---

## Task 3: Client — typed API client `integrations-api.ts`

**Goal:** One module that wraps every v1 webhook + service-account endpoint with proper TypeScript shapes. Co-locate the wire types with the fetchers so every page imports from one place.

**Files:**
- Create: `app/src/lib/integrations-api.ts`
- Create: `app/src/lib/integrations-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/integrations-api.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as api from "./integrations-api";

const FETCH = vi.fn();

beforeEach(() => {
  FETCH.mockReset();
  // apiFetch reads window.location.pathname; stub a tenant URL.
  Object.defineProperty(window, "location", {
    writable: true,
    value: { pathname: "/app/acme/integrations/webhooks" },
  });
  globalThis.fetch = FETCH as unknown as typeof fetch;
});

describe("listWebhooks", () => {
  it("GETs /api/t/<slug>/v1/webhooks and returns the array", async () => {
    FETCH.mockResolvedValueOnce(new Response(JSON.stringify({ webhooks: [{ id: "wh_1" }] }), { status: 200 }));
    const out = await api.listWebhooks();
    expect(FETCH).toHaveBeenCalledWith(
      "/api/t/acme/v1/webhooks",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(out).toEqual([{ id: "wh_1" }]);
  });
});

describe("createWebhook", () => {
  it("POSTs JSON body and returns { id, value }", async () => {
    FETCH.mockResolvedValueOnce(new Response(JSON.stringify({ id: "wh_1", value: "whsec_xxx" }), { status: 201 }));
    const out = await api.createWebhook({ url: "https://x", events: ["dimension.committed"], description: null });
    expect(out).toEqual({ id: "wh_1", value: "whsec_xxx" });
    const init = FETCH.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      url: "https://x",
      events: ["dimension.committed"],
      description: null,
    });
  });

  it("throws IntegrationsApiError on 400 with the server error code", async () => {
    FETCH.mockResolvedValueOnce(new Response(JSON.stringify({ error: "https_required" }), { status: 400 }));
    await expect(api.createWebhook({ url: "http://x", events: ["dimension.committed"], description: null }))
      .rejects.toMatchObject({ code: "https_required", status: 400 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && bun run test src/lib/integrations-api.test.ts 2>&1 | tail -10
```

Expected: module not found.

- [ ] **Step 3: Implement the API client**

Create `app/src/lib/integrations-api.ts`. The file is long but every section is mechanical. Use this skeleton verbatim, then fill out the remaining endpoints with the same pattern:

```ts
import { apiFetch } from "../api";

export class IntegrationsApiError extends Error {
  constructor(public code: string, public status: number, message?: string) {
    super(message ?? code);
    this.name = "IntegrationsApiError";
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await apiFetch(path, init);
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function toError(res: Response): Promise<IntegrationsApiError> {
  let code = `http_${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) code = body.error;
  } catch { /* not JSON */ }
  return new IntegrationsApiError(code, res.status);
}

/* ---------- types ---------- */

export type WebhookStatus = "active" | "paused" | "disabled";
export type WebhookEvent =
  | "dimension.committed"
  | "dimension.created"
  | "dimension.schema.updated"
  | "canonical.deleted";

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  status: WebhookStatus;
  description: string | null;
  secret_prefix: string;
  secret_prefix_previous: string | null;
  secret_previous_expires_at: string | null;
  created_at: string;
  created_by: string;
  paused_at: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
  last_delivery_at?: string | null;
  last_delivery_status?: number | null;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  delivery_url: string;
  signing_kid: "current" | "previous";
  is_test: boolean;
  status: "pending" | "in_flight" | "success" | "retry" | "dlq";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_response_code: number | null;
  last_response_body: string | null;
  last_error: string | null;
  payload: unknown | null;        // null when caller role = viewer
  signature: string | null;       // null when caller role = viewer
  created_at: string;
  completed_at: string | null;
}

export interface ServiceAccount {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_at: string;
  created_by: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export interface DimensionSummary {
  id: string;
  slug: string;
  label: string;
  key_kind: string;
  canonical_count: number;
  last_committed_at: string | null;
}

/* ---------- webhooks ---------- */

export async function listWebhooks(): Promise<Webhook[]> {
  const { webhooks } = await get<{ webhooks: Webhook[] }>("/v1/webhooks");
  return webhooks;
}
export const getWebhook    = (id: string) => get<Webhook>(`/v1/webhooks/${encodeURIComponent(id)}`);
export const createWebhook = (body: { url: string; events: WebhookEvent[]; description: string | null }) =>
  send<{ id: string; value: string }>("/v1/webhooks", "POST", body);
export const patchWebhook  = (id: string, body: Partial<{ url: string; events: WebhookEvent[]; status: WebhookStatus; description: string | null }>) =>
  send<void>(`/v1/webhooks/${encodeURIComponent(id)}`, "PATCH", body);
export const deleteWebhook = (id: string) =>
  send<void>(`/v1/webhooks/${encodeURIComponent(id)}`, "DELETE");
export const reactivateWebhook = (id: string) =>
  send<void>(`/v1/webhooks/${encodeURIComponent(id)}/reactivate`, "POST");
export const rotateSecret = (id: string) =>
  send<{ value: string; previous_expires_at: string }>(`/v1/webhooks/${encodeURIComponent(id)}/rotate-secret`, "POST");
export const sendTestEvent = (id: string) =>
  send<{ delivery_id: string }>(`/v1/webhooks/${encodeURIComponent(id)}/test`, "POST");

export async function listDeliveries(id: string, params: { status?: string; limit?: number } = {}): Promise<WebhookDelivery[]> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.limit) qs.set("limit", String(params.limit));
  const path = `/v1/webhooks/${encodeURIComponent(id)}/deliveries${qs.toString() ? `?${qs}` : ""}`;
  const { deliveries } = await get<{ deliveries: WebhookDelivery[] }>(path);
  return deliveries;
}
export const getDelivery = (id: string) =>
  get<WebhookDelivery>(`/v1/webhook-deliveries/${encodeURIComponent(id)}`);
export const replayDelivery = (id: string) =>
  send<{ delivery_id: string }>(`/v1/webhook-deliveries/${encodeURIComponent(id)}/replay`, "POST");

/* ---------- service accounts ---------- */

export async function listServiceAccounts(): Promise<ServiceAccount[]> {
  const { service_accounts } = await get<{ service_accounts: ServiceAccount[] }>("/v1/service-accounts");
  return service_accounts;
}
export const createServiceAccount = (body: { name: string; expires_at: string | null }) =>
  send<{ service_account: ServiceAccount; value: string }>("/v1/service-accounts", "POST", body);
export const revokeServiceAccount = (id: string) =>
  send<void>(`/v1/service-accounts/${encodeURIComponent(id)}`, "DELETE");

/* ---------- pull-api shapes for the docs page ---------- */

export async function listDimensions(): Promise<DimensionSummary[]> {
  const out = await get<{ dimensions: DimensionSummary[] } | DimensionSummary[]>("/v1/dimensions");
  return Array.isArray(out) ? out : out.dimensions;
}
```

Note on the `listDimensions` shape: PR2 may return `{ dimensions: [...] }` OR an array. Inspect `server/src/v1-routes.ts:listDimensionsForApi` once before merging and remove the array branch if the server is stable on the object shape.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && bun run test src/lib/integrations-api.test.ts 2>&1 | tail -20
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/integrations-api.ts app/src/lib/integrations-api.test.ts
git commit -m "feat(app): typed API client for integrations endpoints

One module wraps every /v1/webhooks*, /v1/service-accounts*, and
/v1/dimensions endpoint with proper TS shapes. IntegrationsApiError
normalises server error codes (e.g. https_required, events_empty)
so callers can switch on them."
```

---

## Task 4: Client — Integrations icon + nav-link helper

**Goal:** Add `IconIntegrations` and extend `useNavLinks()` so every page can build hrefs the same way it does for `triage`, `tables`, etc.

**Files:**
- Modify: `app/src/components/Icons.tsx`
- Modify: `app/src/lib/use-tenant-navigate.ts`

- [ ] **Step 1: Add the icon**

Append to `app/src/components/Icons.tsx` (use whatever SVG primitive the file already uses; example below assumes a Lucide-style functional component):

```tsx
export function IconIntegrations(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
         strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8M12 8l4 4-4 4" />
    </svg>
  );
}
```

- [ ] **Step 2: Extend `useNavLinks`**

In `app/src/lib/use-tenant-navigate.ts`, add to the `useMemo` return object:

```ts
      integrations: `/app/${slug}/integrations`,
      integrationsPullApi: `/app/${slug}/integrations/pull-api`,
      integrationsWebhooks: `/app/${slug}/integrations/webhooks`,
      integrationsServiceAccounts: `/app/${slug}/integrations/service-accounts`,
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/Icons.tsx app/src/lib/use-tenant-navigate.ts
git commit -m "chore(app): IconIntegrations + integrations nav links"
```

---

## Task 5: Client — `IntegrationsSidebar` + `IntegrationsLayout`

**Goal:** Reusable shell mirroring the Settings shell pattern; sidebar lists Pull API, Webhooks, Service Accounts, role-gated.

**Files:**
- Create: `app/src/components/integrations/IntegrationsSidebar.tsx`
- Create: `app/src/routes/integrations/IntegrationsLayout.tsx`

- [ ] **Step 1: Implement the sidebar**

```tsx
// app/src/components/integrations/IntegrationsSidebar.tsx
import { NavLink } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can, type Action } from "../../lib/permissions";
import { cx } from "../../lib/cx";
import { IconIntegrations, IconWebhook, IconKey } from "../Icons";
import type { SVGProps, ComponentType } from "react";

interface Item {
  label: string;
  to: string;
  action: Action;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

// `IconWebhook`/`IconKey` may not exist yet — if Icons.tsx lacks them,
// substitute IconAudit / IconSettings until a follow-up icon pass lands.
const ITEMS: Item[] = [
  { label: "Pull API",         to: "pull-api",         action: "integrations.pull_api.view",        Icon: IconIntegrations },
  { label: "Webhooks",         to: "webhooks",         action: "integrations.webhooks.view",        Icon: IconIntegrations },
  { label: "Service accounts", to: "service-accounts", action: "integrations.service_accounts.view", Icon: IconIntegrations },
];

export function IntegrationsSidebar() {
  const tenant = useTenant();
  const visible = ITEMS.filter((i) => can(tenant, i.action));
  return (
    <nav aria-label="Integrations sections">
      <div className="flex items-center gap-3 px-3 pb-3 mb-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
          Integrations
        </span>
        <div className="flex-1 h-px bg-line" />
      </div>
      <div className="space-y-0.5">
        {visible.map((item) => (
          <NavLink key={item.to} to={item.to} end>
            {({ isActive }) => (
              <span
                className={cx(
                  "group relative flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm rounded-sm transition-all duration-150 w-full",
                  isActive
                    ? "text-accent bg-accent-soft"
                    : "text-ink-2 hover:text-ink hover:bg-hover hover:translate-x-[2px]",
                )}
              >
                {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent" />}
                <item.Icon
                  className={cx("h-3.5 w-3.5 shrink-0", isActive ? "opacity-100" : "opacity-60 group-hover:opacity-100")}
                />
                <span className="font-body">{item.label}</span>
              </span>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Implement the layout**

```tsx
// app/src/routes/integrations/IntegrationsLayout.tsx
import { Outlet } from "react-router-dom";
import { SettingsShell } from "../../components/settings/SettingsShell";
import { IntegrationsSidebar } from "../../components/integrations/IntegrationsSidebar";

export function IntegrationsLayout() {
  return (
    <SettingsShell sidebar={<IntegrationsSidebar />}>
      <Outlet />
    </SettingsShell>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
cd app && bun run typecheck 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add app/src/components/integrations app/src/routes/integrations/IntegrationsLayout.tsx
git commit -m "feat(app): IntegrationsLayout + sidebar (Settings shell shape)"
```

---

## Task 6: Client — register routes + AppShell nav entry

**Goal:** Make `/app/:slug/integrations/...` reachable. Stub the three child pages so the router can mount them; the real content lands in later tasks.

**Files:**
- Modify: `app/src/App.tsx`
- Modify: `app/src/components/AppShell.tsx`
- Create: `app/src/routes/integrations/PullApi.tsx` (stub)
- Create: `app/src/routes/integrations/Webhooks.tsx` (stub)
- Create: `app/src/routes/integrations/WebhookDetail.tsx` (stub)
- Create: `app/src/routes/integrations/ServiceAccounts.tsx` (stub)

- [ ] **Step 1: Create stubs**

Each stub returns a placeholder so the router has something to render. Example:

```tsx
// app/src/routes/integrations/PullApi.tsx
export function PullApi() {
  return <div className="text-ink-2 text-sm">Pull API page — coming next task.</div>;
}
```

Same shape for `Webhooks`, `WebhookDetail`, `ServiceAccounts`. Export a named function each.

- [ ] **Step 2: Register routes in `App.tsx`**

Inside the existing `AppShell` route block (after the `settings` block, before the closing `</Route>` for `AppShell`):

```tsx
<Route path="integrations" element={<IntegrationsLayout />}>
  <Route index element={<Navigate to="pull-api" replace />} />
  <Route path="pull-api"            element={<PullApi />} />
  <Route path="webhooks"            element={<Webhooks />} />
  <Route path="webhooks/:id"        element={<WebhookDetail />} />
  <Route path="service-accounts"    element={<ServiceAccounts />} />
</Route>
```

Add the imports at the top of `App.tsx`:

```tsx
import { IntegrationsLayout } from "./routes/integrations/IntegrationsLayout";
import { PullApi } from "./routes/integrations/PullApi";
import { Webhooks } from "./routes/integrations/Webhooks";
import { WebhookDetail } from "./routes/integrations/WebhookDetail";
import { ServiceAccounts } from "./routes/integrations/ServiceAccounts";
```

- [ ] **Step 3: Add the nav entry to AppShell**

In `app/src/components/AppShell.tsx`, locate the `workspaceGroup` definition (line ~382). Add an Integrations entry **between Warehouse and Preferences** (or as the spec says: between Activity/Settings — match the existing order convention in this file):

```tsx
const workspaceGroup: NavItem[] = [
  { to: `${settingsBase}/members`, label: "Members", Icon: IconUsers },
  { to: `${settingsBase}/warehouse`, label: "Warehouse", Icon: IconDatabase },
  { to: navLinks.integrations, label: "Integrations", Icon: IconIntegrations },
  { to: `${settingsBase}/general`, label: "Preferences", Icon: IconSettings },
  { to: navLinks.sources, label: "Sources", Icon: IconSources },
];
```

Add the import:

```tsx
import { IconIntegrations } from "./Icons";
```

Also add a command-palette entry inside the `commands` `useMemo` (next to the other `nav:*` entries):

```tsx
out.push({
  id: "nav:integrations",
  group: "Navigate",
  label: "Integrations",
  icon: <IconIntegrations className="h-4 w-4" />,
  action: () => navigate(navLinks.integrations),
  keywords: "webhooks pull api service accounts integrations",
  priority: true,
});
```

- [ ] **Step 4: Typecheck and run app**

```bash
cd app && bun run typecheck 2>&1 | tail -10
```

Expected: clean. Then manually run dev server (`cd app && bun run dev`) and confirm `/app/<slug>/integrations` renders the layout with the three sidebar items.

- [ ] **Step 5: Commit**

```bash
git add app/src/App.tsx app/src/components/AppShell.tsx app/src/routes/integrations
git commit -m "feat(app): register /integrations routes + AppShell nav entry"
```

---

## Task 7: Client — `SigningRecipeBlock` + `DeveloperDetails` shared components

**Goal:** Two reusable pieces consumed by the next few pages: the copyable HMAC verification snippet (Pull API page + WebhookDetail overview) and the admin-only `<details>` disclosure (Pull API banner + WebhookDetail delivery rows + ServiceAccounts list).

**Files:**
- Create: `app/src/components/integrations/SigningRecipeBlock.tsx`
- Create: `app/src/components/integrations/DeveloperDetails.tsx`

- [ ] **Step 1: SigningRecipeBlock**

```tsx
// app/src/components/integrations/SigningRecipeBlock.tsx
import { useState } from "react";
import { Button } from "../Button";

const RECIPE = `// Node 18+; secrets is { current: string, previous?: string }.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyZugzugSignature(rawBody: string, header: string, secrets: {
  current: string; previous?: string;
}): boolean {
  // Header: "t=<unix>,kid=<current|previous>,v1=sha256=<hex>"
  const parts: Record<string, string> = {};
  for (const seg of header.split(",")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  }
  if (!parts.t || !parts.kid || !parts.v1) return false;
  const skew = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(skew) || skew > 300) return false;
  const m = /^sha256=([0-9a-f]{64})$/.exec(parts.v1);
  if (!m) return false;
  const provided = Buffer.from(m[1], "hex");
  const secret = parts.kid === "previous" ? secrets.previous : secrets.current;
  if (!secret) return false;
  const expected = createHmac("sha256", secret)
    .update(parts.t + "." + rawBody)
    .digest();
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}`;

export function SigningRecipeBlock() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-sm border border-line bg-surface-2">
      <div className="flex items-center justify-between px-3 py-2 border-b border-line">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-3">
          verifyZugzugSignature.ts
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(RECIPE);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-ink">{RECIPE}</pre>
    </div>
  );
}
```

- [ ] **Step 2: DeveloperDetails**

```tsx
// app/src/components/integrations/DeveloperDetails.tsx
import { useEffect, useRef, type ReactNode } from "react";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";

interface Props { id: string; summary: string; children: ReactNode }

/* Admin-only <details> disclosure with localStorage'd open/closed.
   Replaces any reference to a global "engineer mode" toggle. */
export function DeveloperDetails({ id, summary, children }: Props) {
  const tenant = useTenant();
  const isAdmin = tenant.role === "admin" || tenant.isSuperAdmin;
  const ref = useRef<HTMLDetailsElement>(null);
  const storageKey = `zz:dev-details:${id}`;

  useEffect(() => {
    if (!isAdmin || !ref.current) return;
    if (localStorage.getItem(storageKey) === "1") ref.current.open = true;
  }, [isAdmin, storageKey]);

  if (!isAdmin) return null;
  return (
    <details
      ref={ref}
      data-testid="developer-details"
      className="rounded-sm border border-line bg-surface-2 p-3 text-[12px]"
      onToggle={(e) => {
        localStorage.setItem(storageKey, (e.currentTarget as HTMLDetailsElement).open ? "1" : "0");
      }}
    >
      <summary className="cursor-pointer text-ink-2 font-mono uppercase tracking-wider text-[10px]">
        {summary}
      </summary>
      <div className="pt-2 text-ink-2">{children}</div>
    </details>
  );
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
cd app && bun run typecheck 2>&1 | tail -10
git add app/src/components/integrations/SigningRecipeBlock.tsx app/src/components/integrations/DeveloperDetails.tsx
git commit -m "feat(app): SigningRecipeBlock + DeveloperDetails primitives"
```

---

## Task 8: Client — Pull API page (Endpoints tab)

**Goal:** The reference doc page from §6.2. Banner card with copyable base URL, auth blurb, endpoint cards, dimensions table with per-row `curl` copy, pagination + rate-limits panels. The Webhooks tab lands in the next task.

**Files:**
- Modify: `app/src/routes/integrations/PullApi.tsx`

- [ ] **Step 1: Implement the Endpoints tab**

Replace the stub with:

```tsx
import { useEffect, useState } from "react";
import { useTenant } from "../../lib/tenant-context";
import { SegControl } from "../../components/SegControl";
import { Button } from "../../components/Button";
import { SkeletonList } from "../../components/Skeleton";
import { listDimensions, IntegrationsApiError, type DimensionSummary } from "../../lib/integrations-api";
import { SigningRecipeBlock } from "../../components/integrations/SigningRecipeBlock";
import { DeveloperDetails } from "../../components/integrations/DeveloperDetails";

const BASE_URL_PLACEHOLDER = "https://<host>";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function PullApi() {
  const tenant = useTenant();
  const [tab, setTab] = useState<"endpoints" | "webhooks">("endpoints");
  const [dims, setDims] = useState<DimensionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listDimensions();
        if (!cancelled) setDims(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof IntegrationsApiError ? e.code : "load_failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const baseUrl = `${typeof window === "undefined" ? BASE_URL_PLACEHOLDER : window.location.origin}/api/t/${tenant.slug}/v1`;
  const firstSlug = dims[0]?.slug ?? "country";

  return (
    <div className="space-y-6">
      <SegControl
        value={tab}
        onChange={(v) => setTab(v as typeof tab)}
        options={[{ value: "endpoints", label: "Endpoints" }, { value: "webhooks", label: "Webhook signing recipe" }]}
      />

      {tab === "endpoints" && (
        <>
          <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-2">
            <h2 className="font-display text-[15px] font-semibold text-ink">
              Your canonical records, available as a JSON API
            </h2>
            <p className="text-[13px] text-ink-2">
              Use this to sync into dbt, Fivetran, or any ETL pipeline. Authenticate with a service
              account from this workspace.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <code className="flex-1 px-2 py-1.5 rounded-sm bg-surface text-[12px] font-mono">{baseUrl}</code>
              <CopyButton text={baseUrl} />
            </div>
            <DeveloperDetails id="pull-api-banner" summary="Developer details">
              <div>Event store: <code>outbound_event</code> table.</div>
            </DeveloperDetails>
          </section>

          <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-2">
            <h3 className="font-display text-[14px] font-semibold text-ink">Authentication</h3>
            <p className="text-[13px] text-ink-2">
              Every request needs a bearer token from the{" "}
              <a href="service-accounts" className="text-accent underline-offset-2 hover:underline">
                Service accounts
              </a>{" "}
              page.
            </p>
            <pre className="px-3 py-2 rounded-sm bg-surface text-[12px] font-mono overflow-x-auto">
{`curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" \\
     ${baseUrl}/dimensions`}
            </pre>
          </section>

          <EndpointCards baseUrl={baseUrl} firstSlug={firstSlug} />

          <section className="rounded-sm border border-line bg-surface-2 p-4">
            <h3 className="font-display text-[14px] font-semibold text-ink mb-3">Dimensions in this workspace</h3>
            {loading ? <SkeletonList rows={3} /> : error ? (
              <p className="text-[13px] text-danger">Could not load dimensions: {error}</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="text-ink-3 text-left">
                  <tr><th className="py-1.5">Slug</th><th>Label</th><th>Records</th><th>Last commit</th><th></th></tr>
                </thead>
                <tbody>
                  {dims.map((d) => {
                    const cmd = `curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" ${baseUrl}/dimensions/${d.slug}/canonical`;
                    return (
                      <tr key={d.id} className="border-t border-line">
                        <td className="py-2 font-mono">{d.slug}</td>
                        <td>{d.label}</td>
                        <td>{d.canonical_count}</td>
                        <td>{d.last_committed_at ? d.last_committed_at.slice(0, 10) : "—"}</td>
                        <td className="text-right"><CopyButton text={cmd} label="Copy curl" /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-2">
            <h3 className="font-display text-[14px] font-semibold text-ink">Pagination + incremental sync</h3>
            <p className="text-[13px] text-ink-2">
              All paginated endpoints accept <code>?since=&lt;ISO&gt;</code> (inclusive lower bound)
              and return a HMAC-signed cursor in <code>cursor.next</code>. Resume by passing
              <code>?cursor=&lt;value&gt;</code>. Cursors invalidated by server-key rotation return
              <code>400 cursor_invalid</code>; consumers should resync from <code>?since=</code>.
            </p>
          </section>

          <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-2">
            <h3 className="font-display text-[14px] font-semibold text-ink">Rate limits</h3>
            <p className="text-[13px] text-ink-2">
              600 req/min per credential by default (configurable via <code>ZUGZUG_PULL_API_RPM</code>).
              Exceeding returns <code>429</code> with <code>Retry-After</code> seconds.
            </p>
          </section>
        </>
      )}

      {tab === "webhooks" && (
        <WebhookRecipeTab />
      )}
    </div>
  );
}

function EndpointCards({ baseUrl, firstSlug }: { baseUrl: string; firstSlug: string }) {
  const ENDPOINTS: { sig: string; desc: string }[] = [
    { sig: `GET /v1/dimensions`,                                desc: "List this workspace's dimensions." },
    { sig: `GET /v1/dimensions/${firstSlug}/schema`,             desc: "Get a dimension's field schema." },
    { sig: `GET /v1/dimensions/${firstSlug}/canonical`,          desc: "Paginated canonical records. Supports ?since= and ?cursor=." },
    { sig: `GET /v1/dimensions/${firstSlug}/tombstones`,         desc: "Paginated retired/merged keys. Used when a webhook reports changes_truncated." },
  ];
  return (
    <section className="space-y-3">
      <h3 className="font-display text-[14px] font-semibold text-ink">Endpoints</h3>
      {ENDPOINTS.map((e) => (
        <div key={e.sig} className="rounded-sm border border-line bg-surface-2 p-4">
          <code className="text-[12px] font-mono">{e.sig}</code>
          <p className="mt-1 text-[12.5px] text-ink-2">{e.desc}</p>
          <details className="mt-2">
            <summary className="text-[12px] text-ink-3 cursor-pointer">Sample response</summary>
            <pre className="mt-2 p-2 rounded-sm bg-surface text-[11.5px] font-mono overflow-x-auto">
{`curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" ${baseUrl}${e.sig.replace("GET ", "")}`}
            </pre>
          </details>
        </div>
      ))}
    </section>
  );
}

function WebhookRecipeTab() {
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-2">
        Webhooks POST a JSON payload signed with HMAC-SHA256. The header contains a timestamp
        (<code>t=</code>), a key id (<code>kid=current</code> or <code>previous</code>), and the
        signature (<code>v1=sha256=...</code>). Copy this verifier verbatim:
      </p>
      <SigningRecipeBlock />
      <p className="text-[13px] text-ink-2">
        See <a href="webhooks" className="text-accent underline-offset-2 hover:underline">Webhooks</a>{" "}
        to create or manage subscriptions.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + manual verify**

```bash
cd app && bun run typecheck 2>&1 | tail -10
```

Run dev server, navigate to `/app/<slug>/integrations/pull-api`, confirm the page renders, dimensions load, copy buttons work, segmented control switches tabs.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/integrations/PullApi.tsx
git commit -m "feat(app): Pull API page (Endpoints + Webhook recipe tabs)"
```

---

## Task 9: Client — Webhooks list page

**Goal:** §6.3 list view. Status badges (Active/Paused/Disabled), duplicate-URL chip (symmetric), empty state with CTA, +New webhook entry point.

**Files:**
- Modify: `app/src/routes/integrations/Webhooks.tsx`
- Create: `app/src/routes/integrations/Webhooks.test.tsx`

- [ ] **Step 1: Write tests**

```tsx
// app/src/routes/integrations/Webhooks.test.tsx
import { describe, it, expect } from "vitest";
import { computeDuplicateUrlSet } from "./Webhooks";

describe("duplicate URL detection", () => {
  it("is symmetric — both rows flagged when two share a URL", () => {
    const set = computeDuplicateUrlSet([
      { id: "a", url: "https://x" }, { id: "b", url: "https://x" }, { id: "c", url: "https://y" },
    ]);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(false);
  });

  it("normalises trailing slash and case for host", () => {
    const set = computeDuplicateUrlSet([
      { id: "a", url: "https://X.com/zz" }, { id: "b", url: "https://x.com/zz/" },
    ]);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
  });
});
```

- [ ] **Step 2: Implement the page**

```tsx
import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { SkeletonList } from "../../components/Skeleton";
import { listWebhooks, type Webhook, type WebhookStatus } from "../../lib/integrations-api";
import { CreateWebhookModal } from "./CreateWebhookModal";
import { SecretRevealModal } from "./SecretRevealModal";

export function computeDuplicateUrlSet(rows: Array<{ id: string; url: string }>): Set<string> {
  const counts = new Map<string, string[]>();
  for (const r of rows) {
    const norm = normaliseUrl(r.url);
    const bucket = counts.get(norm) ?? [];
    bucket.push(r.id);
    counts.set(norm, bucket);
  }
  const dup = new Set<string>();
  for (const ids of counts.values()) if (ids.length > 1) for (const id of ids) dup.add(id);
  return dup;
}

function normaliseUrl(input: string): string {
  try {
    const u = new URL(input);
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch { return input; }
}

function StatusBadge({ status }: { status: WebhookStatus }) {
  if (status === "active")   return <Badge tone="success">Active</Badge>;
  if (status === "paused")   return <Badge>Paused</Badge>;
  return <Badge tone="danger">Disabled</Badge>;
}

export function Webhooks() {
  const tenant = useTenant();
  const canEdit = can(tenant, "integrations.webhooks.edit");
  const [items, setItems] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [secret, setSecret] = useState<{ value: string; webhookId: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setItems(await listWebhooks());
    setLoading(false);
  };
  useEffect(() => { void refresh(); }, []);

  const dupSet = useMemo(() => computeDuplicateUrlSet(items), [items]);

  if (loading) return <SkeletonList rows={3} />;

  if (items.length === 0) {
    return (
      <>
        <EmptyState
          title="No webhooks yet"
          description="Subscribe an endpoint to receive a signed POST when canonical records change."
          action={canEdit ? <Button onClick={() => setShowCreate(true)}>Create your first webhook</Button> : undefined}
        />
        {showCreate && (
          <CreateWebhookModal
            onClose={() => setShowCreate(false)}
            onCreated={(out) => { setShowCreate(false); setSecret({ value: out.value, webhookId: out.id }); void refresh(); }}
          />
        )}
        {secret && <SecretRevealModal value={secret.value} onClose={() => setSecret(null)} />}
      </>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[15px] font-semibold text-ink">Webhooks</h2>
        {canEdit && <Button onClick={() => setShowCreate(true)}>+ New webhook</Button>}
      </div>

      <table className="w-full text-[13px]">
        <thead className="text-ink-3 text-left">
          <tr><th className="py-2">URL</th><th>Events</th><th>Status</th><th>Last delivery</th><th></th></tr>
        </thead>
        <tbody>
          {items.map((w) => {
            const dup = dupSet.has(w.id);
            const eventChips = w.events.length === 1 ? w.events[0] : `${w.events[0]} (+${w.events.length - 1})`;
            return (
              <tr key={w.id} className="border-t border-line">
                <td className="py-2 font-mono text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="truncate max-w-[28ch]">{w.url}</span>
                    {dup && <Badge tone="warn" title="Also subscribed by another webhook">⚠ duplicate URL</Badge>}
                  </div>
                </td>
                <td>{eventChips}</td>
                <td><StatusBadge status={w.status} /></td>
                <td>{w.last_delivery_at ? `${w.last_delivery_at.slice(0,16)} · ${w.last_delivery_status ?? "—"}` : "never"}</td>
                <td className="text-right"><Link to={w.id} className="text-accent hover:underline">View →</Link></td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {Array.from(dupSet).length > 0 && (
        <p className="text-[12px] text-ink-3">{dupSet.size} duplicate URLs</p>
      )}

      {showCreate && (
        <CreateWebhookModal
          onClose={() => setShowCreate(false)}
          onCreated={(out) => { setShowCreate(false); setSecret({ value: out.value, webhookId: out.id }); void refresh(); }}
        />
      )}
      {secret && <SecretRevealModal value={secret.value} onClose={() => setSecret(null)} />}
    </div>
  );
}
```

- [ ] **Step 3: Run tests + typecheck**

```bash
cd app && bun run test src/routes/integrations/Webhooks.test.tsx 2>&1 | tail -10
cd app && bun run typecheck 2>&1 | tail -10
```

Expected: tests green; typecheck reports missing `CreateWebhookModal` / `SecretRevealModal` — they land in the next task. Stub them empty if needed, OR commit this task plus task 10 together:

```tsx
// app/src/routes/integrations/CreateWebhookModal.tsx (temporary)
export function CreateWebhookModal(_: { onClose: () => void; onCreated: (out: { id: string; value: string }) => void }) { return null; }
// app/src/routes/integrations/SecretRevealModal.tsx (temporary)
export function SecretRevealModal(_: { value: string; onClose: () => void }) { return null; }
```

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/integrations/Webhooks.tsx app/src/routes/integrations/Webhooks.test.tsx \
        app/src/routes/integrations/CreateWebhookModal.tsx app/src/routes/integrations/SecretRevealModal.tsx
git commit -m "feat(app): Webhooks list page + duplicate-URL detection

Symmetric duplicate flag (both rows chipped when two share a URL).
URL normalisation matches §5.3 — lowercase host, trim trailing
slash. Modals stubbed; full create flow lands next task."
```

---

## Task 10: Client — `CreateWebhookModal` + `SecretRevealModal`

**Goal:** Two-step create flow from §6.3 wireframe — form modal, then a one-shot secret-reveal modal (cannot Esc, explicit confirm).

**Files:**
- Modify: `app/src/routes/integrations/CreateWebhookModal.tsx`
- Modify: `app/src/routes/integrations/SecretRevealModal.tsx`

- [ ] **Step 1: SecretRevealModal**

```tsx
import { useState } from "react";
import { Button } from "../../components/Button";

interface Props { value: string; onClose: () => void; title?: string; }

export function SecretRevealModal({ value, onClose, title = "Copy your signing secret" }: Props) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        className="w-[460px] rounded-sm border border-line bg-surface p-5 space-y-3"
        onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation(); }}
      >
        <h2 className="font-display text-[15px] font-semibold text-ink">{title}</h2>
        <p className="text-[13px] text-ink-2">This is the only time you'll see this value.</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-sm bg-surface-2 px-2 py-1.5 font-mono text-[12px] break-all">{value}</code>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="flex justify-end">
          <Button onClick={onClose} disabled={!copied} title={copied ? undefined : "Copy the secret first"}>
            I've copied it
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: CreateWebhookModal**

```tsx
import { useState } from "react";
import { Button } from "../../components/Button";
import { Checkbox } from "../../components/Checkbox";
import { FormField } from "../../components/FormField";
import { createWebhook, IntegrationsApiError, type WebhookEvent } from "../../lib/integrations-api";

interface Props {
  onClose: () => void;
  onCreated: (out: { id: string; value: string }) => void;
}

const EVENTS: { value: WebhookEvent; label: string; hint: string }[] = [
  { value: "dimension.committed",      label: "dimension.committed",      hint: "When canonical records change." },
  { value: "dimension.created",        label: "dimension.created",        hint: "When a new dimension is set up." },
  { value: "canonical.deleted",        label: "canonical.deleted",        hint: "When a single record is retired." },
  { value: "dimension.schema.updated", label: "dimension.schema.updated", hint: "When a dimension's field schema changes." },
];

export function CreateWebhookModal({ onClose, onCreated }: Props) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["dimension.committed"]);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const out = await createWebhook({ url, events, description: description || null });
      onCreated(out);
    } catch (e) {
      const msg = e instanceof IntegrationsApiError ? e.code : "create_failed";
      setError(humanError(msg));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-[520px] rounded-sm border border-line bg-surface p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-[15px] font-semibold text-ink">New webhook</h2>

        <FormField label="Endpoint URL" hint="HTTPS required.">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.acme.com/zugzug"
            className="w-full rounded-sm border border-line bg-surface-2 px-2 py-1.5 text-[13px]"
          />
        </FormField>

        <fieldset>
          <legend className="text-[12px] text-ink-2 mb-1">Events to subscribe</legend>
          <div className="space-y-1">
            {EVENTS.map((e) => (
              <label key={e.value} className="flex items-center gap-2 text-[13px]">
                <Checkbox
                  checked={events.includes(e.value)}
                  onChange={(v) => setEvents((prev) => v ? [...prev, e.value] : prev.filter((x) => x !== e.value))}
                />
                <span className="font-mono">{e.label}</span>
                <span className="text-ink-3">{e.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <FormField label="Description (optional)">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Sync into Acme CRM"
            className="w-full rounded-sm border border-line bg-surface-2 px-2 py-1.5 text-[13px]"
          />
        </FormField>

        <p className="text-[12px] text-ink-3">
          Signing secret will be generated and shown once. Test events can be sent from the
          webhook detail page once the subscription exists.
        </p>

        {error && <p className="text-[12px] text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={() => void submit()} loading={submitting} disabled={!url || events.length === 0}>
            Create webhook
          </Button>
        </div>
      </div>
    </div>
  );
}

function humanError(code: string): string {
  switch (code) {
    case "invalid_url":    return "That URL doesn't parse.";
    case "https_required": return "URL must use https://.";
    case "events_empty":   return "Pick at least one event.";
    default:               return code.startsWith("events_unknown")
                                  ? "One of the selected events isn't supported by this server."
                                  : `Could not create webhook (${code}).`;
  }
}
```

If `Checkbox`/`FormField` don't have exactly these props, look in `app/src/components/Checkbox.tsx` / `FormField.tsx` and match their existing API.

- [ ] **Step 3: Typecheck + manual verify**

Run dev server, click *+ New webhook*, create one against `https://httpbin.org/post`, confirm the secret-reveal modal appears, copy enables *I've copied it*, the row appears in the list after closing.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/integrations/CreateWebhookModal.tsx app/src/routes/integrations/SecretRevealModal.tsx
git commit -m "feat(app): webhook create flow — form modal + one-shot secret reveal"
```

---

## Task 11: Client — `WebhookDetail` Overview + Status controls + Rotate

**Goal:** Single-page detail view: URL, event chips, status with PATCH controls (Pause / Resume / Reactivate), description, signing-secret summary with *Rotate* affordance, `kid=` badge **only during rotation grace window**, signing recipe link.

**Files:**
- Modify: `app/src/routes/integrations/WebhookDetail.tsx`
- Create: `app/src/routes/integrations/WebhookDetail.test.tsx`

- [ ] **Step 1: Write tests**

```tsx
// app/src/routes/integrations/WebhookDetail.test.tsx
import { describe, it, expect } from "vitest";
import { showKidBadge } from "./WebhookDetail";

describe("kid badge visibility", () => {
  it("hides badge in steady state (no previous secret)", () => {
    expect(showKidBadge(null)).toBe(false);
  });
  it("shows badge during 24h grace window", () => {
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    expect(showKidBadge(future)).toBe(true);
  });
  it("hides badge after grace expiry", () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(showKidBadge(past)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement the Overview block**

Replace the stub:

```tsx
import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { SkeletonList } from "../../components/Skeleton";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  getWebhook, patchWebhook, deleteWebhook, reactivateWebhook, rotateSecret, sendTestEvent,
  type Webhook,
} from "../../lib/integrations-api";
import { SecretRevealModal } from "./SecretRevealModal";
import { DeliveryLog } from "./DeliveryLog";
import { SigningRecipeBlock } from "../../components/integrations/SigningRecipeBlock";

export function showKidBadge(previousExpiresAt: string | null): boolean {
  if (!previousExpiresAt) return false;
  return new Date(previousExpiresAt).getTime() > Date.now();
}

export function WebhookDetail() {
  const { id = "" } = useParams();
  const tenant = useTenant();
  const canEdit = can(tenant, "integrations.webhooks.edit");

  const [w, setW] = useState<Webhook | null>(null);
  const [loading, setLoading] = useState(true);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setW(await getWebhook(id));
    setLoading(false);
  }, [id]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (loading || !w) return <SkeletonList rows={4} />;

  const inGrace = showKidBadge(w.secret_previous_expires_at);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link to=".." className="text-[12px] text-ink-3 hover:text-ink">← Webhooks</Link>
        {canEdit && (
          <Button variant="ghost" tone="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>
        )}
      </div>

      {w.status === "disabled" && (
        <div className="rounded-sm border border-danger bg-danger-soft p-3 flex items-center justify-between">
          <div className="text-[13px]">
            Auto-disabled: <span className="text-ink-2">{w.disabled_reason}</span>
          </div>
          {canEdit && (
            <Button onClick={async () => { await reactivateWebhook(id); await refresh(); }}>
              Reactivate
            </Button>
          )}
        </div>
      )}

      <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-3">
        <h3 className="font-display text-[14px] font-semibold text-ink">Overview</h3>
        <Row label="URL"><code className="font-mono text-[12px]">{w.url}</code></Row>
        <Row label="Events">
          <div className="flex flex-wrap gap-1">
            {w.events.map((e) => <Badge key={e}>{e}</Badge>)}
          </div>
        </Row>
        <Row label="Status">
          <div className="flex items-center gap-2">
            <Badge tone={w.status === "active" ? "success" : w.status === "paused" ? undefined : "danger"}>
              {w.status[0].toUpperCase() + w.status.slice(1)}
            </Badge>
            {canEdit && w.status === "active" && (
              <Button size="sm" variant="ghost"
                onClick={async () => { await patchWebhook(id, { status: "paused" }); await refresh(); }}>
                Pause
              </Button>
            )}
            {canEdit && w.status === "paused" && (
              <Button size="sm"
                onClick={async () => { await patchWebhook(id, { status: "active" }); await refresh(); }}>
                Resume
              </Button>
            )}
          </div>
        </Row>
        {w.description && <Row label="Description">{w.description}</Row>}
        <Row label="Signing secret">
          <div className="flex items-center gap-3 text-[12px] font-mono">
            <span>{w.secret_prefix}••••</span>
            {inGrace && <Badge>kid=current</Badge>}
            {inGrace && w.secret_prefix_previous && (
              <>
                <span className="text-ink-3">{w.secret_prefix_previous}••••</span>
                <Badge>kid=previous</Badge>
                <span className="text-ink-3">
                  expires {new Date(w.secret_previous_expires_at!).toLocaleString()}
                </span>
              </>
            )}
            {canEdit && (
              <Button size="sm" variant="ghost"
                onClick={async () => {
                  const r = await rotateSecret(id);
                  setSecret(r.value);
                  await refresh();
                }}>
                Rotate
              </Button>
            )}
          </div>
        </Row>
        <p className="text-[12px] text-ink-3 pt-1">
          Verify deliveries with the{" "}
          <Link to="../../pull-api?tab=webhooks" className="text-accent underline-offset-2 hover:underline">
            signing recipe
          </Link>.
        </p>
      </section>

      {canEdit && (
        <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-2">
          <h3 className="font-display text-[14px] font-semibold text-ink">Send a test event</h3>
          <p className="text-[13px] text-ink-2">
            POSTs a synthetic <code>webhook.test</code> payload to the endpoint. Marked with a
            TEST badge in the delivery log; does not count toward auto-disable.
          </p>
          <Button
            onClick={async () => { await sendTestEvent(id); await refresh(); }}
          >
            Send test event
          </Button>
        </section>
      )}

      <DeliveryLog webhookId={id} />

      <details className="rounded-sm border border-line bg-surface-2 p-4">
        <summary className="font-display text-[14px] font-semibold text-ink cursor-pointer">
          Webhook signing recipe
        </summary>
        <div className="mt-3"><SigningRecipeBlock /></div>
      </details>

      {secret && <SecretRevealModal value={secret} onClose={() => setSecret(null)} title="New signing secret" />}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete webhook?"
          message={<p>Type the URL <code>{w.url}</code> to confirm deletion.</p>}
          confirmText="Delete"
          requireText={w.url}
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => { await deleteWebhook(id); window.history.back(); }}
        />
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 text-[13px]">
      <div className="text-ink-3">{label}</div>
      <div>{children}</div>
    </div>
  );
}
```

`ConfirmDialog`'s actual API differs slightly across the repo; verify its props (`title`, `message`, `confirmText`, `requireText` for typed-confirm, `onConfirm`, `onCancel`) by reading `app/src/components/ConfirmDialog.tsx`. If a `requireText`-equivalent prop doesn't exist, add it: this primitive is intentionally reused for typed-confirm interactions and a small extension is preferable to a bespoke modal.

`DeliveryLog` lands in the next task — temporarily stub it the same way `CreateWebhookModal` was stubbed in Task 9.

- [ ] **Step 3: Run tests + typecheck**

```bash
cd app && bun run test src/routes/integrations/WebhookDetail.test.tsx 2>&1 | tail -10
cd app && bun run typecheck 2>&1 | tail -10
```

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/integrations/WebhookDetail.tsx app/src/routes/integrations/WebhookDetail.test.tsx
git commit -m "feat(app): WebhookDetail Overview + status + rotate

Kid badge only shown during the 24h grace window. Reactivate banner
on disabled webhooks. Typed-URL ConfirmDialog for delete. Send-test
button gated to admin."
```

---

## Task 12: Client — `DeliveryLog` (with viewer payload masking)

**Goal:** Delivery table with status badges, TEST badge, attempts, response code, expand-row showing payload + signature + response body (or "Editor or higher required" tooltip for viewers), Replay button (admin only).

**Files:**
- Create: `app/src/routes/integrations/DeliveryLog.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from "react";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { SkeletonList } from "../../components/Skeleton";
import { listDeliveries, replayDelivery, type WebhookDelivery } from "../../lib/integrations-api";
import { DeveloperDetails } from "../../components/integrations/DeveloperDetails";

const STATUS_TONE: Record<WebhookDelivery["status"], "success" | "danger" | undefined> = {
  success:  "success",
  dlq:      "danger",
  retry:    undefined,
  pending:  undefined,
  in_flight: undefined,
};

export function DeliveryLog({ webhookId }: { webhookId: string }) {
  const tenant = useTenant();
  const canSeePayload = can(tenant, "integrations.webhooks.delivery_payload_view");
  const canReplay     = can(tenant, "integrations.webhooks.edit");
  const [rows, setRows] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setRows(await listDeliveries(webhookId, { limit: 50 }));
    setLoading(false);
  };
  useEffect(() => { void refresh(); }, [webhookId]);

  if (loading) return <SkeletonList rows={3} />;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-[14px] font-semibold text-ink">Delivery log</h3>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>Refresh</Button>
      </div>
      <table className="w-full text-[13px]">
        <thead className="text-ink-3 text-left">
          <tr>
            <th className="py-2"></th>
            <th>Status</th>
            <th>Event</th>
            <th>Attempts</th>
            <th>Code</th>
            <th>Created</th>
            {canSeePayload && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = expanded === r.id;
            return (
              <>
                <tr key={r.id} className="border-t border-line">
                  <td className="py-2">
                    {canSeePayload ? (
                      <button
                        className="text-ink-3 hover:text-ink"
                        onClick={() => setExpanded(open ? null : r.id)}
                        aria-label={open ? "Collapse" : "Expand"}
                      >
                        {open ? "▾" : "▸"}
                      </button>
                    ) : (
                      <span
                        title="Editor or higher required to view payload"
                        className="text-ink-3 opacity-50 cursor-not-allowed"
                      >▸</span>
                    )}
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                      {r.is_test && <Badge>TEST</Badge>}
                    </div>
                  </td>
                  <td className="font-mono text-[12px]">{r.event_type}</td>
                  <td>{r.attempts}/{r.max_attempts}</td>
                  <td>{r.last_response_code ?? "—"}</td>
                  <td className="text-ink-2">{r.created_at.slice(0, 19).replace("T", " ")}</td>
                  {canSeePayload && (
                    <td className="text-right">
                      {canReplay && (
                        <Button size="sm" variant="ghost"
                          onClick={async () => { await replayDelivery(r.id); await refresh(); }}
                          title={r.signing_kid === "previous"
                            ? "Original signing key expired — replay will re-sign with current secret"
                            : undefined}>
                          Replay
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
                {open && canSeePayload && (
                  <tr className="bg-surface-2/40">
                    <td colSpan={7} className="p-3">
                      <div className="space-y-2 text-[12px] font-mono">
                        <DetailField label="Signature" value={r.signature ?? "—"} />
                        <DetailField label="Payload"  value={r.payload ? JSON.stringify(r.payload, null, 2) : "—"} />
                        <DetailField label="Response body"
                          value={r.last_response_body ?? r.last_error ?? "—"} />
                        <DeveloperDetails id={`delivery-${r.id}`} summary="Developer details">
                          <div>id: {r.id}</div>
                          <div>signing_kid: {r.signing_kid}</div>
                          <div>next_attempt_at: {r.next_attempt_at ?? "—"}</div>
                        </DeveloperDetails>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="text-[12px] text-ink-3">No deliveries yet.</p>}
    </section>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <details open className="rounded-sm bg-surface-2 p-2">
      <summary className="cursor-pointer text-ink-2">{label}</summary>
      <pre className="mt-1 whitespace-pre-wrap break-all text-[11.5px]">{value}</pre>
    </details>
  );
}
```

- [ ] **Step 2: Augment `WebhookDetail.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { can } from "../../lib/permissions";

describe("viewer payload masking", () => {
  it("viewer cannot view delivery payload", () => {
    const viewerCtx = { id: "t", slug: "t", label: "T", color: null, role: "viewer" as const, isSuperAdmin: false };
    expect(can(viewerCtx, "integrations.webhooks.delivery_payload_view")).toBe(false);
  });
  it("editor can view delivery payload", () => {
    const editorCtx = { id: "t", slug: "t", label: "T", color: null, role: "editor" as const, isSuperAdmin: false };
    expect(can(editorCtx, "integrations.webhooks.delivery_payload_view")).toBe(true);
  });
});
```

(The server is independently authoritative — it nulls out `payload`/`signature`/`last_response_body` for viewers per §9 and PR3. This test pins the client-side gate that hides the expand button.)

- [ ] **Step 3: Typecheck + manual verify**

```bash
cd app && bun run typecheck 2>&1 | tail -10
cd app && bun run test 2>&1 | tail -15
```

Manual smoke: create a webhook against `https://httpbin.org/post`, click *Send test event*, refresh the log, expand the row, see signature + payload, click Replay, see a new row appear.

- [ ] **Step 4: Commit**

```bash
git add app/src/routes/integrations/DeliveryLog.tsx app/src/routes/integrations/WebhookDetail.test.tsx
git commit -m "feat(app): webhook delivery log with replay + viewer payload mask

Expand-row shows signature, payload, response body to editor+ only.
Replay button gated to admin; tooltip notes the kid=previous → current
re-sign case from §4.3 of the spec."
```

---

## Task 13: Client — `ServiceAccounts` page

**Goal:** §6.4 — list + inline create + revoke. One-shot full-token reveal in a warning-bordered card. Reuses `SecretRevealModal` for the post-create flow.

**Files:**
- Modify: `app/src/routes/integrations/ServiceAccounts.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useState } from "react";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { SkeletonList } from "../../components/Skeleton";
import { FormField } from "../../components/FormField";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import {
  listServiceAccounts, createServiceAccount, revokeServiceAccount,
  type ServiceAccount, IntegrationsApiError,
} from "../../lib/integrations-api";
import { SecretRevealModal } from "./SecretRevealModal";
import { DeveloperDetails } from "../../components/integrations/DeveloperDetails";

const EXPIRY_OPTIONS = [
  { label: "Never",   value: "never" as const, days: null as number | null },
  { label: "90 days", value: "90d"   as const, days: 90 },
  { label: "1 year",  value: "1y"    as const, days: 365 },
];

export function ServiceAccounts() {
  const tenant = useTenant();
  const canView = can(tenant, "integrations.service_accounts.view");
  const canEdit = can(tenant, "integrations.service_accounts.edit");

  const [items, setItems] = useState<ServiceAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<typeof EXPIRY_OPTIONS[number]>(EXPIRY_OPTIONS[1]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<{ id: string; name: string } | null>(null);

  const refresh = async () => { setLoading(true); setItems(await listServiceAccounts()); setLoading(false); };
  useEffect(() => { if (canView) void refresh(); }, [canView]);

  if (!canView) {
    return <p className="text-[13px] text-ink-3">Service accounts are admin-only.</p>;
  }

  if (loading) return <SkeletonList rows={3} />;

  const submit = async () => {
    setCreateError(null);
    try {
      const exp = expiry.days == null ? null : new Date(Date.now() + expiry.days * 86_400_000).toISOString();
      const out = await createServiceAccount({ name: name.trim(), expires_at: exp });
      setSecret(out.value);
      setName(""); setShowForm(false);
      await refresh();
    } catch (e) {
      setCreateError(e instanceof IntegrationsApiError ? e.code : "create_failed");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[15px] font-semibold text-ink">Service accounts</h2>
        {canEdit && !showForm && <Button onClick={() => setShowForm(true)}>+ New service account</Button>}
      </div>

      {showForm && (
        <div className="rounded-sm border border-line bg-surface-2 p-4 space-y-3">
          <FormField label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="dbt prod"
              className="w-full rounded-sm border border-line bg-surface px-2 py-1.5 text-[13px]"
            />
          </FormField>
          <FormField label="Expires">
            <div className="flex gap-2">
              {EXPIRY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => setExpiry(o)}
                  className={`px-2 py-1 rounded-sm text-[12px] border ${expiry.value === o.value ? "border-accent text-accent" : "border-line text-ink-2"}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </FormField>
          <FormField label="Scopes">
            <div className="flex items-center gap-2 text-[12px] text-ink-2">
              <Badge>read</Badge>
              <span>(v1 ships read-only; more scopes coming.)</span>
            </div>
          </FormField>
          {createError && <p className="text-[12px] text-danger">{createError}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setShowForm(false); setName(""); setCreateError(null); }}>Cancel</Button>
            <Button onClick={() => void submit()} disabled={!name.trim()}>Create</Button>
          </div>
        </div>
      )}

      {items.length === 0 && !showForm ? (
        <EmptyState
          title="No service accounts yet"
          description="Workspace-scoped credentials. Persist when team members leave."
          action={canEdit ? <Button onClick={() => setShowForm(true)}>Create one</Button> : undefined}
        />
      ) : (
        <table className="w-full text-[13px]">
          <thead className="text-ink-3 text-left">
            <tr>
              <th className="py-2">Name</th><th>Prefix</th><th>Scopes</th>
              <th>Last used</th><th>Expires</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((sa) => (
              <tr key={sa.id} className="border-t border-line">
                <td className="py-2">{sa.name}</td>
                <td className="font-mono text-[12px]">{sa.token_prefix}•••</td>
                <td>{sa.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</td>
                <td>{sa.last_used_at?.slice(0, 10) ?? "never"}</td>
                <td>{sa.expires_at?.slice(0, 10) ?? "never"}</td>
                <td className="text-right">
                  {canEdit && (
                    <Button size="sm" variant="ghost" tone="danger"
                      onClick={() => setRevoke({ id: sa.id, name: sa.name })}>
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <DeveloperDetails id="sa-list" summary="Developer details">
        <div>Token format: <code>zzsa_*</code>; argon2id-hashed at rest; prefix-indexed lookup for the auth fast path.</div>
      </DeveloperDetails>

      {secret && <SecretRevealModal value={secret} onClose={() => setSecret(null)} title="Copy your service account token" />}
      {revoke && (
        <ConfirmDialog
          title={`Revoke ${revoke.name}?`}
          message={<p>This will immediately invalidate the token. Any integration using it will start receiving 401 errors.</p>}
          confirmText="Revoke"
          danger
          onCancel={() => setRevoke(null)}
          onConfirm={async () => { await revokeServiceAccount(revoke.id); setRevoke(null); await refresh(); }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + manual verify**

```bash
cd app && bun run typecheck 2>&1 | tail -10
```

Manual: create a service account, see the secret-reveal modal, copy, dismiss, see the row in the list. Revoke it. Confirm a viewer login sees the "admin-only" message.

- [ ] **Step 3: Commit**

```bash
git add app/src/routes/integrations/ServiceAccounts.tsx
git commit -m "feat(app): Service accounts page (list, create, revoke)"
```

---

## Task 14: Master records card — verify already removed

**Goal:** The design's §6.5 deletion is already in `main` (commit `e67d936`). Verify nothing in `Warehouse.tsx` still references it; if a stray label survives, remove it.

**Files:**
- Read-only: `app/src/routes/settings/Warehouse.tsx`

- [ ] **Step 1: Grep**

```bash
grep -in "master record\|master records" app/src/routes/settings/Warehouse.tsx || echo "clean"
```

Expected: `clean`. If matches appear, remove them with `Edit` (do NOT touch the "Warehouse" + "App" cards that legitimately describe storage tiers).

- [ ] **Step 2: Confirm parquet snapshot link still exists in TablePane/Triage**

```bash
grep -n "snapshot.parquet" app/src/components/TablePane.tsx app/src/routes/Triage.tsx
```

Expected: at least one match per file (per §6.5, those affordances stay).

- [ ] **Step 3: No commit required if nothing changed.** If you did edit, commit:

```bash
git add app/src/routes/settings/Warehouse.tsx
git commit -m "chore(app): scrub residual Master records labels (post e67d936 cleanup)"
```

---

## Task 15: Whole-app verification + regression sweep

**Goal:** Final verification before opening PR. Run typecheck + every test suite, manually click through each page, diff regression baselines.

- [ ] **Step 1: Typecheck both packages**

```bash
cd app && bun run typecheck
cd ../server && bun run typecheck
```

Expected: both clean.

- [ ] **Step 2: Lint**

```bash
cd app && bun run lint
```

- [ ] **Step 3: Run tests + diff baselines**

```bash
cd app && bun run test 2>&1 | grep -E "FAIL" | sort -u > /tmp/zugzug_pr4_app_after.txt
diff /tmp/zugzug_pr4_app_baseline.txt /tmp/zugzug_pr4_app_after.txt

cd ../server && bun test 2>&1 | grep -E "\(fail\)" | sed 's/ \[[0-9.]*ms\]$//' | sort -u > /tmp/zugzug_pr4_server_after.txt
diff /tmp/zugzug_pr4_server_baseline.txt /tmp/zugzug_pr4_server_after.txt
```

Expected: both diffs empty OR only `<` lines (failures that now pass). No new failures.

- [ ] **Step 4: Manual UI sweep**

In a fresh browser session against a dev workspace:

1. Top-level nav shows *Integrations*; clicking it lands on Pull API.
2. Pull API page: copy base URL, copy curl, switch to Webhooks tab, see signing recipe.
3. Webhooks page: empty state visible; create a webhook against `https://httpbin.org/post`; secret reveal appears; *I've copied it* only enables after copy.
4. After create: row in the list; click *View →*; Overview shows URL + chips; signing-secret line shows prefix only (no `kid=` badge in steady state).
5. *Send test event* → row appears in delivery log with TEST badge.
6. Pause → status flips to Paused, Pause button replaced by Resume; delivery log unchanged.
7. Rotate → new secret reveal; back in Overview the badge now shows `kid=current` + `kid=previous` with countdown.
8. Delete → ConfirmDialog requires typing the URL; back to list, row gone.
9. Service accounts: create one (90d), token reveal appears, row in list, revoke via ConfirmDialog, row removed.
10. Switch to a viewer-role login (or stub a viewer tenant): Webhooks list visible; delivery rows can't expand; "Editor or higher required" tooltip on expand chevron; Pause / Send test / Rotate / Delete / Reactivate / Replay buttons all absent.
11. Re-visit Settings → Connections (Warehouse): no "Master records" card; just Warehouse + App cards.

Capture any issue as a checklist item below; fix; recommit.

- [ ] **Step 5: Final commit if any cleanup landed during the sweep**

```bash
git add -p
git commit -m "polish(app): integrations UI cleanup from manual sweep"
```

---

## Self-review summary

Coverage map against design §6 + §10 Phase 2:

| Spec item | Task |
|---|---|
| §6.1 nav entry + `/integrations` route + redirect to pull-api | 4, 5, 6 |
| §6.2 Pull API page (banner, auth, endpoints, dim table, pagination, rate limits, Webhooks tab + signing recipe) | 7, 8 |
| §6.3 Webhooks list (status badges, duplicate-URL chip, empty state, +New) | 9 |
| §6.3 Create webhook modal + secret-reveal modal | 10 |
| §6.3 Detail Overview (URL, chips, status PATCH, kid badge during grace, Rotate, recipe link) | 11 |
| §6.3 Send test event | 11 |
| §6.3 Delivery log (TEST badge, expand row, Replay, viewer mask) | 12 |
| §6.3 Delete via ConfirmDialog (typed URL) | 11 |
| §6.4 Service accounts (list, create, revoke, secret reveal) | 13 |
| §6.5 Master records card removed | 14 |
| §6.6 AppShell nav update | 6 |
| §6.7 DeveloperDetails disclosure pattern | 7, 8, 12, 13 |
| §9 permission matrix (incl viewer payload mask) | 2, 12 |
| §10 Phase 2 — IntegrationsLayout / sidebar / `permissions.ts` / `ConfirmDialog` reuse | 5, 2, 11 |
| §10 Phase 2 — UI calls /v1/ (cookie auth required) | 1 |

Out-of-scope (per design §10 Phase 3 explicitly non-blocking and §11): public docs site, GraphQL, streaming subscriber API, OAuth consent screens, configurable retention.
