import { useSyncExternalStore, useState, useEffect } from "react";
import type {
  CanonicalValue,
  MappingDimension,
  OptionDef,
  PaletteName,
  NumberFormat,
} from "./data";
import type { ConditionalRule } from "./components/datagrid/types";
import { apiFetch, authFetch } from "./api";

/** Thrown by client mutation helpers on HTTP 409 from the server.
 *  Callers (TablePane) inspect `current` to render the inline conflict banner. */
export class ConflictError extends Error {
  constructor(
    public current: {
      version: number;
      updatedAt: string;
      updatedBy: { id: string; name: string; initials: string };
    },
    public conflictedKeys?: string[],
  ) {
    super("Record was modified by another user");
    this.name = "ConflictError";
  }
}

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

/** The signed-in user with RBAC role. Returned by /api/auth/me and exposed via
 *  useCurrentUser(). Distinct from User (collaborator shape) which lacks role. */
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  initials: string;
  role: "admin" | "editor" | "viewer";
}

function isCurrentUser(x: unknown): x is CurrentUser {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.email === "string" &&
    typeof o.initials === "string" &&
    (o.role === "admin" || o.role === "editor" || o.role === "viewer")
  );
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
/** Full session user including role. Populated by initStore via /api/auth/me. */
let currentUserFull: CurrentUser | null = null;

export interface Preferences {
  publishThreshold: number;
  suggestThreshold: number;
  scanSchedule: "15m" | "hourly" | "daily" | null;
}

export interface WorkspaceInfo {
  adapter: "duckdb" | "snowflake";
  writable: boolean;
  canonicalMode: "warehouse" | "postgres-export";
  warehouseDb: string | null;
  defaultEngineerMode: boolean;
}

let _workspaceInfoCache: WorkspaceInfo | null = null;
let _workspaceInfoPromise: Promise<WorkspaceInfo | null> | null = null;

function isWorkspaceInfo(x: unknown): x is WorkspaceInfo {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    (o.adapter === "duckdb" || o.adapter === "snowflake") &&
    typeof o.writable === "boolean" &&
    (o.canonicalMode === "warehouse" || o.canonicalMode === "postgres-export") &&
    (o.warehouseDb === null || typeof o.warehouseDb === "string") &&
    typeof o.defaultEngineerMode === "boolean"
  );
}

export interface AuthConfig {
  mode: "password" | "oidc";
  signupOpen: boolean;
  allowedDomain: string | null;
  oidcLabel?: string;
}

let _authConfigCache: AuthConfig | null = null;
let _authConfigPromise: Promise<AuthConfig | null> | null = null;

// One AbortController per tenant session. Aborted by onTenantSwitch().
let tenantSessionController = new AbortController();

/** Called by TenantLayout when the URL slug changes. */
export function onTenantSwitch(): void {
  tenantSessionController.abort();
  tenantSessionController = new AbortController();
  cancelDebouncedTimers();
  resetStore();
}

function resetStore(): void {
  dims = [];
  sources = [];
  draftsFlat = {};
  audit = [];
  preferences = { publishThreshold: 95, suggestThreshold: 80, scanSchedule: null };
  _authConfigCache = null;
  _authConfigPromise = null;
  _workspaceInfoCache = null;
  _workspaceInfoPromise = null;
  connectionHealth = null;
  currentUser = { id: "u_ada", name: "Ada Berg", initials: "AB" };
  collaborators = [];
  currentUserFull = null;
  pendingWrites = 0;
  syncStatus = "idle";
  if (savedDecayTimer) {
    clearTimeout(savedDecayTimer);
    savedDecayTimer = null;
  }
  emitSync();
  emit();
}

// Track debounced timers so they can be cancelled on tenant switch.
const _debouncedTimers = new Set<ReturnType<typeof setTimeout>>();
export function trackDebouncedTimer(t: ReturnType<typeof setTimeout>): void {
  _debouncedTimers.add(t);
}
function cancelDebouncedTimers(): void {
  for (const t of _debouncedTimers) clearTimeout(t);
  _debouncedTimers.clear();
}

function isAuthConfig(x: unknown): x is AuthConfig {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o.mode !== "password" && o.mode !== "oidc") return false;
  if (typeof o.signupOpen !== "boolean") return false;
  if (o.allowedDomain !== null && typeof o.allowedDomain !== "string") return false;
  if (o.oidcLabel !== undefined && typeof o.oidcLabel !== "string") return false;
  return true;
}

export function useAuthConfig(): AuthConfig | null {
  const [cfg, setCfg] = useState<AuthConfig | null>(_authConfigCache);
  useEffect(() => {
    if (_authConfigCache) return;
    if (!_authConfigPromise) {
      _authConfigPromise = (async () => {
        const r = await authFetch("/auth/config");
        if (!r.ok) return null;
        const data: unknown = await r.json().catch(() => null);
        if (!isAuthConfig(data)) return null;
        _authConfigCache = data;
        return data;
      })();
    }
    _authConfigPromise.then((data) => setCfg(data));
  }, []);
  return cfg;
}

export function useWorkspaceInfo(): WorkspaceInfo | null {
  const [info, setInfo] = useState<WorkspaceInfo | null>(_workspaceInfoCache);
  useEffect(() => {
    if (_workspaceInfoCache) return;
    if (!_workspaceInfoPromise) {
      _workspaceInfoPromise = (async () => {
        const r = await apiFetch("/workspace/info");
        if (!r.ok) return null;
        const data: unknown = await r.json().catch(() => null);
        if (!isWorkspaceInfo(data)) return null;
        _workspaceInfoCache = data;
        return data;
      })();
    }
    _workspaceInfoPromise.then((data) => setInfo(data));
  }, []);
  return info;
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

/* ---- sync status (own listener channel — NOT the global emit() bus, which
   would re-render every store subscriber on every write start/settle) ---- */
export type SyncStatus = "idle" | "saving" | "saved";
let pendingWrites = 0;
let syncStatus: SyncStatus = "idle";
let savedDecayTimer: ReturnType<typeof setTimeout> | null = null;
const syncListeners = new Set<() => void>();
const emitSync = () => syncListeners.forEach((l) => l());

function writeStarted(): void {
  pendingWrites++;
  if (savedDecayTimer) clearTimeout(savedDecayTimer);
  if (syncStatus !== "saving") {
    syncStatus = "saving";
    emitSync();
  }
}
function writeSettled(): void {
  pendingWrites--;
  if (pendingWrites > 0) return;
  syncStatus = "saved";
  emitSync();
  savedDecayTimer = setTimeout(() => {
    syncStatus = "idle";
    emitSync();
  }, 1500);
}

const subscribeSync = (l: () => void) => {
  syncListeners.add(l);
  return () => syncListeners.delete(l);
};

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    subscribeSync,
    () => syncStatus,
    () => syncStatus,
  );
}

/* ---- fetch helper (Vite proxies /api → the Bun server) ---- */
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const isWrite = !!opts?.method && opts.method !== "GET";
  if (isWrite) writeStarted();
  try {
    return await apiInner<T>(path, opts);
  } finally {
    if (isWrite) writeSettled();
  }
}

async function apiInner<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...opts,
    signal: opts?.signal ?? tenantSessionController.signal,
    headers: { "content-type": "application/json", ...opts?.headers },
  });
  if (!res.ok) {
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as {
        details?: {
          current?: ConflictError["current"];
          conflictedKeys?: string[];
        };
      };
      if (body.details?.current) {
        throw new ConflictError(body.details.current, body.details.conflictedKeys);
      }
    }
    throw new Error(
      `${opts?.method ?? "GET"} ${path} → ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
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
/** Live read of one canonical record from the cache. Undo/redo closures use
 *  this instead of a render-captured list — the captured snapshot's version
 *  is always stale after the very mutation being undone. */
export function getCanonical(dimId: string, key: string): CanonicalValue | undefined {
  return dims.find((d) => d.id === dimId)?.canonical.find((c) => c.key === key);
}

/** Immutably patch one canonical record in the cache (optimistic updates). */
function patchCanonical(
  dimId: string,
  key: string,
  patch: (c: CanonicalValue) => CanonicalValue,
): void {
  dims = dims.map((d) =>
    d.id !== dimId
      ? d
      : { ...d, canonical: d.canonical.map((c) => (c.key === key ? patch(c) : c)) },
  );
}
/** Re-fetch a single dimension from the server and notify subscribers.
 *  Used by ConflictBanner's "Refresh row" button to pull the latest version
 *  after a 409 conflict without reloading the whole workspace. */
export async function refreshDimAndNotify(dimId: string): Promise<void> {
  await refreshDim(dimId);
  emit();
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
  const [u, meRaw] = await Promise.all([
    api<{ currentUser: User; collaborators: User[] }>("/users"),
    authFetch("/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);
  currentUser = u.currentUser;
  collaborators = u.collaborators;
  if (isCurrentUser(meRaw)) currentUserFull = meRaw;
  await Promise.all([
    refreshDims(),
    refreshSources(),
    refreshAudit(),
    refreshPreferences(),
    refreshConnectionHealth(),
  ]);
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
export function useCurrentUser(): CurrentUser | null {
  return useSyncExternalStore(
    subscribe,
    () => currentUserFull,
    () => currentUserFull,
  );
}

/** Convenience: true when the current user may mutate state (not a viewer).
 *  Defaults to false during the brief initial-load window where currentUser is null. */
export function useCanEdit(): boolean {
  const user = useCurrentUser();
  if (!user) return false;
  return user.role !== "viewer";
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
  const res = await apiFetch("/tables", {
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

/** Stage a draft. Optimistic: the row flips in the same frame; the server echo
 *  (authoritative `at`/`user`) reconciles via a background drafts refresh. */
export async function saveDraft(
  dimId: string,
  raw: string,
  status: "mapped" | "skipped",
  targetLabel: string | null,
  targetKey: string | null,
): Promise<void> {
  const k = dkey(dimId, raw);
  const prev = draftsFlat[k];
  draftsFlat = {
    ...draftsFlat,
    [k]: {
      dimId,
      raw,
      status,
      targetLabel,
      targetKey,
      user: currentUser,
      at: new Date().toISOString(),
    },
  };
  emit();
  try {
    await api(`/dimensions/${encodeURIComponent(dimId)}/drafts`, {
      method: "PUT",
      body: JSON.stringify({ raw, status, targetLabel, targetKey }),
    });
  } catch (e) {
    const next = { ...draftsFlat };
    if (prev) next[k] = prev;
    else delete next[k];
    draftsFlat = next;
    emit();
    throw e;
  }
  void refreshDrafts(dimId).then(emit);
}

export async function discardDraft(dimId: string, raw: string): Promise<void> {
  const k = dkey(dimId, raw);
  const prev = draftsFlat[k];
  if (prev) {
    const next = { ...draftsFlat };
    delete next[k];
    draftsFlat = next;
    emit();
  }
  try {
    await api(`/dimensions/${encodeURIComponent(dimId)}/drafts/${encodeURIComponent(raw)}`, {
      method: "DELETE",
    });
  } catch (e) {
    if (prev) {
      draftsFlat = { ...draftsFlat, [k]: prev };
      emit();
    }
    throw e;
  }
  void refreshDrafts(dimId).then(emit);
}

/** All staged edits for a dimension (sync read of the cache). */
export function listDrafts(dimId: string): Draft[] {
  return Object.values(draftsFlat).filter((d) => d.dimId === dimId);
}

/**
 * Generate AI mapping suggestion for an unmapped raw value.
 * POST /api/dimensions/:dimensionId/suggest
 * Returns a draft created with source='ai' and confidence metadata.
 */
export async function generateSuggestion(
  dimensionId: string,
  rawValue: string,
  options?: { forceRefresh?: boolean },
): Promise<{
  draft_id: string;
  draft: {
    id: string;
    dim_id: string;
    raw: string;
    target_label: string;
    target_key: string | null;
    source: "ai" | "user";
    confidence: "high" | "medium" | "low";
    reasoning?: string;
    created_at: string;
    created_by: string;
  };
  cached?: boolean;
}> {
  const response = await apiFetch(`/dimensions/${encodeURIComponent(dimensionId)}/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      raw_value: rawValue,
      force_refresh: options?.forceRefresh,
    }),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as {
      detail?: string;
      error?: string;
    };
    throw new Error(error.detail ?? error.error ?? "Failed to generate suggestion");
  }

  return response.json() as Promise<{
    draft_id: string;
    draft: {
      id: string;
      dim_id: string;
      raw: string;
      target_label: string;
      target_key: string | null;
      source: "ai" | "user";
      confidence: "high" | "medium" | "low";
      reasoning?: string;
      created_at: string;
      created_by: string;
    };
    cached?: boolean;
  }>;
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
export async function renameCanonical(
  dimId: string,
  key: string,
  label: string,
  expectedVersion: number,
): Promise<number> {
  patchCanonical(dimId, key, (c) => ({ ...c, label }));
  emit();
  let version: number;
  try {
    ({ version } = await api<{ version: number }>(
      `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        body: JSON.stringify({ label, expectedVersion }),
      },
    ));
  } catch (e) {
    await refreshDim(dimId);
    emit();
    throw e;
  }
  patchCanonical(dimId, key, (c) => ({ ...c, version }));
  emit();
  // values[].current mirrors the label for mapped raws — reconcile off the critical path
  void refreshDim(dimId).then(emit);
  void refreshAudit().then(emit);
  return version;
}
export async function mergeCanonical(
  dimId: string,
  survivor: string,
  losers: string[],
  expectedVersions: Record<string, number>,
): Promise<number> {
  const { merged } = await api<{ merged: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/merge?confirm=true`,
    {
      method: "POST",
      body: JSON.stringify({ survivor, losers, expectedVersions }),
    },
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
  expectedVersion: number,
): Promise<{ ok: boolean; variants: number }> {
  const res = await api<{ ok: boolean; variants: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}?expectedVersion=${expectedVersion}`,
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
    {
      method: "PUT",
      body: JSON.stringify({
        type: newType,
        options,
        coerceInvalidToNull,
        numberFormat,
        ratingMax,
      }),
    },
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

/** Persist conditional formatting rules for a field. The server merges the
 *  incoming field_config patch with the existing stored config, so sending only
 *  { rules } is safe and will not wipe options / numberFormat / ratingMax. */
export async function updateFieldRules(
  dimId: string,
  field: string,
  rules: ConditionalRule[],
): Promise<void> {
  await api<void>(`/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`, {
    method: "PATCH",
    body: JSON.stringify({ field_config: JSON.stringify({ rules }) }),
  });
  await refreshDim(dimId);
  emit();
}

/** Persist a plain-text description for a field. Pass null to clear it. */
export async function updateFieldDescription(
  dimId: string,
  field: string,
  description: string | null,
): Promise<void> {
  await api<void>(`/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`, {
    method: "PATCH",
    body: JSON.stringify({ description }),
  });
  await refreshDim(dimId);
  emit();
}

export interface GridLayoutConfig {
  widths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
}

// Layout cache so re-activating a tab renders with correct column widths
// immediately instead of a zero-width flash while the GET round-trips.
const layoutCache = new Map<string, GridLayoutConfig>();

export function getCachedGridLayout(dimId: string): GridLayoutConfig | undefined {
  return layoutCache.get(dimId);
}

const layoutInflight = new Map<string, Promise<GridLayoutConfig>>();

export function getGridLayout(dimId: string): Promise<GridLayoutConfig> {
  const inflight = layoutInflight.get(dimId);
  if (inflight) return inflight;
  const p = api<GridLayoutConfig>(`/grid-layout/${encodeURIComponent(dimId)}`)
    .then((layout) => {
      layoutCache.set(dimId, layout);
      return layout;
    })
    .finally(() => layoutInflight.delete(dimId));
  layoutInflight.set(dimId, p);
  return p;
}

// debounce key per dimension so concurrent edits to different dims don't
// collide on a single timer
const layoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingLayouts = new Map<string, GridLayoutConfig>();

export function setGridLayout(dimId: string, partial: GridLayoutConfig): void {
  layoutCache.set(dimId, { ...(layoutCache.get(dimId) ?? {}), ...partial });
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
/** Bulk CSV import: creates new records, updates field values on existing
 *  keys (never renames labels). Returns server counts. */
export async function importRows(
  dimId: string,
  rows: Array<{ key?: string; label?: string; fields?: Record<string, string | null> }>,
): Promise<{ created: number; updated: number; skipped: number }> {
  const res = await api<{ created: number; updated: number; skipped: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/import`,
    { method: "POST", body: JSON.stringify({ rows }) },
  );
  await refreshDim(dimId);
  await refreshAudit();
  emit();
  return res;
}

/** Set an enrichment field value on a canonical record. Applies optimistically
 *  (the cell flips in the same frame), then PUTs. The server normalises some
 *  types (number parsing, date casts, linked-key validation), so those types
 *  reconcile with a background re-fetch; text/select are stored verbatim. */
export async function setFieldValue(
  dimId: string,
  key: string,
  field: string,
  value: string | null,
): Promise<void> {
  const norm = value == null || value.trim() === "" ? null : value;
  patchCanonical(dimId, key, (c) => ({ ...c, fields: { ...c.fields, [field]: norm } }));
  emit();
  try {
    await api(
      `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(key)}/field/${encodeURIComponent(field)}`,
      { method: "PUT", body: JSON.stringify({ value }) },
    );
  } catch (e) {
    await refreshDim(dimId);
    emit();
    throw e;
  }
  const type = dims.find((d) => d.id === dimId)?.fields?.find((f) => f.field === field)?.type;
  if (type === "number" || type === "date" || type === "linked") {
    void refreshDim(dimId).then(emit);
  }
}

export interface ApiToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

export interface CreatedApiToken extends ApiToken {
  value: string; // shown once at creation
}

export async function listApiTokens(): Promise<ApiToken[]> {
  const r = await apiFetch("/tokens");
  if (!r.ok) throw new Error(`list_tokens_${r.status}`);
  const body = (await r.json()) as { tokens: ApiToken[] };
  return body.tokens;
}

export async function createApiToken(name: string): Promise<CreatedApiToken> {
  const r = await apiFetch("/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`create_token_${r.status}`);
  return (await r.json()) as CreatedApiToken;
}

export async function revokeApiToken(id: string): Promise<void> {
  const r = await apiFetch(`/tokens/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`revoke_token_${r.status}`);
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

// ---------------------------------------------------------------------------
// Connection health
// ---------------------------------------------------------------------------

/* ---- connection health ---- */
export interface ConnectionHealth {
  warehouse: { status: "ok" | "error" | "disabled"; lastCheckedAt: string; error?: string };
  postgres: { status: "ok" | "error"; lastCheckedAt: string; error?: string };
}

let connectionHealth: ConnectionHealth | null = null;

export async function refreshConnectionHealth(opts: { force?: boolean } = {}): Promise<void> {
  const path = opts.force ? "/health/connections?force=1" : "/health/connections";
  const res = await apiFetch(path);
  if (!res.ok) return; // fail quiet; UI shows last known state
  connectionHealth = (await res.json()) as ConnectionHealth;
  emit();
}

export function useConnectionHealth(): ConnectionHealth | null {
  return useSyncExternalStore(
    subscribe,
    () => connectionHealth,
    () => connectionHealth,
  );
}
