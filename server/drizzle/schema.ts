import { sql } from "drizzle-orm";
import {
  pgSchema,
  varchar,
  boolean,
  bigint,
  integer,
  serial,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  text,
  check,
} from "drizzle-orm/pg-core";

const app = pgSchema("zugzug_app");

export const dimension = app.table(
  "dimension",
  {
    id:          varchar("id").primaryKey(),
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
    tenant_id:   varchar("tenant_id").default("default"),
  },
  (t) => [index("dimension_tenant_idx").on(t.tenant_id)],
);

export const dimensionSource = app.table(
  "dimension_source",
  {
    dim_id:        varchar("dim_id").notNull(),
    source_table:  varchar("source_table").notNull(),
    source_column: varchar("source_column").notNull(),
    tenant_id:     varchar("tenant_id").default("default"),
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.source_table, t.source_column] })],
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
    tenant_id:    varchar("tenant_id").default("default"),
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.field] })],
);

export const sourceStat = app.table(
  "source_stat",
  {
    dim_id:          varchar("dim_id").notNull(),
    source_table:    varchar("source_table").notNull(),
    source_column:   varchar("source_column").notNull(),
    present:         boolean("present").notNull(),
    rows:            bigint("rows", { mode: "number" }).notNull(),
    distinct_values: bigint("distinct_values", { mode: "number" }).notNull(),
    unmapped:        bigint("unmapped", { mode: "number" }).notNull(),
    scanned_at:      timestamp("scanned_at").notNull(),
    tenant_id:       varchar("tenant_id").default("default"),
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.source_table, t.source_column] })],
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
    tenant_id:    varchar("tenant_id").default("default"),
  },
  (t) => [
    primaryKey({ columns: [t.dim_id, t.raw, t.user_id] }),
    index("draft_tenant_idx").on(t.tenant_id),
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
    tenant_id:  varchar("tenant_id").default("default"),
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
    role:           varchar("role").notNull().default("editor"),
    is_super_admin: boolean("is_super_admin").notNull().default(false),
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
    created_at:   timestamp("created_at").notNull(),
    last_used_at: timestamp("last_used_at"),
    revoked_at:   timestamp("revoked_at"),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_unique").on(t.token_hash),
    index("api_tokens_user_id_idx").on(t.user_id),
  ],
);

export const activeSessions = app.table("active_sessions", {
  user_id:   varchar("user_id").primaryKey(),
  last_seen: timestamp("last_seen").notNull(),
  tenant_id: varchar("tenant_id").default("default"),
  impersonating_tenant_id: varchar("impersonating_tenant_id"),
});

export const allowedEmails = app.table("allowed_emails", {
  email:    varchar("email").primaryKey(),
  added_by: varchar("added_by").notNull(),
  added_at: timestamp("added_at").notNull(),
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
    tenant_id:         varchar("tenant_id").default("default"),
  },
  (t) => [uniqueIndex("preferences_tenant_unique").on(t.tenant_id)],
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
    tenant_id:  varchar("tenant_id").default("default"),
  },
  (t) => [
    primaryKey({ columns: [t.dim_id, t.raw] }),
    index("ai_hint_cache_dim_id_idx").on(t.dim_id),
    index("ai_hint_cache_tenant_dim_idx").on(t.tenant_id, t.dim_id),
  ],
);

export const scanRuns = app.table(
  "scan_run",
  {
    id:            varchar("id").primaryKey(),
    source_id:     varchar("source_id").notNull(),
    started_at:    timestamp("started_at").notNull(),
    ended_at:      timestamp("ended_at"),
    status:        varchar("status").notNull(),
    rows_scanned:  integer("rows_scanned"),
    duration_ms:   integer("duration_ms"),
    error_message: text("error_message"),
    tenant_id:     varchar("tenant_id").default("default"),
  },
  (t) => [
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
    tenant_id:  varchar("tenant_id").default("default"),
  },
  (t) => [
    primaryKey({ columns: [t.dim_id, t.key] }),
    index("canonical_version_recent_idx").on(t.dim_id, t.updated_at),
    index("canonical_version_tenant_dim_idx").on(t.tenant_id, t.dim_id),
  ],
);

/* ---------- Multi-tenant (PR 1 of 5) ---------- */

export const tenant = app.table(
  "tenant",
  {
    id:           varchar("id").primaryKey(),
    slug:         varchar("slug").notNull(),
    label:        varchar("label").notNull(),
    warehouse_id: varchar("warehouse_id").notNull(),
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
