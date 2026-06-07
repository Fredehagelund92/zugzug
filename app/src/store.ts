import { useSyncExternalStore } from "react";
import type { MappingDimension, OptionDef, PaletteName, NumberFormat } from "./data";
import type { ConditionalRule } from "./components/datagrid/types";

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

export interface User {
  id: string;
  name: string;
  initials: string;
  email?: string;
}
export interface Draft {
  dimId: string;
  raw: string;
  status: "mapped" | "skipped";
  targetLabel: string | null;
  targetKey: string | null;
  user: User;
  at: string;
}
export interface AuditEntry {
  id: string;
  at: string;
  user: User;
  action: string;
  detail: string;
}
/** A registered warehouse source column for a dimension (from the source registry,
 *  not the scan) — so the UI shows the tables even with zero warehouse rows. */
export interface SourceInfo {
  table: string;
  column: string;
  dimension: string;
  dimId: string;
  present: boolean;
  rows: number;
  values: number;
  unmapped: number;
  scanned: boolean;
  scannedAt?: string | null; // ISO timestamp of last scan
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
/** flat key for a per-(dimension,value) draft — matches the workbench overlay. */
export const dkey = (dimId: string, raw: string) => `${dimId}::${raw}`;

/* ---- session identity (populated by initStore before first render) ---- */
export let currentUser: User = { id: "u_ada", name: "Ada Berg", initials: "AB" };
export let collaborators: User[] = [currentUser];

export interface Preferences {
  publishThreshold: number;
  suggestThreshold: number;
  scanSchedule: "15m" | "hourly" | "daily" | null;
}

/* ---- in-memory cache of server state ---- */
let dims: MappingDimension[] = [];
let sources: SourceInfo[] = [];
let draftsFlat: Record<string, Draft> = {};
let audit: AuditEntry[] = [];
let preferences: Preferences = { publishThreshold: 95, suggestThreshold: 80, scanSchedule: null };

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const emit = () => listeners.forEach((l) => l());

/* ---- fetch helper (Vite proxies /api → the Bun server) ---- */
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...opts?.headers },
  });
  if (!res.ok)
    throw new Error(
      `${opts?.method ?? "GET"} ${path} → ${res.status} ${await res.text().catch(() => "")}`,
    );
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

async function refreshDims(): Promise<void> {
  // Single HTTP request returns every dim's full shape — the old code did 1
  // list call + N detail fetches (N+1) on every mutation that refreshed dims.
  dims = await api<MappingDimension[]>("/dimensions?full=true");
}
async function refreshDim(dimId: string): Promise<void> {
  const dim = await api<MappingDimension>(`/dimensions/${encodeURIComponent(dimId)}`);
  dims = dims.map((d) => (d.id === dim.id ? dim : d));
}
async function refreshDrafts(dimId?: string): Promise<void> {
  if (dimId) {
    const list = await api<Draft[]>(`/dimensions/${encodeURIComponent(dimId)}/drafts`);
    const next: Record<string, Draft> = {};
    for (const [k, d] of Object.entries(draftsFlat)) if (d.dimId !== dimId) next[k] = d;
    for (const d of list) next[dkey(d.dimId, d.raw)] = d;
    draftsFlat = next;
    return;
  }
  const lists = await Promise.all(
    dims.map((d) => api<Draft[]>(`/dimensions/${encodeURIComponent(d.id)}/drafts`)),
  );
  const flat: Record<string, Draft> = {};
  for (const list of lists) for (const d of list) flat[dkey(d.dimId, d.raw)] = d;
  draftsFlat = flat;
}
async function refreshAudit(): Promise<void> {
  audit = await api<AuditEntry[]>("/audit?limit=30");
}
async function refreshSources(): Promise<void> {
  sources = await api<SourceInfo[]>("/sources");
}
async function refreshPreferences(): Promise<void> {
  preferences = await api<Preferences>("/preferences");
}

/** Preload everything once. Awaited in main.tsx so the first render has data.
 *  Independent slices run in parallel; refreshDrafts is sequential because it
 *  iterates the dims it just fetched. Cold boot drops from 6 sequential RTTs
 *  to 3 (users → 4-in-parallel → drafts). */
export async function initStore(): Promise<void> {
  const u = await api<{ currentUser: User; collaborators: User[] }>("/users");
  currentUser = u.currentUser;
  collaborators = u.collaborators;
  await Promise.all([refreshDims(), refreshSources(), refreshAudit(), refreshPreferences()]);
  await refreshDrafts();
  emit();
}

/* ---- hooks (sync reads of the cache) ---- */
export function useDimensions(): MappingDimension[] {
  return useSyncExternalStore(
    subscribe,
    () => dims,
    () => dims,
  );
}
export function useDrafts(): Record<string, Draft> {
  return useSyncExternalStore(
    subscribe,
    () => draftsFlat,
    () => draftsFlat,
  );
}
export function useAudit(): AuditEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => audit,
    () => audit,
  );
}
export function useSources(): SourceInfo[] {
  return useSyncExternalStore(
    subscribe,
    () => sources,
    () => sources,
  );
}
export function usePreferences(): Preferences {
  return useSyncExternalStore(
    subscribe,
    () => preferences,
    () => preferences,
  );
}

export async function setPreferences(p: Preferences): Promise<void> {
  await api("/preferences", { method: "PUT", body: JSON.stringify(p) });
  await refreshPreferences();
  emit();
}

/* ---- mutations (write through the API, then refetch the affected slice) ---- */
export async function addDimension(
  name: string,
  keyKind?: "slug" | "external_id",
): Promise<string> {
  const { id } = await api<{ id: string }>("/dimensions", {
    method: "POST",
    body: JSON.stringify({ name, keyKind }),
  });
  await refreshDims();
  await refreshSources();
  await refreshAudit();
  emit();
  return id;
}

export type CreateTableMode = "blank" | "source" | "external_id";

export interface ColumnDraft {
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select";
  options?: OptionDef[];
}

export interface CreateTableInput {
  name: string;
  description?: string | null;
  color?: PaletteName | null;
  mode: CreateTableMode;
  columns?: ColumnDraft[];
  source?: { table: string; column: string };
  external?: { table: string; idColumn: string; nameColumn: string };
}

export interface CreateTableError {
  error: string;
  code: "NAME_TAKEN" | "WAREHOUSE_OFFLINE" | "MISSING_PICKER" | "INVALID";
}

/** Create a table via the orchestrator. Returns the new dim id on success.
 *  Throws an Error with .message set to the server's `error` string and a
 *  numeric `.code` attached for the modal to render an inline banner. */
export async function createTable(input: CreateTableInput): Promise<string> {
  const res = await fetch(`/api/tables`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res
      .json()
      .catch(() => ({ error: `HTTP ${res.status}` }))) as CreateTableError;
    const e = new Error(body.error ?? "create failed") as Error & { code?: string };
    e.code = body.code;
    throw e;
  }
  const { id } = (await res.json()) as { id: string };
  await refreshDims();
  await refreshSources();
  await refreshAudit();
  emit();
  return id;
}

export async function saveDraft(
  dimId: string,
  raw: string,
  status: "mapped" | "skipped",
  targetLabel: string | null,
  targetKey: string | null,
): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/drafts`, {
    method: "PUT",
    body: JSON.stringify({ raw, status, targetLabel, targetKey }),
  });
  await refreshDrafts(dimId);
  emit();
}

export async function discardDraft(dimId: string, raw: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/drafts/${encodeURIComponent(raw)}`, {
    method: "DELETE",
  });
  await refreshDrafts(dimId);
  emit();
}

/** All staged edits for a dimension (sync read of the cache). */
export function listDrafts(dimId: string): Draft[] {
  return Object.values(draftsFlat).filter((d) => d.dimId === dimId);
}

/** Approve & commit the dimension's mapped drafts (server folds them into the
 *  canonical tables in one batch). Returns the count + warehouse rows recovered. */
export async function commit(dimId: string): Promise<{ committed: number; rowsRecovered: number }> {
  const res = await api<{ committed: number; rowsRecovered: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/commit`,
    { method: "POST" },
  );
  await refreshDim(dimId);
  await refreshDrafts(dimId);
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
  await api(`/dimensions/${encodeURIComponent(dimId)}/sources`, {
    method: "POST",
    body: JSON.stringify({ table, column }),
  });
  await refreshSources();
  emit();
}

/** Top-N unmapped raw values from a specific warehouse source column. Drives
 *  the per-row "see what's actually unmapped" reveal on the Sources page. */
export interface UnmappedSample {
  raw: string;
  rows: number;
}
export async function fetchUnmappedSample(
  dimId: string,
  table: string,
  column: string,
  limit = 5,
): Promise<UnmappedSample[]> {
  const qs = new URLSearchParams({ dimId, table, column, limit: String(limit) });
  return api<UnmappedSample[]>(`/sources/unmapped?${qs.toString()}`);
}

/** Seed a dimension's canonical set from a source column's distinct values
 *  (also wires the column). Returns how many canonical records resulted. */
export async function deriveCanonical(
  dimId: string,
  table: string,
  column: string,
  nameColumn?: string,
): Promise<number> {
  const { derived } = await api<{ derived: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/derive`,
    { method: "POST", body: JSON.stringify({ table, column, nameColumn }) },
  );
  await refreshDim(dimId);
  await refreshSources();
  await refreshAudit();
  emit();
  return derived;
}

/* ---- canonical record management (governed, persisted) ---- */
export async function addCanonical(dimId: string, label: string, key?: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/canonical`, {
    method: "POST",
    body: JSON.stringify({ label, key }),
  });
  await refreshDim(dimId);
  await refreshAudit();
  emit();
}
export async function renameCanonical(dimId: string, key: string, label: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify({ label }),
  });
  await refreshDim(dimId);
  await refreshAudit();
  emit();
}
export async function mergeCanonical(
  dimId: string,
  survivor: string,
  losers: string[],
): Promise<number> {
  const { merged } = await api<{ merged: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/merge?confirm=true`,
    { method: "POST", body: JSON.stringify({ survivor, losers }) },
  );
  await refreshDim(dimId);
  await refreshSources();
  await refreshAudit();
  emit();
  return merged;
}
/** Retire a canonical — returns {ok:false, variants} if still mapped (governed). */
export async function retireCanonical(
  dimId: string,
  key: string,
): Promise<{ ok: boolean; variants: number }> {
  const res = await api<{ ok: boolean; variants: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );
  if (res.ok) {
    await refreshDim(dimId);
    await refreshAudit();
    emit();
  }
  return res;
}
/** The raw variants resolving to a canonical key (lineage). */
export async function fetchVariants(dimId: string, key: string): Promise<string[]> {
  return api<string[]>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}/variants`,
  );
}

/** Add an enrichment attribute column to a dimension (text|number|boolean|date|select|linked).
 *  For `select`, `options` seeds the allowed list; for `linked`, pass `referencedDimId` and optionally `displayFields`; otherwise omit extras. */
export async function addField(
  dimId: string,
  label: string,
  type = "text",
  options?: OptionDef[],
  extras?: {
    numberFormat?: NumberFormat;
    ratingMax?: number;
    referencedDimId?: string;
    displayFields?: string[];
  },
): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields`, {
    method: "POST",
    body: JSON.stringify({ label, type, options, ...extras }),
  });
  await refreshDim(dimId);
  await refreshAudit();
  emit();
}

/** Append a new option to a select column's allowed list. Refetches the
 *  dimension so subsequent picks see the new option. Returns the new list. */
export async function addColumnOption(
  dimId: string,
  field: string,
  label: string,
  color: PaletteName | null = null,
): Promise<OptionDef[]> {
  const res = await api<{ options: OptionDef[] }>(
    `/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}/options`,
    { method: "POST", body: JSON.stringify({ label, color }) },
  );
  await refreshDim(dimId);
  emit();
  return res.options;
}

export async function renameColumn(dimId: string, field: string, newLabel: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`, {
    method: "PUT",
    body: JSON.stringify({ label: newLabel }),
  });
  await refreshDim(dimId);
  emit();
}

export async function changeColumnType(
  dimId: string,
  field: string,
  newType: string,
  options?: OptionDef[],
  coerceInvalidToNull = false,
  numberFormat?: NumberFormat,
  ratingMax?: number,
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
  const res = await api<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }>(
    `/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`,
    { method: "PUT", body: JSON.stringify({ type: newType, options, coerceInvalidToNull, numberFormat, ratingMax }) },
  );
  if (res.ok) {
    await refreshDim(dimId);
    emit();
  }
  return res;
}

export async function deleteColumn(dimId: string, field: string): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`, {
    method: "DELETE",
  });
  await refreshDim(dimId);
  emit();
}

/** Persist conditional formatting rules for a field. Merges rules into the
 *  existing field_config JSON so other config keys (options, numberFormat, etc.)
 *  are preserved. */
export async function updateFieldRules(
  dimId: string,
  field: string,
  rules: ConditionalRule[],
): Promise<void> {
  // Fetch current dimension to get the existing field_config
  const dim = await api<{ fields: Array<{ field: string; field_config?: string }> }>(
    `/dimensions/${encodeURIComponent(dimId)}`,
  );
  const existing = dim.fields?.find((f) => f.field === field);
  let cfg: Record<string, unknown> = {};
  if (existing?.field_config) {
    try {
      cfg = JSON.parse(existing.field_config) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
  }
  cfg.rules = rules;
  await api(`/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`, {
    method: "PATCH",
    body: JSON.stringify({ field_config: JSON.stringify(cfg) }),
  });
  await refreshDim(dimId);
  emit();
}

export interface GridLayoutConfig {
  widths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
}

export async function getGridLayout(dimId: string): Promise<GridLayoutConfig> {
  return await api<GridLayoutConfig>(`/grid-layout/${encodeURIComponent(dimId)}`);
}

// debounce key per dimension so concurrent edits to different dims don't
// collide on a single timer
const layoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingLayouts = new Map<string, GridLayoutConfig>();

export function setGridLayout(dimId: string, partial: GridLayoutConfig): void {
  const merged = { ...(pendingLayouts.get(dimId) ?? {}), ...partial };
  pendingLayouts.set(dimId, merged);
  const t = layoutTimers.get(dimId);
  if (t) clearTimeout(t);
  layoutTimers.set(
    dimId,
    setTimeout(() => {
      const body = pendingLayouts.get(dimId) ?? {};
      pendingLayouts.delete(dimId);
      layoutTimers.delete(dimId);
      void api(`/grid-layout/${encodeURIComponent(dimId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
    }, 400),
  );
}
/** Set an enrichment field value on a canonical record. */
export async function setFieldValue(
  dimId: string,
  key: string,
  field: string,
  value: string | null,
): Promise<void> {
  await api(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}/field/${encodeURIComponent(field)}`,
    { method: "PUT", body: JSON.stringify({ value }) },
  );
  await refreshDim(dimId);
  emit();
}

export interface CatalogTable {
  schema: string;
  table: string;
  columns: string[];
}
export interface CatalogResult {
  rows: CatalogTable[];
  total: number;
  schemas: { schema: string; tables: number }[];
}

/** Browse/search the warehouse catalog — server-side, paginated. Not cached:
 *  the explorer holds its own results, so it scales to any catalog size. */
export async function searchCatalog(
  opts: { q?: string; schema?: string; limit?: number; offset?: number } = {},
): Promise<CatalogResult> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  if (opts.schema) qs.set("schema", opts.schema);
  qs.set("limit", String(opts.limit ?? 50));
  qs.set("offset", String(opts.offset ?? 0));
  return api<CatalogResult>(`/catalog?${qs.toString()}`);
}
