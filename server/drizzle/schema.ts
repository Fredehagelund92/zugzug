import { sql } from "drizzle-orm";
import {
  pgSchema,
  varchar,
  boolean,
  customType,
  bigint,
  integer,
  serial,
  timestamp,
  primaryKey,
  foreignKey,
  index,
  uniqueIndex,
  text,
  check,
  jsonb,
} from "drizzle-orm/pg-core";

const app = pgSchema("zugzug_app");

/* Drizzle 0.45.2 does not export a `bytea` helper from pg-core; define one
   here so the rest of the file can keep using `bytea("col").notNull()`
   call sites unchanged. */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const dimension = app.table(
  "dimension",
  {
    id:          varchar("id").notNull(),
    label:       varchar("label").notNull(),
    dim_table:   varchar("dim_table").notNull(),
    map_table:   varchar("map_table").notNull(),
    key_col:     varchar("key_col").notNull(),
    created_at:  timestamp("created_at").notNull(),
    key_kind:    varchar("key_kind"),
    name_table:  varchar("name_table"),
    name_id_col: varchar("name_id_col"),
    name_col:    varchar("name_col"),
    description: varchar("description"),
    color:       varchar("color"),
    ordering_mode:      varchar("ordering_mode").notNull().default("derived"),
    last_rebalanced_at: timestamp("last_rebalanced_at"),
    tenant_id:   varchar("tenant_id").notNull().references(() => tenant.id),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    index("dimension_tenant_idx").on(t.tenant_id),
    check("dimension_ordering_mode_chk", sql`${t.ordering_mode} IN ('derived', 'manual')`),
  ],
);

export const dimensionSource = app.table(
  "dimension_source",
  {
    dim_id:        varchar("dim_id").notNull(),
    tenant_id:     varchar("tenant_id").notNull().references(() => tenant.id),
    source_table:  varchar("source_table"),
    source_column: varchar("source_column"),
    database_id:   varchar("database_id"),
    schema_name:   varchar("schema_name", { length: 255 }),
    table_name:    varchar("table_name",  { length: 255 }),
    column_name:   varchar("column_name", { length: 255 }),
  },
  (t) => [
    primaryKey({
      columns: [t.tenant_id, t.dim_id, t.database_id, t.schema_name, t.table_name, t.column_name],
    }),
    index("dimension_source_dim_idx").on(t.tenant_id, t.dim_id),
    index("dimension_source_database_idx").on(t.tenant_id, t.database_id),
    foreignKey({
      columns:        [t.database_id],
      foreignColumns: [warehouseDatabase.id],
      name:           "dimension_source_database_fk",
    }).onDelete("restrict"),
    check("dimension_source_schema_name_nonempty", sql`length(${t.schema_name}) > 0`),
    check("dimension_source_table_name_nonempty",  sql`length(${t.table_name})  > 0`),
    check("dimension_source_column_name_nonempty", sql`length(${t.column_name}) > 0`),
  ],
);

export const dimensionField = app.table(
  "dimension_field",
  {
    dim_id:       varchar("dim_id").notNull(),
    field:        varchar("field").notNull(),
    label:        varchar("label").notNull(),
    type:         varchar("type").notNull(),
    created_at:   timestamp("created_at").notNull(),
    field_config: varchar("field_config"),
    description:  varchar("description"),
    tenant_id:    varchar("tenant_id").notNull().references(() => tenant.id),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.dim_id, t.field] })],
);

export const sourceStat = app.table(
  "source_stat",
  {
    dim_id:          varchar("dim_id").notNull(),
    tenant_id:       varchar("tenant_id").notNull().references(() => tenant.id),
    source_table:    varchar("source_table"),
    source_column:   varchar("source_column"),
    database_id:     varchar("database_id"),
    schema_name:     varchar("schema_name", { length: 255 }),
    table_name:      varchar("table_name",  { length: 255 }),
    column_name:     varchar("column_name", { length: 255 }),
    present:         boolean("present").notNull(),
    rows:            bigint("rows", { mode: "number" }).notNull(),
    distinct_values: bigint("distinct_values", { mode: "number" }).notNull(),
    unmapped:        bigint("unmapped", { mode: "number" }).notNull(),
    scanned_at:      timestamp("scanned_at").notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.tenant_id, t.dim_id, t.database_id, t.schema_name, t.table_name, t.column_name],
    }),
    foreignKey({
      columns:        [t.database_id],
      foreignColumns: [warehouseDatabase.id],
      name:           "source_stat_database_fk",
    }).onDelete("cascade"),
    check("source_stat_schema_name_nonempty", sql`length(${t.schema_name}) > 0`),
    check("source_stat_table_name_nonempty",  sql`length(${t.table_name})  > 0`),
    check("source_stat_column_name_nonempty", sql`length(${t.column_name}) > 0`),
  ],
);

export const draft = app.table(
  "draft",
  {
    dim_id:       varchar("dim_id").notNull(),
    raw:          varchar("raw").notNull(),
    status:       varchar("status").notNull(),
    target_label: varchar("target_label"),
    target_key:   varchar("target_key"),
    user_id:      varchar("user_id").notNull(),
    created_at:   timestamp("created_at").notNull(),
    source:       varchar("source").notNull().default("user"),
    confidence:   varchar("confidence"),
    reasoning:    varchar("reasoning"),
    tenant_id:    varchar("tenant_id").notNull().references(() => tenant.id),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.dim_id, t.raw, t.user_id] }),
    index("draft_tenant_idx").on(t.tenant_id),
    check("draft_source_chk", sql`${t.source} IN ('user', 'ai')`),
    check("draft_confidence_chk", sql`${t.confidence} IS NULL OR ${t.confidence} IN ('high', 'medium', 'low')`),
  ],
);

export const auditLog = app.table(
  "audit_log",
  {
    id:         varchar("id").primaryKey(),
    created_at: timestamp("created_at").notNull(),
    user_id:    varchar("user_id").notNull(),
    action:     varchar("action").notNull(),
    detail:     varchar("detail").notNull(),
    table_id:   varchar("table_id"),
    row_key:    varchar("row_key"),
    tenant_id:  varchar("tenant_id").notNull().references(() => tenant.id),
    metadata:   jsonb("metadata"),
  },
  (t) => [
    index("audit_log_table_row_recency_idx")
      .on(t.table_id, t.row_key, t.created_at.desc())
      .where(sql`${t.table_id} IS NOT NULL`),
    index("audit_log_tenant_time_idx").on(t.tenant_id, t.created_at.desc()),
  ],
);

export const users = app.table(
  "users",
  {
    id:            varchar("id").primaryKey(),
    name:          varchar("name").notNull(),
    initials:      varchar("initials").notNull(),
    email:         varchar("email"),
    google_sub:    varchar("google_sub"),
    password_hash: varchar("password_hash"),
    auth_provider: varchar("auth_provider").notNull().default("password"),
    is_super_admin: boolean("is_super_admin").notNull().default(false),
    last_seen_at:  timestamp("last_seen_at"),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email).where(sql`email IS NOT NULL`),
    uniqueIndex("users_google_sub_unique").on(t.google_sub).where(sql`google_sub IS NOT NULL`),
  ],
);

export const apiTokens = app.table(
  "api_tokens",
  {
    id:           varchar("id").primaryKey(),
    user_id:      varchar("user_id").notNull(),
    name:         varchar("name").notNull(),
    token_hash:   varchar("token_hash").notNull(),
    /* First 12 chars of plaintext token (e.g. "zz_abc8…"). NOT secret —
       indexed for O(1) auth lookup. */
    token_prefix: varchar("token_prefix", { length: 12 }).notNull(),
    created_at:   timestamp("created_at").notNull(),
    last_used_at: timestamp("last_used_at"),
    revoked_at:   timestamp("revoked_at"),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_unique").on(t.token_hash),
    index("api_tokens_user_id_idx").on(t.user_id),
    index("api_tokens_prefix_idx")
      .on(t.token_prefix)
      .where(sql`revoked_at IS NULL`),
  ],
);

export const activeSessions = app.table("active_sessions", {
  user_id:   varchar("user_id").primaryKey(),
  last_seen: timestamp("last_seen").notNull(),
  tenant_id: varchar("tenant_id").notNull().references(() => tenant.id),
  impersonating_tenant_id: varchar("impersonating_tenant_id"),
});


export const sessions = app.table(
  "sessions",
  {
    id:         varchar("id").primaryKey(),
    user_id:    varchar("user_id").notNull(),
    expires_at: timestamp("expires_at").notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.user_id)],
);

export const preferences = app.table(
  "preferences",
  {
    id:                serial("id").primaryKey(),
    publish_threshold: integer("publish_threshold").notNull(),
    suggest_threshold: integer("suggest_threshold").notNull(),
    scan_schedule:     varchar("scan_schedule", { length: 10 }),
    updated_at:        timestamp("updated_at").notNull(),
    ai_enabled:        boolean("ai_enabled").notNull().default(false),
    ai_provider:       varchar("ai_provider").notNull().default("none"),
    ai_api_key:        varchar("ai_api_key"),
    tenant_id:         varchar("tenant_id").notNull().references(() => tenant.id),
  },
  (t) => [
    uniqueIndex("preferences_tenant_unique").on(t.tenant_id),
    check("preferences_ai_provider_chk", sql`${t.ai_provider} IN ('openai', 'anthropic', 'none')`),
  ],
);

export const userGridLayout = app.table(
  "user_grid_layout",
  {
    user_id:    varchar("user_id").notNull(),
    dim_id:     varchar("dim_id").notNull(),
    config:     varchar("config").notNull(),
    updated_at: timestamp("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.user_id, t.dim_id] })],
);

export const aiHintCache = app.table(
  "ai_hint_cache",
  {
    dim_id:     varchar("dim_id").notNull(),
    raw:        varchar("raw").notNull(),
    suggestion: varchar("suggestion"),
    confidence: integer("confidence").notNull(),
    reasoning:  varchar("reasoning").notNull(),
    model:      varchar("model").notNull(),
    created_at: timestamp("created_at").notNull(),
    hits:       integer("hits").notNull().default(sql`0`),
    tenant_id:  varchar("tenant_id").notNull().references(() => tenant.id),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.dim_id, t.raw] }),
    index("ai_hint_cache_dim_id_idx").on(t.dim_id),
    index("ai_hint_cache_tenant_dim_idx").on(t.tenant_id, t.dim_id),
  ],
);

export const scanRuns = app.table(
  "scan_run",
  {
    id:            varchar("id").notNull(),
    source_id:     varchar("source_id").notNull(),
    started_at:    timestamp("started_at").notNull(),
    ended_at:      timestamp("ended_at"),
    status:        varchar("status").notNull(),
    rows_scanned:  integer("rows_scanned"),
    duration_ms:   integer("duration_ms"),
    error_message: text("error_message"),
    tenant_id:     varchar("tenant_id").notNull().references(() => tenant.id),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.id] }),
    index("scan_run_source_id_idx").on(t.source_id),
    index("scan_run_started_at_idx").on(t.started_at),
  ],
);

export const canonicalVersion = app.table(
  "canonical_version",
  {
    dim_id:     varchar("dim_id").notNull(),
    key:        varchar("key").notNull(),
    version:    integer("version").notNull(),
    updated_at: timestamp("updated_at").notNull(),
    /** Semantically users.id. No FK constraint — matches existing convention
     *  (repo-canonical.ts uses userId strings without enforced FKs). */
    updated_by: varchar("updated_by").notNull(),
    /* Soft-delete: nullable. retired_at NOT NULL marks a tombstone row;
       retired_into is the survivor key when a merge produced the tombstone,
       NULL when the row was retired without a merge. See repo-canonical.ts
       mergeCanonical / retireCanonical. */
    retired_at:   timestamp("retired_at"),
    retired_into: varchar("retired_into"),
    tenant_id:  varchar("tenant_id").notNull().references(() => tenant.id),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.dim_id, t.key] }),
    index("canonical_version_recent_idx").on(t.dim_id, t.updated_at),
    index("canonical_version_tenant_dim_idx").on(t.tenant_id, t.dim_id),
    /* Pull API live-row read path (PR2). Partial over un-retired rows. */
    index("canonical_version_pull_idx")
      .on(t.tenant_id, t.dim_id, t.updated_at, t.key)
      .where(sql`retired_at IS NULL`),
    /* Pull API tombstone read path (PR2). */
    index("canonical_version_tombstone_idx")
      .on(t.tenant_id, t.dim_id, t.retired_at)
      .where(sql`retired_at IS NOT NULL`),
  ],
);

/* ---------- Multi-tenant (PR 1 of 5) ---------- */

export const tenant = app.table(
  "tenant",
  {
    id:           varchar("id").primaryKey(),
    slug:         varchar("slug").notNull(),
    label:        varchar("label").notNull(),
    color:        varchar("color"),
    created_at:   timestamp("created_at").notNull(),
    deleted_at:   timestamp("deleted_at"),
  },
  (t) => [
    // slug is the URL segment — must be globally unique to route to one tenant.
    uniqueIndex("tenant_slug_unique").on(t.slug),
    // 21-char cap on id keeps room for dim_${tenantId}_${dimSlug} under Postgres's
    // 63-byte identifier limit (4 + 21 + 1 + 37 = 63).
    check("tenant_id_format", sql`${t.id} ~ '^[a-z][a-z0-9_]{0,20}$'`),
    // slug is the URL segment; same constraint shape.
    check("tenant_slug_format", sql`${t.slug} ~ '^[a-z][a-z0-9_]{0,20}$'`),
  ],
);

export const tenantMember = app.table(
  "tenant_member",
  {
    tenant_id:  varchar("tenant_id").notNull(),
    user_id:    varchar("user_id").notNull(),
    role:       varchar("role").notNull(),
    created_at: timestamp("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.user_id] }),
    index("tenant_member_user_idx").on(t.user_id),
    check("tenant_member_role_chk", sql`${t.role} IN ('admin', 'editor', 'viewer')`),
  ],
);

export const tenantInvite = app.table(
  "tenant_invite",
  {
    tenant_id:  varchar("tenant_id").notNull(),
    email:      varchar("email").notNull(),
    role:       varchar("role").notNull(),
    invited_by: varchar("invited_by").notNull(),
    invited_at: timestamp("invited_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.email] }),
    index("tenant_invite_email_idx").on(t.email),
    check("tenant_invite_role_chk", sql`${t.role} IN ('admin', 'editor', 'viewer')`),
  ],
);

export const warehouseDatabase = app.table(
  "warehouse_database",
  {
    id:               varchar("id").notNull().primaryKey(),
    database_name:    varchar("database_name", { length: 255 }).notNull(),
    label:            varchar("label", { length: 255 }),
    last_probe_at:    timestamp("last_probe_at"),
    last_probe_error: text("last_probe_error"),
    added_at:         timestamp("added_at").notNull(),
    added_by:         varchar("added_by").notNull(),
  },
  (t) => [
    uniqueIndex("warehouse_database_database_name_uniq").on(t.database_name),
  ],
);

export const userWarehouseState = app.table(
  "user_warehouse_state",
  {
    user_id:            varchar("user_id").notNull(),
    tenant_id:          varchar("tenant_id").notNull().references(() => tenant.id),
    recent_database_id: varchar("recent_database_id"),
    updated_at:         timestamp("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenant_id, t.user_id] }),
    foreignKey({
      columns:        [t.recent_database_id],
      foreignColumns: [warehouseDatabase.id],
      name:           "user_warehouse_state_recent_db_fk",
    }).onDelete("set null"),
  ],
);

/* ---------- Outbound integrations (PR1 of 4) ---------- */

export const serviceAccount = app.table(
  "service_account",
  {
    id:           varchar("id").primaryKey(),
    tenant_id:    varchar("tenant_id").notNull().references(() => tenant.id),
    name:         varchar("name").notNull(),
    /* Argon2id of the full token string. Verified, never used for signing. */
    token_hash:   varchar("token_hash").notNull(),
    /* First 12 chars of plaintext token (e.g. "zzsa_b8K3kP"). NOT secret —
       used as a non-cryptographic lookup column so auth is a single-row hash
       verify instead of a full table scan. */
    token_prefix: varchar("token_prefix", { length: 12 }).notNull(),
    scopes:       varchar("scopes").array().notNull().default(sql`ARRAY['read']::varchar[]`),
                                                      // v1: ['read'] only; reserved: ['webhook:manage']
    created_at:   timestamp("created_at").notNull(),
    created_by:   varchar("created_by").notNull(),    // users.id
    last_used_at: timestamp("last_used_at"),
    revoked_at:   timestamp("revoked_at"),
    expires_at:   timestamp("expires_at"),            // null = never
  },
  (t) => [
    uniqueIndex("service_account_token_hash_unique").on(t.token_hash),
    index("service_account_tenant_prefix_idx").on(t.tenant_id, t.token_prefix),
    index("service_account_tenant_idx").on(t.tenant_id),
    check(
      "service_account_scope_chk",
      sql`${t.scopes} <@ ARRAY['read', 'webhook:manage']::varchar[]
           AND cardinality(${t.scopes}) >= 1`,
    ),
  ],
);

export const webhook = app.table(
  "webhook",
  {
    id:            varchar("id").primaryKey(),
    tenant_id:     varchar("tenant_id").notNull().references(() => tenant.id),
    url:           varchar("url", { length: 2048 }).notNull(),
    /* Webhook secrets are SIGNING KEYS, not passwords. We need the plaintext on
       every delivery to compute HMAC_SHA256, so we cannot argon2-hash them.
       AES-256-GCM ciphertext under a server-side master key. */
    secret_ciphertext:  bytea("secret_ciphertext").notNull(),
    secret_nonce:       bytea("secret_nonce").notNull(),
    secret_key_version: integer("secret_key_version").notNull().default(1),
    secret_prefix:      varchar("secret_prefix", { length: 12 }).notNull(),
    /* Optional grace-period dual-key support: 24h post-rotation. */
    secret_ciphertext_previous: bytea("secret_ciphertext_previous"),
    secret_nonce_previous:      bytea("secret_nonce_previous"),
    secret_previous_expires_at: timestamp("secret_previous_expires_at"),
    secret_prefix_previous:     varchar("secret_prefix_previous", { length: 12 }),
    events:        varchar("events").array().notNull(),
    status:        varchar("status", { length: 16 }).notNull().default("active"),
                                                      // 'active' | 'paused' | 'disabled'
    description:   varchar("description"),
    created_at:    timestamp("created_at").notNull(),
    created_by:    varchar("created_by").notNull(),
    paused_at:     timestamp("paused_at"),
    disabled_at:   timestamp("disabled_at"),
    disabled_reason: varchar("disabled_reason"),
  },
  (t) => [
    index("webhook_tenant_idx").on(t.tenant_id),
    check(
      "webhook_status_chk",
      sql`status IN ('active', 'paused', 'disabled')`,
    ),
    check(
      "webhook_url_scheme_chk",
      sql`${t.url} ~* '^https?://'`,
    ),
    check(
      "webhook_events_nonempty_chk",
      sql`cardinality(${t.events}) > 0`,
    ),
    /* v1 closed taxonomy. webhook.test is a synthetic event (NEVER stored and
       NEVER subscribable); it is intentionally absent. Adding a type here
       requires the same change to outbound_event_type_chk below — KEEP IN SYNC. */
    check(
      "webhook_events_known_chk",
      sql`${t.events} <@ ARRAY[
        'dimension.committed',
        'dimension.created',
        'dimension.schema.updated',
        'canonical.deleted'
      ]::varchar[]`,
    ),
  ],
);

export const outboundEvent = app.table(
  "outbound_event",
  {
    id:           varchar("id").primaryKey(),
    tenant_id:    varchar("tenant_id").notNull().references(() => tenant.id),
    type:         varchar("type", { length: 64 }).notNull(),
    dim_id:       varchar("dim_id"),
    occurred_at:  timestamp("occurred_at").notNull(),
    payload:      jsonb("payload").notNull(),
    idem_key:     varchar("idem_key", { length: 128 }).notNull(),
  },
  (t) => [
    uniqueIndex("outbound_event_tenant_idem_unique").on(t.tenant_id, t.idem_key),
    index("outbound_event_tenant_type_time_idx").on(
      t.tenant_id,
      t.type,
      t.occurred_at,
      t.id,
    ),
    /* Keep this CHECK in sync with webhook_events_known_chk on the webhook table —
       a webhook subscribing to a type the dispatcher cannot WRITE here would
       silently never receive deliveries. */
    check(
      "outbound_event_type_chk",
      sql`${t.type} IN (
        'dimension.committed',
        'dimension.created',
        'dimension.schema.updated',
        'canonical.deleted'
      )`,
    ),
  ],
);

export const webhookDelivery = app.table(
  "webhook_delivery",
  {
    id:                varchar("id").primaryKey(),
    tenant_id:         varchar("tenant_id").notNull().references(() => tenant.id),
    /* No FK. Webhook DELETE pre-DLQs pending rows in application code; we keep
       the delivery row's audit trail intact even after the parent webhook is gone. */
    webhook_id:        varchar("webhook_id").notNull(),
    /* No FK — the 30-day outbound_event retention sweep would otherwise cascade
       through and erase the delivery's self-contained record. See design §4.4. */
    event_id:          varchar("event_id").notNull(),
    event_type:        varchar("event_type", { length: 64 }).notNull(),
    /* Snapshot of the URL at enqueue time. A URL edit on the parent webhook
       does NOT redirect in-flight deliveries (anti-exfiltration). */
    delivery_url:      varchar("delivery_url", { length: 2048 }).notNull(),
    signing_kid:       varchar("signing_kid", { length: 16 }).notNull(),
                                                      // 'current' | 'previous'
    is_test:           boolean("is_test").notNull().default(false),
    status:            varchar("status", { length: 16 }).notNull(),
                                                      // 'pending' | 'in_flight' | 'success' | 'retry' | 'dlq'
    attempts:          integer("attempts").notNull().default(0),
    max_attempts:      integer("max_attempts").notNull().default(5),
    next_attempt_at:   timestamp("next_attempt_at"),
    last_attempt_at:   timestamp("last_attempt_at"),
    last_response_code: integer("last_response_code"),
    last_response_body: text("last_response_body"),
    last_error:        text("last_error"),
    payload:           jsonb("payload").notNull(),
    /* Format: "t=<unix>,kid=<current|previous>,v1=sha256=<64 hex>" — ~99 chars
       in v1 already; use text so future scheme bumps don't require a migration. */
    signature:         text("signature").notNull(),
    created_at:        timestamp("created_at").notNull(),
    completed_at:      timestamp("completed_at"),
  },
  (t) => [
    index("webhook_delivery_due_idx")
      .on(t.next_attempt_at)
      .where(sql`status IN ('pending', 'retry')`),
    /* The INCLUDE (status, is_test) variant is appended as raw SQL in the
       migration file (Task 3) — Drizzle 0.45.2 does not surface INCLUDE
       through index(). */
    index("webhook_delivery_webhook_time_idx").on(t.webhook_id, t.created_at.desc()),
    index("webhook_delivery_in_flight_reaper_idx")
      .on(t.last_attempt_at)
      .where(sql`status = 'in_flight'`),
    check(
      "webhook_delivery_status_chk",
      sql`status IN ('pending', 'in_flight', 'success', 'retry', 'dlq')`,
    ),
    check(
      "webhook_delivery_signing_kid_chk",
      sql`signing_kid IN ('current', 'previous')`,
    ),
  ],
);
