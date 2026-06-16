/**
 * Tenant-aware fetch wrapper. Derives the active tenant slug from
 * window.location.pathname (`/app/<slug>/...`) and rewrites paths:
 *   `/foo`         → `/api/t/<slug>/foo`         (regular)
 *   `/admin/foo`   → `/api/admin/foo`            (super-admin override)
 *   `/foo` (admin) → `/api/admin/foo`            (slug === "admin")
 *   `/foo` (none)  → `/api/foo`                  (pre-login: /login, /signup)
 *
 * No module state. The URL is the source of truth — switching tenants is a
 * react-router navigation, the next apiFetch picks up the new slug.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const m = /^\/app\/([^/]+)\//.exec(window.location.pathname + "/");
  const slug = m?.[1] ?? "";
  const url = path.startsWith("/admin/")
    ? `/api${path}`
    : slug === "admin"
      ? `/api/admin${path}`
      : slug
        ? `/api/t/${slug}${path}`
        : `/api${path}`;
  return fetch(url, { ...init, credentials: "include" });
}

/**
 * Pre-login fetch wrapper. Always `/api${path}`, never tenant-prefixed.
 * Use for `/auth/me`, `/auth/logout`, `/auth/dev`, `/auth/config`, `/auth/login`,
 * `/auth/signup`, and `/me/memberships` (called pre-tenant-resolve in BootGate).
 */
export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api${path}`, { ...init, credentials: "include" });
}

/**
 * Deployment-global warehouse health probe. Returns reachability state.
 * Backed by `GET /api/warehouse/health`.
 */
export async function fetchWarehouseHealth(): Promise<{ ok: boolean; reason?: string }> {
  const res = await authFetch("/warehouse/health");
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  return (await res.json()) as { ok: boolean; reason?: string };
}

/**
 * Deployment-global warehouse database list. Visible to any authenticated user;
 * super-admin gates writes (POST/PATCH/DELETE) at the server layer.
 * Backed by `GET /api/warehouse/databases`.
 */
export async function fetchWarehouseDatabases(): Promise<
  Array<{
    id: string;
    databaseName: string;
    label: string | null;
    addedAt: string;
    lastProbeAt: string | null;
    lastProbeError: string | null;
    sourceCount: number;
    schemaCount: number | null;
  }>
> {
  const res = await authFetch("/warehouse/databases");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}
