import { apiFetch } from "../api";

export class IntegrationsApiError extends Error {
  constructor(public code: string, public status: number, message?: string) {
    super(message ?? code);
    this.name = "IntegrationsApiError";
  }
}

/** Map a server error code to a friendly sentence for toasts and inline errors.
 *  Falls through to a generic "Action failed (code)." for any unknown code so
 *  the user sees the raw code only as a last resort. */
export function humanError(code: string): string {
  if (code.startsWith("events_unknown")) {
    return "One of the selected events isn't supported by this server.";
  }
  switch (code) {
    case "invalid_url":         return "That URL doesn't parse.";
    case "https_required":      return "URL must use https://.";
    case "events_empty":        return "Pick at least one event.";
    case "name_required":       return "Name is required.";
    case "expires_invalid":     return "Expiry date is invalid.";
    case "invalid_json":        return "Request body was not valid JSON.";
    case "unauthorized":        return "You're signed out — please sign in again.";
    case "forbidden":
    case "admin_required":      return "You don't have permission for that.";
    case "editor_required":     return "Editor or higher required.";
    case "not_found":
    case "webhook_not_found":   return "That item no longer exists.";
    case "rate_limited":        return "Too many requests — try again in a moment.";
    case "load_failed":         return "Couldn't load — try again.";
    case "create_failed":       return "Couldn't create — try again.";
    case "revoke_failed":       return "Couldn't revoke — try again.";
    case "status_invalid":      return "That status isn't allowed.";
    case "status_disabled_not_allowed":
                                return "You can't manually disable a webhook — it auto-disables on repeated failures.";
    case "cursor_invalid":
    case "cursor_mismatch":     return "Pagination cursor expired — start over.";
    case "tenant_not_found":    return "Workspace not found.";
    case "tenant_mismatch":     return "Workspace mismatch.";
    default:                    return `Action failed (${code}).`;
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
export interface CreatedServiceAccount {
  id: string;
  name: string;
  value: string;
  scopes: string[];
}
export const createServiceAccount = (body: { name: string; expires_at: string | null }) =>
  send<CreatedServiceAccount>("/v1/service-accounts", "POST", body);
export const revokeServiceAccount = (id: string) =>
  send<void>(`/v1/service-accounts/${encodeURIComponent(id)}`, "DELETE");

/* ---------- pull-api shapes for the docs page ---------- */

export async function listDimensions(): Promise<DimensionSummary[]> {
  const { dimensions } = await get<{ dimensions: DimensionSummary[] }>("/v1/dimensions");
  return dimensions;
}
