/* integrations-wire-keys.ts — the exact key sets the v1 integrations responses
   must carry, as plain data with no imports.

   It is a file of its own so server/src/v1-routes.test.ts can import it and
   assert the real responses against it (the server tsconfig has no DOM lib, so
   it cannot reach through integrations-api.ts). integrations-api.ts binds both
   lists to their interfaces, so a field added on one side and not the other
   fails to compile there or fails that route test. */

export const WEBHOOK_WIRE_KEYS = [
  "id",
  "url",
  "events",
  "status",
  "description",
  "secret_prefix",
  "secret_prefix_previous",
  "secret_previous_expires_at",
  "created_at",
  "created_by",
  "paused_at",
  "disabled_at",
  "disabled_reason",
  "last_delivery_at",
  "last_delivery_status",
  "queued_count",
] as const;

export const SERVICE_ACCOUNT_WIRE_KEYS = [
  "id",
  "name",
  "token_prefix",
  "scopes",
  "created_at",
  "created_by",
  "last_used_at",
  "expires_at",
] as const;
