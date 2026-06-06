import { sql } from "drizzle-orm";
import {
  pgSchema,
  varchar,
  boolean,
  bigint,
  integer,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const app = pgSchema("zugzug_app");

export const dimension = app.table("dimension", {
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
});

export const dimensionSource = app.table(
  "dimension_source",
  {
    dim_id:        varchar("dim_id").notNull(),
    source_table:  varchar("source_table").notNull(),
    source_column: varchar("source_column").notNull(),
    schedule:      varchar("schedule"),
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.source_table, t.source_column] })],
);

export const dimensionField = app.table(
  "dimension_field",
  {
    dim_id:     varchar("dim_id").notNull(),
    field:      varchar("field").notNull(),
    label:      varchar("label").notNull(),
    type:       varchar("type").notNull(),
    created_at: timestamp("created_at").notNull(),
    options:    varchar("options"),
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
  },
  (t) => [primaryKey({ columns: [t.dim_id, t.raw, t.user_id] })],
);

export const auditLog = app.table("audit_log", {
  id:         varchar("id").primaryKey(),
  created_at: timestamp("created_at").notNull(),
  user_id:    varchar("user_id").notNull(),
  action:     varchar("action").notNull(),
  detail:     varchar("detail").notNull(),
});

export const users = app.table(
  "users",
  {
    id:         varchar("id").primaryKey(),
    name:       varchar("name").notNull(),
    initials:   varchar("initials").notNull(),
    email:      varchar("email"),
    google_sub: varchar("google_sub"),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email).where(sql`email IS NOT NULL`),
    uniqueIndex("users_google_sub_unique").on(t.google_sub).where(sql`google_sub IS NOT NULL`),
  ],
);

export const activeSessions = app.table("active_sessions", {
  user_id:   varchar("user_id").primaryKey(),
  last_seen: timestamp("last_seen").notNull(),
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

export const preferences = app.table("preferences", {
  id:                integer("id").primaryKey(),
  publish_threshold: integer("publish_threshold").notNull(),
  suggest_threshold: integer("suggest_threshold").notNull(),
  scan_schedule:     varchar("scan_schedule", { length: 10 }),
  updated_at:        timestamp("updated_at").notNull(),
});

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
  },
  (t) => [
    primaryKey({ columns: [t.dim_id, t.raw] }),
    index("ai_hint_cache_dim_id_idx").on(t.dim_id),
  ],
);
