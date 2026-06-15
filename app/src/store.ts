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
import { useTenantOptional } from "./lib/tenant-context";

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

/** The signed-in user. Returned by /api/auth/me and exposed via useCurrentUser().
 *  Workspace role lives on TenantContext (per-tenant), not here. */
export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  initials: string;
  isSuperAdmin: boolean;
}

function isCurrentUser(x: unknown): x is CurrentUser {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.email === "string" &&
    typeof o.initials === "string"
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
  source: "user" | "ai";
  confidence: "high" | "medium" | "low" | null;
  reasoning: string | null;
}
export interface AuditEntry {
  id: string;
  at: string;
  user: User;
  action: string;
  detail: string;
  metadata?: Record<string, unknown> | null;
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

/** Convenience: true when the current user may mutate state in the active workspace.
 *  Reads role + super-admin from TenantContext (per-workspace, authoritative) rather
 *  than the global currentUser shape (which doesn't carry workspace role).
 *  Super-admin short-circuits to true per the 2026-06-13 settings spec. */
export function useCanEdit(): boolean {
  const t = useTenantOptional();
  if (!t) return false;
  if (t.isSuperAdmin) return true;
  return t.role !== "viewer";
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

export async function patchDimension(
  dimId: string,
  patch: {
    orderingMode?: "derived" | "manual";
    description?: string | null;
    color?: string | null;
  },
): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  await refreshDim(dimId);
  emit();
}

export async function insertCanonicalAt(
  dimId: string,
  label: string,
  anchor: string,
  direction: "above" | "below",
  key?: string,
): Promise<void> {
  await api(`/dimensions/${encodeURIComponent(dimId)}/canonical`, {
    method: "POST",
    body: JSON.stringify({ label, key, insertAt: { anchor, direction } }),
  });
  await refreshDim(dimId);
  emit();
}

export async function reorderCanonical(
  dimId: string,
  rowKey: string,
  opts: { before?: string | null; after?: string | null },
): Promise<{ position: string }> {
  const result = await api<{ ok: boolean; position: string }>(
    `/dimensions/${encodeURIComponent(dimId)}/canonical/${encodeURIComponent(rowKey)}/position`,
    {
      method: "PUT",
      body: JSON.stringify(opts),
    },
  );
  await refreshDim(dimId);
  emit();
  return { position: result.position };
}

export async function rebalancePositions(dimId: string): Promise<{ rebalanced: number }> {
  return api<{ ok: boolean; rebalanced: number }>(
    `/dimensions/${encodeURIComponent(dimId)}/positions/rebalance`,
    { method: "POST" },
  );
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
      // Preserve AI provenance from previous draft if it exists; otherwise default to user.
      source: prev?.source ?? "user",
      confidence: prev?.confidence ?? null,
      reasoning: prev?.reasoning ?? null,
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

/** Persist the ordered list of display fields for an FK column. The server
 *  validates that every entry references an existing string field on the
 *  target dim and merges the patch into the field's stored config (so
 *  rules / numberFormat / etc. survive). */
export async function updateFieldDisplayFields(
  dimId: string,
  field: string,
  displayFields: string[],
): Promise<void> {
  await api<void>(`/dimensions/${encodeURIComponent(dimId)}/fields/${encodeURIComponent(field)}`, {
    method: "PATCH",
    body: JSON.stringify({ field_config: JSON.stringify({ displayFields }) }),
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
  sort?: { column: string; direction: "asc" | "desc" } | null;
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
 *  the explorer holds its own results, so it scales to any catalog size. The
 *  `database` is the registered warehouse_database.id (a UUID) — the server
 *  resolves it to the catalog name on the connected adapter. When `null` we
 *  skip the network call and return an empty result so callers can render a
 *  "pick a database" affordance without an extra guard. */
export async function searchCatalog(opts: {
  database: string | null;
  q?: string;
  schema?: string;
  limit?: number;
  offset?: number;
}): Promise<CatalogResult> {
  if (!opts.database) return { rows: [], total: 0, schemas: [] };
  const qs = new URLSearchParams();
  qs.set("database", opts.database);
  if (opts.q) qs.set("search", opts.q);
  if (opts.schema) qs.set("schema", opts.schema);
  const tables = await api<Array<{ schema: string; table: string; columns: string[] }>>(
    `/warehouse/tables?${qs.toString()}`,
  );
  // /warehouse/tables returns the full list (server caps at 5000). Apply the
  // explorer's pagination + schema facets client-side so this function still
  // matches the CatalogResult contract the UI expects.
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  const schemaCounts = new Map<string, number>();
  for (const t of tables) schemaCounts.set(t.schema, (schemaCounts.get(t.schema) ?? 0) + 1);
  const schemas = [...schemaCounts.entries()]
    .map(([schema, count]) => ({ schema, tables: count }))
    .sort((a, b) => b.tables - a.tables || a.schema.localeCompare(b.schema))
    .slice(0, 100);
  const rows = tables.slice(offset, offset + limit).map((t) => ({
    schema: t.schema,
    table: `${t.schema}.${t.table}`,
    columns: t.columns,
  }));
  return { rows, total: tables.length, schemas };
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

/* ============================================================================
   Memberships slice + invalidate() registry
   ----------------------------------------------------------------------------
   Phase B: post-save state propagation. Most "settings" data (members, tokens,
   tenant list, admin users) is owned by individual route components — they
   fetch with their own `useEffect`. To let a save handler in one page refresh
   data in another (e.g. renaming a workspace must update the WorkspaceSwitcher
   on every page), we expose a tiny pub/sub: `invalidate.X()` fires registered
   subscribers, plus runs the built-in refetcher for any slice the store owns
   directly (currentUser, preferences, memberships, audit).

   Subscribers register via `subscribeInvalidate(key, fn)` and the function is
   called whenever `invalidate.<key>()` fires. Use this from route components
   that own their fetch (Members, Tokens, Workspaces admin, Users admin).
   ============================================================================ */

export interface MembershipLite {
  slug: string;
  label: string;
  role: "admin" | "editor" | "viewer";
  color: string | null;
}

let memberships: MembershipLite[] = [];

export function setMemberships(next: MembershipLite[]): void {
  memberships = next;
  emit();
}

export function getMemberships(): MembershipLite[] {
  return memberships;
}

export function useMemberships(): MembershipLite[] {
  return useSyncExternalStore(
    subscribe,
    () => memberships,
    () => memberships,
  );
}

async function refetchCurrentUser(): Promise<void> {
  const res = await authFetch("/auth/me");
  if (!res.ok) return;
  const data: unknown = await res.json().catch(() => null);
  if (isCurrentUser(data)) {
    currentUserFull = data;
    emit();
  }
}

async function refetchMemberships(): Promise<void> {
  const res = await authFetch("/me/memberships");
  if (!res.ok) return;
  const body = (await res.json().catch(() => null)) as { memberships?: MembershipLite[] } | null;
  if (body && Array.isArray(body.memberships)) {
    memberships = body.memberships;
    emit();
  }
}

async function refetchPreferences(): Promise<void> {
  await refreshPreferences();
  emit();
}

async function refetchAudit(): Promise<void> {
  await refreshAudit();
  emit();
}

/* ---- subscriber registry for route-owned fetches ---- */
export type InvalidateKey =
  | "currentUser"
  | "tenant"
  | "memberships"
  | "members"
  | "tokens"
  | "scans"
  | "audit"
  | "warehouses"
  | "tenantList"
  | "adminUsers";

type Subscriber = (slug?: string) => void | Promise<void>;
const invalidateSubs: Map<InvalidateKey, Set<Subscriber>> = new Map();

export function subscribeInvalidate(key: InvalidateKey, fn: Subscriber): () => void {
  let set = invalidateSubs.get(key);
  if (!set) {
    set = new Set();
    invalidateSubs.set(key, set);
  }
  set.add(fn);
  return () => {
    set?.delete(fn);
  };
}

function fireInvalidate(key: InvalidateKey, slug?: string): void {
  const set = invalidateSubs.get(key);
  if (!set) return;
  for (const fn of set) {
    try {
      const r = fn(slug);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((err) => console.error(`invalidate.${key} subscriber`, err));
      }
    } catch (err) {
      console.error(`invalidate.${key} subscriber`, err);
    }
  }
}

/** Targeted refetch entry points called from save handlers. Each fires both
 *  store-owned refetchers (where applicable) and any registered subscribers
 *  from route components. Slugs are passed through for namespaced data. */
export const invalidate = {
  currentUser: async (): Promise<void> => {
    await refetchCurrentUser();
    fireInvalidate("currentUser");
  },
  tenant: async (slug?: string): Promise<void> => {
    // No dedicated tenant fetcher — the label flows through memberships, and
    // per-tenant config lives on `preferences`. Refresh both.
    await Promise.all([refetchMemberships(), refetchPreferences()]);
    fireInvalidate("tenant", slug);
  },
  memberships: async (): Promise<void> => {
    await refetchMemberships();
    fireInvalidate("memberships");
  },
  members: (slug?: string): void => {
    fireInvalidate("members", slug);
  },
  tokens: (slug?: string): void => {
    fireInvalidate("tokens", slug);
  },
  scans: async (slug?: string): Promise<void> => {
    await refetchPreferences();
    fireInvalidate("scans", slug);
  },
  audit: async (slug?: string): Promise<void> => {
    await refetchAudit();
    fireInvalidate("audit", slug);
  },
  warehouses: (): void => {
    fireInvalidate("warehouses");
  },
  tenantList: (): void => {
    fireInvalidate("tenantList");
  },
  adminUsers: (): void => {
    fireInvalidate("adminUsers");
  },
};
