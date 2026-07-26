import { useSyncExternalStore, useState, useEffect } from "react";
import type { RecordValue, MappingRefTable, OptionDef, PaletteName, NumberFormat } from "./data";
import type { ConditionalRule, FilterSet } from "./components/datagrid/types";
import { apiFetch, authFetch } from "./api";
import { useTenantOptional } from "./lib/tenant-context";
import { toast } from "./components/Toast";

/** Thrown by client mutation helpers on HTTP 403 with a machine-readable code. */
export class ApiCodeError extends Error {
  constructor(
    msg: string,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(msg);
    this.name = "ApiCodeError";
  }
}

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
   The three stores from ARCHITECTURE.md live behind this seam: record dim_/map_
   + drafts + audit + users in Postgres; the warehouse scan in MotherDuck (when
   ATTACH_WAREHOUSE=true). The hook shapes are unchanged, so components consume
   them exactly as before — only the source of truth moved from memory to HTTP.

   Data is preloaded once via initStore() (awaited in main.tsx before first
   render, so useRefTables() is populated synchronously); mutations POST/PUT/
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
  refTableId: string;
  raw: string;
  status: "mapped" | "skipped" | "rejected";
  targetLabel: string | null;
  targetKey: string | null;
  user: User;
  at: string;
  source: "user" | "ai";
  confidence: "high" | "medium" | "low" | null;
  reasoning: string | null;
  rejectedReason: string | null;
  rejectedBy: string | null;
}
export interface AuditEntry {
  id: string;
  at: string;
  user: User;
  action: string;
  detail: string;
  metadata?: Record<string, unknown> | null;
}
/** A registered warehouse source column for a refTable (from the source registry,
 *  not the scan) — so the UI shows the tables even with zero warehouse rows. */
export interface SourceInfo {
  table: string;
  column: string;
  refTable: string;
  refTableId: string;
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
/** flat key for a per-(refTable,value) draft — matches the workbench overlay. */
export const dkey = (refTableId: string, raw: string) => `${refTableId}::${raw}`;

/* ---- session identity (populated by initStore before first render) ---- */
export let currentUser: User = { id: "u_ada", name: "Ada Berg", initials: "AB" };
export let collaborators: User[] = [currentUser];
/** Full session user including role. Populated by initStore via /api/auth/me. */
let currentUserFull: CurrentUser | null = null;

export interface Preferences {
  publishThreshold: number;
  suggestThreshold: number;
  scanSchedule: "hourly" | "daily" | null;
  requireSecondPublisher: boolean;
}

export interface WorkspaceInfo {
  adapter: "duckdb" | "snowflake";
  /** Deployment engine — distinguishes local DuckDB from MotherDuck (both report
   *  adapter "duckdb"). Absent on older servers. */
  engine?: "duckdb" | "motherduck" | "disabled";
  writable: boolean;
  recordMode: "warehouse" | "postgres-export";
}

let _workspaceInfoCache: WorkspaceInfo | null = null;
let _workspaceInfoPromise: Promise<WorkspaceInfo | null> | null = null;

function isWorkspaceInfo(x: unknown): x is WorkspaceInfo {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    (o.adapter === "duckdb" || o.adapter === "snowflake") &&
    typeof o.writable === "boolean" &&
    (o.recordMode === "warehouse" || o.recordMode === "postgres-export")
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
  refTables = [];
  sources = [];
  draftsFlat = {};
  audit = [];
  preferences = {
    publishThreshold: 95,
    suggestThreshold: 80,
    scanSchedule: null,
    requireSecondPublisher: false,
  };
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
  storeLoading = true;
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
let refTables: MappingRefTable[] = [];
let sources: SourceInfo[] = [];
let draftsFlat: Record<string, Draft> = {};
let audit: AuditEntry[] = [];
let preferences: Preferences = {
  publishThreshold: 95,
  suggestThreshold: 80,
  scanSchedule: null,
  requireSecondPublisher: false,
};
let storeLoading = true;

const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const emit = () => listeners.forEach((l) => l());

/* ---- sync status (own listener channel — NOT the global emit() bus, which
   would re-render every store subscriber on every write start/settle) ---- */
export type SyncStatus = "idle" | "saving" | "saved" | "failed";
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
  if (syncStatus === "failed") return;
  syncStatus = "saved";
  emitSync();
  savedDecayTimer = setTimeout(() => {
    syncStatus = "idle";
    emitSync();
  }, 1500);
}
function writeFailed(): void {
  pendingWrites--;
  syncStatus = "failed";
  emitSync();
  if (savedDecayTimer) clearTimeout(savedDecayTimer);
  savedDecayTimer = setTimeout(() => {
    syncStatus = "idle";
    emitSync();
  }, 4000);
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
    const result = await apiInner<T>(path, opts);
    if (isWrite) writeSettled();
    return result;
  } catch (e) {
    if (isWrite) writeFailed();
    throw e;
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
    // Any coded error body (403 governance, 422 validation, …) surfaces as a
    // typed ApiCodeError so callers can branch on `.code` and read `.details`.
    const text = await res.text().catch(() => "");
    type ErrBody = { code?: string; error?: string; details?: Record<string, unknown> };
    let body: ErrBody | null = null;
    try {
      body = text ? (JSON.parse(text) as ErrBody) : null;
    } catch {
      /* not JSON — fall through to the generic Error */
    }
    if (body?.code) {
      throw new ApiCodeError(
        body.error ?? `${opts?.method ?? "GET"} ${path} → ${res.status} ${body.code}`,
        body.code,
        body.details,
      );
    }
    throw new Error(`${opts?.method ?? "GET"} ${path} → ${res.status} ${text}`);
  }
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

async function refreshDims(): Promise<void> {
  // Single HTTP request returns every refTable's full shape — the old code did 1
  // list call + N detail fetches (N+1) on every mutation that refreshed refTables.
  refTables = await api<MappingRefTable[]>("/tables?full=true");
}
async function refreshDim(refTableId: string): Promise<void> {
  const refTable = await api<MappingRefTable>(`/tables/${encodeURIComponent(refTableId)}`);
  refTables = refTables.map((d) => (d.id === refTable.id ? refTable : d));
}
/** Live read of one record record from the cache. Undo/redo closures use
 *  this instead of a render-captured list — the captured snapshot's version
 *  is always stale after the very mutation being undone. */
export function getRecord(refTableId: string, key: string): RecordValue | undefined {
  return refTables.find((d) => d.id === refTableId)?.record.find((c) => c.key === key);
}

/** Immutably patch one record record in the cache (optimistic updates). */
function patchRecord(
  refTableId: string,
  key: string,
  patch: (c: RecordValue) => RecordValue,
): void {
  refTables = refTables.map((d) =>
    d.id !== refTableId ? d : { ...d, record: d.record.map((c) => (c.key === key ? patch(c) : c)) },
  );
}
/** Re-fetch a single refTable from the server and notify subscribers.
 *  Used by ConflictBanner's "Refresh row" button to pull the latest version
 *  after a 409 conflict without reloading the whole workspace. */
export async function refreshRefTableAndNotify(refTableId: string): Promise<void> {
  await refreshDim(refTableId);
  emit();
}
async function refreshDrafts(refTableId?: string): Promise<void> {
  if (refTableId) {
    const list = await api<Draft[]>(`/tables/${encodeURIComponent(refTableId)}/drafts`);
    const next: Record<string, Draft> = {};
    for (const [k, d] of Object.entries(draftsFlat)) if (d.refTableId !== refTableId) next[k] = d;
    for (const d of list) next[dkey(d.refTableId, d.raw)] = d;
    draftsFlat = next;
    return;
  }
  // The workspace-wide drafts read is keyset-paginated server-side (#151) so
  // no single request materializes an unbounded backlog. Page through until the
  // server stops handing back a cursor.
  const flat: Record<string, Draft> = {};
  let cursor: string | null = null;
  for (;;) {
    const qs: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const page = await api<{ drafts: Draft[]; nextCursor: string | null }>(`/drafts${qs}`);
    for (const d of page.drafts) flat[dkey(d.refTableId, d.raw)] = d;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  draftsFlat = flat;
}
async function refreshAudit(): Promise<void> {
  audit = await api<AuditEntry[]>("/audit?limit=30");
}
async function refreshSources(): Promise<void> {
  sources = await api<SourceInfo[]>("/sources");
}
async function refreshPreferences(): Promise<void> {
  const raw = await api<Preferences>("/preferences");
  preferences = { ...raw, requireSecondPublisher: raw.requireSecondPublisher ?? false };
}

/** Preload everything once. Awaited in main.tsx so the first render has data.
 *  Independent slices run in parallel; refreshDrafts runs after them (it fetches
 *  every refTable's drafts in one batch request, independent of the refTable list). Cold
 *  boot drops from 6 sequential RTTs to 3 (users → 4-in-parallel → drafts). */
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
  storeLoading = false;
  emit();
}

/* ---- hooks (sync reads of the cache) ---- */
export function useRefTables(): MappingRefTable[] {
  return useSyncExternalStore(
    subscribe,
    () => refTables,
    () => refTables,
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

export function useStoreLoading(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => storeLoading,
    () => storeLoading,
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
export async function addRefTable(name: string, keyKind?: "slug" | "external_id"): Promise<string> {
  const { id } = await api<{ id: string }>("/tables", {
    method: "POST",
    body: JSON.stringify({ name, keyKind }),
  });
  await refreshDims();
  await refreshSources();
  await refreshAudit();
  emit();
  return id;
}

/** Permanently removes a table and everything it owns. The server keeps
 *  history (activity log); the local cache drops the refTable immediately. */
export async function deleteRefTable(refTableId: string): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}`, { method: "DELETE" });
  refTables = refTables.filter((d) => d.id !== refTableId);
  await Promise.all([refreshAudit(), refreshSources()]);
  // Prune drafts for the deleted refTable without hitting the server for a gone endpoint
  const next: Record<string, Draft> = {};
  for (const [k, d] of Object.entries(draftsFlat)) if (d.refTableId !== refTableId) next[k] = d;
  draftsFlat = next;
  emit();
}

export async function patchRefTable(
  refTableId: string,
  patch: {
    orderingMode?: "derived" | "manual";
    description?: string | null;
    color?: string | null;
    ownerUserId?: string | null;
  },
): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  await refreshDim(refTableId);
  emit();
}

export async function insertRecordAt(
  refTableId: string,
  label: string,
  anchor: string,
  direction: "above" | "below",
  key?: string,
): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}/record`, {
    method: "POST",
    body: JSON.stringify({ label, key, insertAt: { anchor, direction } }),
  });
  await refreshDim(refTableId);
  emit();
}

export async function reorderRecord(
  refTableId: string,
  rowKey: string,
  opts: { before?: string | null; after?: string | null },
): Promise<{ position: string }> {
  const result = await api<{ ok: boolean; position: string }>(
    `/tables/${encodeURIComponent(refTableId)}/record/${encodeURIComponent(rowKey)}/position`,
    {
      method: "PUT",
      body: JSON.stringify(opts),
    },
  );
  await refreshDim(refTableId);
  emit();
  return { position: result.position };
}

export async function rebalancePositions(refTableId: string): Promise<{ rebalanced: number }> {
  return api<{ ok: boolean; rebalanced: number }>(
    `/tables/${encodeURIComponent(refTableId)}/positions/rebalance`,
    { method: "POST" },
  );
}

export type CreateTableMode = "blank" | "source" | "external_id" | "file";

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
  /** Parsed CSV: headers become text fields, rows become records (fields keyed
   *  by header label). mode === "file" */
  file?: {
    columns: string[];
    rows: Array<{ label: string; fields: Record<string, string | null> }>;
  };
}

export interface CreateTableError {
  error: string;
  code: "NAME_TAKEN" | "WAREHOUSE_OFFLINE" | "MISSING_PICKER" | "INVALID";
}

/** Create a table via the orchestrator. Returns the new refTable id on success.
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
  refTableId: string,
  raw: string,
  status: "mapped" | "skipped",
  targetLabel: string | null,
  targetKey: string | null,
): Promise<void> {
  const k = dkey(refTableId, raw);
  const prev = draftsFlat[k];
  draftsFlat = {
    ...draftsFlat,
    [k]: {
      refTableId,
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
      rejectedReason: null,
      rejectedBy: null,
    },
  };
  emit();
  try {
    await api(`/tables/${encodeURIComponent(refTableId)}/drafts`, {
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
  void refreshDrafts(refTableId).then(emit);
}

export async function discardDraft(refTableId: string, raw: string): Promise<void> {
  const k = dkey(refTableId, raw);
  const prev = draftsFlat[k];
  if (prev) {
    const next = { ...draftsFlat };
    delete next[k];
    draftsFlat = next;
    emit();
  }
  try {
    await api(`/tables/${encodeURIComponent(refTableId)}/drafts/${encodeURIComponent(raw)}`, {
      method: "DELETE",
    });
  } catch (e) {
    if (prev) {
      draftsFlat = { ...draftsFlat, [k]: prev };
      emit();
    }
    throw e;
  }
  void refreshDrafts(refTableId).then(emit);
}

/** All staged edits for a refTable (sync read of the cache). */
export function listDrafts(refTableId: string): Draft[] {
  return Object.values(draftsFlat).filter((d) => d.refTableId === refTableId);
}

/**
 * Generate AI mapping suggestion for an unmapped raw value.
 * POST /api/tables/:refTableId/suggest
 * Returns a draft created with source='ai' and confidence metadata.
 */
export async function generateSuggestion(
  refTableId: string,
  rawValue: string,
  options?: { forceRefresh?: boolean },
): Promise<{
  draft_id: string;
  draft: {
    id: string;
    reference_table_id: string;
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
  const response = await apiFetch(`/tables/${encodeURIComponent(refTableId)}/suggest`, {
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
      reference_table_id: string;
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

/** Per-refTable publish state (ADR-0002): last published version + what's
 *  waiting — staged drafts and record rows touched since that publish. */
export interface PublishState {
  version: number;
  publishedAt: string | null;
  publishedByName: string | null;
  pendingDrafts: number;
  changedKeys: string[];
  canRevert: boolean;
}

export async function fetchPublishState(refTableId: string): Promise<PublishState> {
  return api<PublishState>(`/tables/${encodeURIComponent(refTableId)}/publish-state`);
}

/** Approve & commit the refTable's mapped drafts (server folds them into the
 *  record tables in one batch). When `draftKeys` is provided, only those
 *  raws are folded (scoped commit). Returns the count + warehouse rows recovered. */
export async function commit(
  refTableId: string,
  draftKeys?: string[],
): Promise<{ committed: number; rowsRecovered: number }> {
  const res = await api<{ committed: number; rowsRecovered: number }>(
    `/tables/${encodeURIComponent(refTableId)}/commit`,
    {
      method: "POST",
      ...(draftKeys !== undefined ? { body: JSON.stringify({ draftKeys }) } : {}),
    },
  );
  await refreshDim(refTableId);
  await refreshDrafts(refTableId);
  await refreshSources();
  await refreshAudit();
  emit();
  return res;
}

/** Restore every changed record to the last published version. */
export async function revertChanges(refTableId: string): Promise<{ reverted: number }> {
  const res = await api<{ reverted: number }>(`/tables/${encodeURIComponent(refTableId)}/revert`, {
    method: "POST",
  });
  await refreshDim(refTableId);
  await refreshAudit();
  emit();
  return res;
}

/** One entry in a refTable's version history. */
export interface VersionInfo {
  version: number;
  kind: "publish" | "rollback";
  restoresVersion: number | null;
  publishedBy: string;
  publishedByName: string;
  at: string;
  counts: { records: number; mappings: number };
  hasSnapshot: boolean;
}

/** Fetch the full version history for a refTable. */
export async function fetchVersions(refTableId: string): Promise<VersionInfo[]> {
  return api<VersionInfo[]>(`/tables/${encodeURIComponent(refTableId)}/versions`);
}

/** Roll a refTable back to a prior snapshot version. Refreshes refTable, drafts,
 *  and audit — mirrors the commit() refresh/emit pattern. */
export async function rollbackDim(refTableId: string, toVersion: number): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}/rollback`, {
    method: "POST",
    body: JSON.stringify({ toVersion }),
  });
  await refreshDim(refTableId);
  await refreshDrafts(refTableId);
  await refreshSources();
  await refreshAudit();
  emit();
}

/** Reject a set of raw draft values with a reason. Refreshes drafts and emits. */
export async function rejectDrafts(
  refTableId: string,
  raws: string[],
  reason: string,
): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}/drafts/reject`, {
    method: "POST",
    body: JSON.stringify({ raws, reason }),
  });
  await refreshDrafts(refTableId);
  emit();
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

/** Wire a warehouse column to a refTable, then refresh the sources list. */
export async function addSource(refTableId: string, table: string, column: string): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}/sources`, {
    method: "POST",
    body: JSON.stringify({ table, column }),
  });
  await refreshSources();
  emit();
}

/** Unwire a warehouse column from a refTable, then refresh the sources list. */
export async function removeSource(
  refTableId: string,
  table: string,
  column: string,
): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}/sources`, {
    method: "DELETE",
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
  refTableId: string,
  table: string,
  column: string,
  limit = 5,
): Promise<UnmappedSample[]> {
  const qs = new URLSearchParams({ refTableId, table, column, limit: String(limit) });
  return api<UnmappedSample[]>(`/sources/unmapped?${qs.toString()}`);
}

/** Wire a source column to a refTable. If the refTable is empty, the distinct values
 *  seed the record table 1:1 (mode "seed"). If the refTable already has records,
 *  only the source is registered — values land in Match Values for triage
 *  (mode "connect"). Pass `force` to seed regardless (bootstrap-from-many). */
export async function deriveRecord(
  refTableId: string,
  table: string,
  column: string,
  nameColumn?: string,
  opts: { force?: boolean } = {},
): Promise<{ derived: number; mode: "seed" | "connect"; matched: number; unmatched: number }> {
  const res = await api<{
    derived: number;
    mode: "seed" | "connect";
    matched: number;
    unmatched: number;
  }>(`/tables/${encodeURIComponent(refTableId)}/derive`, {
    method: "POST",
    body: JSON.stringify({ table, column, nameColumn, force: opts.force }),
  });
  await refreshDim(refTableId);
  await refreshSources();
  await refreshAudit();
  emit();
  return res;
}

/* ---- record record management (governed, persisted) ---- */
export async function addRecord(refTableId: string, label: string, key?: string): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}/record`, {
    method: "POST",
    body: JSON.stringify({ label, key }),
  });
  await refreshDim(refTableId);
  await refreshAudit();
  emit();
}
export async function renameRecord(
  refTableId: string,
  key: string,
  label: string,
  expectedVersion: number,
): Promise<number> {
  patchRecord(refTableId, key, (c) => ({ ...c, label }));
  emit();
  let version: number;
  try {
    ({ version } = await api<{ version: number }>(
      `/tables/${encodeURIComponent(refTableId)}/record/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        body: JSON.stringify({ label, expectedVersion }),
      },
    ));
  } catch (e) {
    await refreshDim(refTableId);
    emit();
    throw e;
  }
  patchRecord(refTableId, key, (c) => ({ ...c, version }));
  emit();
  // values[].current mirrors the label for mapped raws — reconcile off the critical path
  void refreshDim(refTableId).then(emit);
  void refreshAudit().then(emit);
  return version;
}
export async function mergeRecord(
  refTableId: string,
  survivor: string,
  losers: string[],
  expectedVersions: Record<string, number>,
): Promise<number> {
  const { merged } = await api<{ merged: number }>(
    `/tables/${encodeURIComponent(refTableId)}/record/merge?confirm=true`,
    {
      method: "POST",
      body: JSON.stringify({ survivor, losers, expectedVersions }),
    },
  );
  await refreshDim(refTableId);
  await refreshSources();
  await refreshAudit();
  emit();
  return merged;
}
/** Retire a record — returns {ok:false, variants} if still mapped (governed). */
export async function retireRecord(
  refTableId: string,
  key: string,
  expectedVersion: number,
): Promise<{ ok: boolean; variants: number }> {
  const res = await api<{ ok: boolean; variants: number }>(
    `/tables/${encodeURIComponent(refTableId)}/record/${encodeURIComponent(key)}?expectedVersion=${expectedVersion}`,
    { method: "DELETE" },
  );
  if (res.ok) {
    await refreshDim(refTableId);
    await refreshAudit();
    emit();
  }
  return res;
}
/** The raw variants resolving to a record key (lineage). */
export async function fetchVariants(refTableId: string, key: string): Promise<string[]> {
  return api<string[]>(
    `/tables/${encodeURIComponent(refTableId)}/record/${encodeURIComponent(key)}/variants`,
  );
}

/** Add an enrichment attribute column to a refTable (text|number|boolean|date|select|linked).
 *  For `select`, `options` seeds the allowed list; for `linked`, pass `referencedRefTableId` and optionally `displayFields`; otherwise omit extras. */
export async function addField(
  refTableId: string,
  label: string,
  type = "text",
  options?: OptionDef[],
  extras?: {
    numberFormat?: NumberFormat;
    ratingMax?: number;
    referencedRefTableId?: string;
    displayFields?: string[];
    required?: boolean;
    validation?: { unique?: boolean; min?: number | string | null; max?: number | string | null };
    formula?: {
      expr: string;
      resultType: "text" | "number" | "boolean";
      numberFormat?: NumberFormat;
    };
  },
): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}/fields`, {
    method: "POST",
    body: JSON.stringify({ label, type, options, ...extras }),
  });
  await refreshDim(refTableId);
  await refreshAudit();
  emit();
}

/** Append a new option to a select column's allowed list. Refetches the
 *  refTable so subsequent picks see the new option. Returns the new list. */
export async function addColumnOption(
  refTableId: string,
  field: string,
  label: string,
  color: PaletteName | null = null,
): Promise<OptionDef[]> {
  const res = await api<{ options: OptionDef[] }>(
    `/tables/${encodeURIComponent(refTableId)}/fields/${encodeURIComponent(field)}/options`,
    { method: "POST", body: JSON.stringify({ label, color }) },
  );
  await refreshDim(refTableId);
  emit();
  return res.options;
}

export async function renameColumn(
  refTableId: string,
  field: string,
  newLabel: string,
): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}/fields/${encodeURIComponent(field)}`, {
    method: "PUT",
    body: JSON.stringify({ label: newLabel }),
  });
  await refreshDim(refTableId);
  emit();
}

export async function changeColumnType(
  refTableId: string,
  field: string,
  newType: string,
  options?: OptionDef[],
  coerceInvalidToNull = false,
  numberFormat?: NumberFormat,
  ratingMax?: number,
): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
  const res = await api<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }>(
    `/tables/${encodeURIComponent(refTableId)}/fields/${encodeURIComponent(field)}`,
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
    await refreshDim(refTableId);
    emit();
  }
  return res;
}

export async function deleteColumn(refTableId: string, field: string): Promise<void> {
  await api(`/tables/${encodeURIComponent(refTableId)}/fields/${encodeURIComponent(field)}`, {
    method: "DELETE",
  });
  await refreshDim(refTableId);
  emit();
}

/** Persist conditional formatting rules for a field. The server merges the
 *  incoming field_config patch with the existing stored config, so sending only
 *  { rules } is safe and will not wipe options / numberFormat / ratingMax. */
export async function updateFieldRules(
  refTableId: string,
  field: string,
  rules: ConditionalRule[],
): Promise<void> {
  await api<void>(`/tables/${encodeURIComponent(refTableId)}/fields/${encodeURIComponent(field)}`, {
    method: "PATCH",
    body: JSON.stringify({ field_config: JSON.stringify({ rules }) }),
  });
  await refreshDim(refTableId);
  emit();
}

/** Persist the ordered list of display fields for an FK column. The server
 *  validates that every entry references an existing string field on the
 *  target refTable and merges the patch into the field's stored config (so
 *  rules / numberFormat / etc. survive). */
export async function updateFieldDisplayFields(
  refTableId: string,
  field: string,
  displayFields: string[],
): Promise<void> {
  await api<void>(`/tables/${encodeURIComponent(refTableId)}/fields/${encodeURIComponent(field)}`, {
    method: "PATCH",
    body: JSON.stringify({ field_config: JSON.stringify({ displayFields }) }),
  });
  await refreshDim(refTableId);
  emit();
}

/** Persist required / validation rules for a field. The server merges the
 *  incoming field_config patch with the existing stored config, so only the
 *  keys you send are overwritten (options / rules / numberFormat survive).
 *  Applies optimistically so badges / enforcement reflect the new value
 *  immediately without waiting for the server round-trip. */
export async function updateFieldValidation(
  refTableId: string,
  field: string,
  next: {
    required?: boolean;
    validation?: { unique?: boolean; min?: number | string | null; max?: number | string | null };
  },
): Promise<void> {
  // Optimistic local write — mutate the cached refTable so subscribers re-render
  // immediately with the new required / validation values.
  refTables = refTables.map((d) => {
    if (d.id !== refTableId) return d;
    return {
      ...d,
      fields: (d.fields ?? []).map((f) => {
        if (f.field !== field) return f;
        const patched = { ...f };
        if (next.required !== undefined) patched.required = next.required;
        if ("validation" in next) {
          // Filter out undefined values so cleared fields don't linger
          const v = next.validation;
          if (v == null || Object.values(v).every((x) => x === undefined)) {
            delete patched.validation;
          } else {
            patched.validation = Object.fromEntries(
              Object.entries(v).filter(([, x]) => x !== undefined),
            ) as typeof patched.validation;
          }
        }
        return patched;
      }),
    };
  });
  emit();
  await api<void>(`/tables/${encodeURIComponent(refTableId)}/fields/${encodeURIComponent(field)}`, {
    method: "PATCH",
    body: JSON.stringify({ field_config: JSON.stringify(next) }),
  });
  await refreshDim(refTableId);
  emit();
}

/** Persist a plain-text description for a field. Pass null to clear it. */
export async function updateFieldDescription(
  refTableId: string,
  field: string,
  description: string | null,
): Promise<void> {
  await api<void>(`/tables/${encodeURIComponent(refTableId)}/fields/${encodeURIComponent(field)}`, {
    method: "PATCH",
    body: JSON.stringify({ description }),
  });
  await refreshDim(refTableId);
  emit();
}

export interface GridLayoutConfig {
  widths?: Record<string, number>;
  order?: string[];
  hidden?: string[];
  sort?: { column: string; direction: "asc" | "desc" } | null;
  filterSet?: FilterSet | null;
}

// Layout cache so re-activating a tab renders with correct column widths
// immediately instead of a zero-width flash while the GET round-trips.
const layoutCache = new Map<string, GridLayoutConfig>();

export function getCachedGridLayout(refTableId: string): GridLayoutConfig | undefined {
  return layoutCache.get(refTableId);
}

const layoutInflight = new Map<string, Promise<GridLayoutConfig>>();

export function getGridLayout(refTableId: string): Promise<GridLayoutConfig> {
  const inflight = layoutInflight.get(refTableId);
  if (inflight) return inflight;
  const p = api<GridLayoutConfig>(`/grid-layout/${encodeURIComponent(refTableId)}`)
    .then((layout) => {
      layoutCache.set(refTableId, layout);
      return layout;
    })
    .finally(() => layoutInflight.delete(refTableId));
  layoutInflight.set(refTableId, p);
  return p;
}

// debounce key per refTable so concurrent edits to different refTables don't
// collide on a single timer
const layoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingLayouts = new Map<string, GridLayoutConfig>();

export function setGridLayout(refTableId: string, partial: GridLayoutConfig): void {
  layoutCache.set(refTableId, { ...(layoutCache.get(refTableId) ?? {}), ...partial });
  const merged = { ...(pendingLayouts.get(refTableId) ?? {}), ...partial };
  pendingLayouts.set(refTableId, merged);
  const t = layoutTimers.get(refTableId);
  if (t) clearTimeout(t);
  layoutTimers.set(
    refTableId,
    setTimeout(() => {
      const body = pendingLayouts.get(refTableId) ?? {};
      pendingLayouts.delete(refTableId);
      layoutTimers.delete(refTableId);
      void api(`/grid-layout/${encodeURIComponent(refTableId)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        keepalive: true,
      }).catch(() => {
        toast("Couldn't save the table layout — recent column changes may not stick.", "error");
      });
    }, 400),
  );
}
/** Bulk CSV import: creates new records, updates field values on existing
 *  keys (never renames labels). Returns server counts. */
export async function importRows(
  refTableId: string,
  rows: Array<{ key?: string; label?: string; fields?: Record<string, string | null> }>,
): Promise<{ created: number; updated: number; skipped: number }> {
  const res = await api<{ created: number; updated: number; skipped: number }>(
    `/tables/${encodeURIComponent(refTableId)}/import`,
    { method: "POST", body: JSON.stringify({ rows }) },
  );
  await refreshDim(refTableId);
  await refreshAudit();
  emit();
  return res;
}

/** Set an enrichment field value on a record record. Applies optimistically
 *  (the cell flips in the same frame), then PUTs. The server normalises some
 *  types (number parsing, date casts, linked-key validation), so those types
 *  reconcile with a background re-fetch; text/select are stored verbatim. */
export async function setFieldValue(
  refTableId: string,
  key: string,
  field: string,
  value: string | null,
): Promise<void> {
  const norm = value == null || value.trim() === "" ? null : value;
  patchRecord(refTableId, key, (c) => ({ ...c, fields: { ...c.fields, [field]: norm } }));
  emit();
  try {
    await api(
      `/tables/${encodeURIComponent(refTableId)}/record/${encodeURIComponent(key)}/field/${encodeURIComponent(field)}`,
      { method: "PUT", body: JSON.stringify({ value }) },
    );
  } catch (e) {
    await refreshDim(refTableId);
    emit();
    throw e;
  }
  const table = refTables.find((d) => d.id === refTableId);
  const type = table?.fields?.find((f) => f.field === field)?.type;
  // Formula columns are server-computed, so any dependency edit means the whole
  // row's computed values may have changed — re-fetch when the table has one.
  const hasFormula = table?.fields?.some((f) => f.type === "formula");
  if (type === "number" || type === "date" || type === "linked" || hasFormula) {
    void refreshDim(refTableId).then(emit);
  }
}

/** Dry-run a candidate formula against the table's first record so the field
 *  editor can show live errors / a sample value without a client-side evaluator. */
export async function validateFormula(
  refTableId: string,
  expr: string,
): Promise<{ ok: boolean; error?: string; warning?: string; sample?: string | null }> {
  return api(`/tables/${encodeURIComponent(refTableId)}/formula/validate`, {
    method: "POST",
    body: JSON.stringify({ expr }),
  });
}

/** Update an existing formula column's expression / result type. The server
 *  re-validates and shallow-merges into field_config. */
export async function updateFieldFormula(
  refTableId: string,
  field: string,
  formula: { expr: string; resultType: "text" | "number" | "boolean"; numberFormat?: NumberFormat },
): Promise<void> {
  await api<void>(`/tables/${encodeURIComponent(refTableId)}/fields/${encodeURIComponent(field)}`, {
    method: "PATCH",
    body: JSON.stringify({
      field_config: JSON.stringify({
        expr: formula.expr,
        resultType: formula.resultType,
        ...(formula.numberFormat ? { numberFormat: formula.numberFormat } : {}),
      }),
    }),
  });
  await refreshDim(refTableId);
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
export interface SchemaFacet {
  schema: string;
  tables: number;
}
export interface CatalogColumn {
  name: string;
  type: string;
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

/** Lazy: schema list for one registered database. */
export async function listSchemas(database: string): Promise<SchemaFacet[]> {
  return api<SchemaFacet[]>(`/warehouse/schemas?database=${encodeURIComponent(database)}`);
}

/** Lazy: tables in one schema (reuses the paginated catalog search, scoped by schema). */
export async function listTablesInSchema(
  database: string,
  schema: string,
): Promise<CatalogTable[]> {
  const r = await searchCatalog({ database, schema, limit: 100, offset: 0 });
  return r.rows;
}

/** Columns (with types) for one table. */
export async function fetchColumns(database: string, table: string): Promise<CatalogColumn[]> {
  const qs = new URLSearchParams({ database, table });
  return api<CatalogColumn[]>(`/warehouse/columns?${qs.toString()}`);
}

/** On-demand distinct sample values for one column. */
export async function fetchColumnValues(
  database: string,
  table: string,
  column: string,
  limit = 5,
): Promise<string[]> {
  const qs = new URLSearchParams({ database, table, column, limit: String(limit) });
  const r = await api<{ values: string[] }>(`/warehouse/values?${qs.toString()}`);
  return r.values;
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
