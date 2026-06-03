import { useSyncExternalStore } from "react";
import type { MappingDimension } from "./data";

/* ============================================================================
   Store — now backed by the real backend (server/) over /api (Vite proxies it).
   The three stores from ARCHITECTURE.md live behind this seam: canonical dim_/map_
   + drafts + audit + users in Postgres; the warehouse scan in MotherDuck (when
   ATTACH_WAREHOUSE=true). The hook shapes are unchanged, so components consume
   them exactly as before — only the source of truth moved from memory to HTTP.

   Data is preloaded once via initStore() (awaited in main.tsx before first
   render, so useDimensions() is populated synchronously); mutations POST/PUT/
   DELETE then refetch the affected slice and notify subscribers.
   ============================================================================ */

export interface User { id: string; name: string; initials: string }
export interface Draft {
  dimId: string; raw: string; status: "mapped" | "skipped";
  targetLabel: string | null; targetKey: string | null; user: User; at: string;
}
export interface AuditEntry { id: string; at: string; user: User; action: string; detail: string }
/** A registered warehouse source column for a dimension (from the source registry,
 *  not the scan) — so the UI shows the tables even with zero warehouse rows. */
export interface SourceInfo {
  table: string; column: string; dimension: string; dimId: string;
  present: boolean; rows: number; values: number; unmapped: number; scanned: boolean;
  schedule?: string | null;     // null | '15m' | 'hourly' | 'daily'
  scannedAt?: string | null;    // ISO timestamp of last scan
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
/** flat key for a per-(dimension,value) draft — matches the workbench overlay. */
export const dkey = (dimId: string, raw: string) => `${dimId}::${raw}`;

/* ---- session identity (populated by initStore before first render) ---- */
export let currentUser: User = { id: "u_ada", name: "Ada Berg", initials: "AB" };
export let collaborators: User[] = [currentUser];

export interface Preferences { publishThreshold: number; suggestThreshold: number }

/* ---- in-memory cache of server state ---- */
let dims: MappingDimension[] = [];
let sources: SourceInfo[] = [];
let draftsFlat: Record<string, Draft> = {};
let audit: AuditEntry[] = [];
let preferences: Preferences = { publishThreshold: 95, suggestThreshold: 80 };

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
const emit = () => listeners.forEach((l) => l());

/* ---- fetch helper (Vite proxies /api → the Bun server) ---- */
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "content-type": "application/json", "x-user-id": currentUser.id, ...opts?.headers },
  });
  if (!res.ok) throw new Error(`${opts?.method ?? "GET"} ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

async function refreshDims(): Promise<void> {
  const metas = await api<{ id: string }[]>("/dimensions");
  dims = await Promise.all(metas.map((m) => api<MappingDimension>(`/dimensions/${encodeURIComponent(m.id)}`)));
}
async function refreshDrafts(): Promise<void> {
  const lists = await Promise.all(dims.map((d) => api<Draft[]>(`/dimensions/${encodeURIComponent(d.id)}/drafts`)));
  const flat: Record<string, Draft> = {};
  for (const list of lists) for (const d of list) flat[dkey(d.dimId, d.raw)] = d;
  draftsFlat = flat;
}
async function refreshAudit(): Promise<void> { audit = await api<AuditEntry[]>("/audit?limit=30"); }
async function refreshSources(): Promise<void> { sources = await api<SourceInfo[]>("/sources"); }
async function refreshPreferences(): Promise<void> { preferences = await api<Preferences>("/preferences"); }

/** Preload everything once. Awaited in main.tsx so the first render has data. */
export async function initStore(): Promise<void> {
  const u = await api<{ currentUser: User; collaborators: User[] }>("/users");
  currentUser = u.currentUser;
  collaborators = u.collaborators;
  await refreshDims();
  await refreshDrafts();
  await refreshSources();
  await refreshAudit();
  await refreshPreferences();
  emit();
}

/* ---- hooks (sync reads of the cache) ---- */
export function useDimensions(): MappingDimension[] { return useSyncExternalStore(subscribe, () => dims, () => dims); }
export function useDrafts(): Record<string, Draft> { return useSyncExternalStore(subscribe, () => draftsFlat, () => draftsFlat); }
export function useAudit(): AuditEntry[] { return useSyncExternalStore(subscribe, () => audit, () => audit); }
export function useSources(): SourceInfo[] { return useSyncExternalStore(subscribe, () => sources, () => sources); }
export function usePreferences(): Preferences { return useSyncExternalStore(subscribe, () => preferences, () => preferences); }

export async function setPreferences(p: Preferences): Promise<void> {
  await api("/preferences", { method: "PUT", body: JSON.stringify(p) });
  await refreshPreferences();
  emit();
}

/* ---- mutations (write through the API, then refetch the affected slice) ---- */
export async function addDimension(name: string, keyKind?: "slug" | "external_id"): Promise<string> {
  const { id } = await api<{ id: string }>("/dimensions", { method: "POST", body: JSON.stringify({ name, keyKind }) });
  await refreshDims();
  await refreshSources();
  await refreshAudit();
  emit();
  return id;
}

export async function saveDraft(dimId: string, raw: string, status: "mapped" | "skipped", targetLabel: string | null, targetKey: string | null): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/drafts`, { method: "PUT", body: JSON.stringify({ raw, status, targetLabel, targetKey }) });
  await refreshDrafts();
  emit();
}

export async function discardDraft(dimId: string, raw: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/drafts/${encodeURIComponent(raw)}`, { method: "DELETE" });
  await refreshDrafts();
  emit();
}

/** All staged edits for a dimension (sync read of the cache). */
export function listDrafts(dimId: string): Draft[] {
  return Object.values(draftsFlat).filter((d) => d.dimId === dimId);
}

/** Approve & commit the dimension's mapped drafts (server folds them into the
 *  canonical tables in one batch). Returns the count + warehouse rows recovered. */
export async function commit(dimId: string): Promise<{ committed: number; rowsRecovered: number }> {
  const res = await api<{ committed: number; rowsRecovered: number }>(`/dimensions/${encodeURIComponent(dimId)}/commit`, { method: "POST" });
  await refreshDims();
  await refreshDrafts();
  await refreshSources();
  await refreshAudit();
  emit();
  return res;
}

export async function appendAudit(action: string, detail: string): Promise<void> {
  await api("/audit", { method: "POST", body: JSON.stringify({ action, detail }) });
  await refreshAudit();
  emit();
}

/* ---- sources / catalog (the scale surface) ---- */

/** Refresh the cached scan stats for every registered source (rows / unmapped). */
export async function scanSources(): Promise<number> {
  const { scanned } = await api<{ scanned: number }>("/sources/scan", { method: "POST" });
  await refreshSources();
  emit();
  return scanned;
}

/** Wire a warehouse column to a dimension, then refresh the sources list. */
export async function addSource(dimId: string, table: string, column: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/sources`, { method: "POST", body: JSON.stringify({ table, column }) });
  await refreshSources();
  emit();
}

/** Set (or clear) an automatic scan cadence on a wired source. */
export async function setSourceSchedule(dimId: string, table: string, column: string, schedule: string | null): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/sources/schedule`, {
    method: "PUT",
    body: JSON.stringify({ table, column, schedule }),
  });
  await refreshSources();
  emit();
}

/** Seed a dimension's canonical set from a source column's distinct values
 *  (also wires the column). Returns how many canonical records resulted. */
export async function deriveCanonical(dimId: string, table: string, column: string, nameColumn?: string): Promise<number> {
  const { derived } = await api<{ derived: number }>(`/dimensions/${encodeURIComponent(dimId)}/derive`, { method: "POST", body: JSON.stringify({ table, column, nameColumn }) });
  await refreshDims();
  await refreshSources();
  await refreshAudit();
  emit();
  return derived;
}

/* ---- canonical record management (governed, persisted) ---- */
export async function addCanonical(dimId: string, label: string, key?: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/canonical`, { method: "POST", body: JSON.stringify({ label, key }) });
  await refreshDims(); await refreshAudit(); emit();
}
export async function renameCanonical(dimId: string, key: string, label: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ label }) });
  await refreshDims(); await refreshAudit(); emit();
}
export async function mergeCanonical(dimId: string, survivor: string, losers: string[]): Promise<number> {
  const { merged } = await api<{ merged: number }>(`/dimensions/${encodeURIComponent(dimId)}/canonical/merge`, { method: "POST", body: JSON.stringify({ survivor, losers }) });
  await refreshDims(); await refreshSources(); await refreshAudit(); emit();
  return merged;
}
/** Retire a canonical — returns {ok:false, variants} if still mapped (governed). */
export async function retireCanonical(dimId: string, key: string): Promise<{ ok: boolean; variants: number }> {
  const res = await api<{ ok: boolean; variants: number }>(`/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (res.ok) { await refreshDims(); await refreshAudit(); emit(); }
  return res;
}
/** The raw variants resolving to a canonical key (lineage). */
export async function fetchVariants(dimId: string, key: string): Promise<string[]> {
  return api<string[]>(`/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}/variants`);
}

/** Add an enrichment attribute column to a dimension (text|number|boolean|date). */
export async function addField(dimId: string, label: string, type = "text"): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields`, { method: "POST", body: JSON.stringify({ label, type }) });
  await refreshDims(); await refreshAudit(); emit();
}
/** Set an enrichment field value on a canonical record. */
export async function setFieldValue(dimId: string, key: string, field: string, value: string | null): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}/field/${encodeURIComponent(field)}`, { method: "PUT", body: JSON.stringify({ value }) });
  await refreshDims(); emit();
}

export interface CatalogTable { schema: string; table: string; columns: string[] }
export interface CatalogResult { rows: CatalogTable[]; total: number; schemas: { schema: string; tables: number }[] }

/** Browse/search the warehouse catalog — server-side, paginated. Not cached:
 *  the explorer holds its own results, so it scales to any catalog size. */
export async function searchCatalog(opts: { q?: string; schema?: string; limit?: number; offset?: number } = {}): Promise<CatalogResult> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.schema) qs.set("schema", opts.schema);
  qs.set("limit", String(opts.limit ?? 50));
  qs.set("offset", String(opts.offset ?? 0));
  return api<CatalogResult>(`/catalog?${qs.toString()}`);
}
