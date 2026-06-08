***REMOVED*** OSS pivot — design spec

**Date:** 2026-06-08
**Status:** approved (brainstorming complete; ready for implementation planning)
**Supersedes:** the BC-internal north star in `ROADMAP.md` (paused 2026-06-08)

---

***REMOVED******REMOVED*** Goal

Reposition Zugzug from a Zugzug internal tool into an open-source master-data reconciliation product, while keeping BC's running instance functional throughout.

**Locked positioning:** *"The missing curation UI for the dbt stack."* Warehouse-read-only by default; output is plain `dim_*`/`map_*` lookup tables a dbt model `LEFT JOIN`s. Multi-user with drafts, audit, review/approve. Single-tenant per deployment.

**What this is NOT:** generic MDM (Tamr/Stibo/Reltio's lane), an Airtable clone, a data catalog (OpenMetadata/DataHub's lane), or a "platform." Ruthless scope discipline is the moat.

---

***REMOVED******REMOVED*** Why this pivot

Four parallel agent critiques (product, API-design, license/governance, competitive landscape) converged on three load-bearing findings:

1. **MotherDuck-only is the existential risk.** ~85% of warehouse users are on Snowflake / BigQuery / Databricks / Redshift. Shipping OSS without multi-warehouse support is the "300 stars and quietly deprecate" failure mode.
2. **ADBC is the wrong abstraction for this stack in 2026.** No production Node.js binding exists; Databricks has no ADBC driver at all. Per-warehouse native Node drivers behind a thin `WarehouseAdapter` interface is the right approach for this stack's narrow query surface.
3. **The gap is real but narrow.** No OSS tool serves dbt teams who need curated lookup tables — dbt seeds are the de-facto pattern and everyone admits they're broken (no UI, requires PRs from business users, no audit, no review). OpenMetadata/Atlas/DataHub describe data, they don't reconcile values. Tamr is enterprise-priced and targets MDM teams, not analytics engineers.

The competitive moat is **positioning discipline**, not feature parity. Win the "curation UI for dbt-stack" niche; don't try to win MDM.

---

***REMOVED******REMOVED*** Strategic decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| **Positioning** | Curation UI for dbt teams | Defensible niche; survives the four agent critiques. |
| **Warehouses in v1** | DuckDB/MotherDuck + Snowflake | Two adapters prove abstraction; ~85% Snowflake market coverage. Others = v1.1 PRs welcome. |
| **Canonical store** | Configurable per workspace | Warehouse-write default (writable creds); Postgres-canonical + Parquet/CSV export fallback (read-only creds). Capability is derived from the adapter, not user-selected. |
| **Auth** | Local email/password default + OIDC pluggable + API tokens | OIDC env-driven, no admin UI in v1. Google OAuth becomes one of many OIDC providers, not a hard-coded path. |
| **Tenancy** | Single-tenant OSS, multi-tenant code preserved gated | UI hidden behind `ZUGZUG_MULTI_TENANT=true`; schema unchanged; preserves cloud-product optionality. |
| **License** | MIT + DCO | Friendlier to contributors; closes the BSL/Apache+CLA escape hatch (one-way door, accepted). |
| **Repo strategy** | Single repo, in-place refactor | One codebase; BC's deployment becomes "a Zugzug user" with separate config. |
| **Brand** | Keep "Zugzug" (accept trademark risk) | Bikeshedding deferred. Rebrand if/when traction warrants. |
| **OpenRefine Reconciliation API** | Dropped | Focus over wedge. |
| **`Sql` branded type** | Deferred (project-wide pass) | Half-branded gives false confidence. |

---

***REMOVED******REMOVED*** Architecture

***REMOVED******REMOVED******REMOVED*** Three-store model — post-pivot

| Store | Engine | Access | Holds |
|---|---|---|---|
| **Warehouse** | Pluggable via `WarehouseAdapter` (DuckDB/MotherDuck or Snowflake in v1) | Read-only OR Read-write (capability-derived) | Source tables scanned for distinct values |
| **Canonical store** | Warehouse OR Postgres (adapter-capability-driven) | Read/write | `dim_*`/`map_*` |
| **App state** | Postgres | Read/write | Drafts, audit, dimension registry, users, sessions, preferences, workspaces |

**Invariant:** the warehouse-write path is the default. The Postgres-canonical path is the compatibility fallback for deployments with read-only warehouse credentials.

***REMOVED******REMOVED******REMOVED*** `WarehouseAdapter` interface

Thin, read-mostly, no SQL escape hatch. Each adapter owns all warehouse-specific quirks (identifier casing, type casts, catalog browsing, auth) behind it.

```ts
// server/src/warehouse/adapter.ts

export interface Ref {
  readonly catalog?: string;   // Snowflake/BigQuery 3-part; omit for DuckDB/PG
  readonly schema: string;
  readonly table: string;
}

export interface AdapterIds { duckdb: true; snowflake: true; }
export type AdapterId = keyof AdapterIds;

export interface AdapterCapabilities {
  readonly id: AdapterId;
  readonly writable: boolean;
  readonly supportsMerge: boolean;
  readonly identifierCase: 'preserve' | 'upper' | 'lower';
  readonly supportsApproximateDistinct: boolean;
}

interface BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities;

  ping(): Promise<boolean>;

  // Catalog
  listTables(opts?: { schema?: string; search?: string }): Promise<CatalogTable[]>;
  listColumns(table: Ref): Promise<ColumnMeta[]>;
  tableExists(table: Ref): Promise<boolean>;

  // Value scans
  distinctValues(table: Ref, column: string, limit: number): Promise<string[]>;
  topValuesByFrequency(table: Ref, column: string, limit: number): Promise<ValueCount[]>;
  columnStats(table: Ref, column: string, opts?: { approximate?: boolean }): Promise<{ rows: number; distinct: number }>;
  nameResolution(table: Ref, idCol: string, nameCol: string): Promise<Map<string, string>>;

  // SQL fragment builders (per-adapter; no shared qid())
  quoteIdentifier(name: string): string;
  qualifyRef(table: Ref): string;
  castToString(expr: string): string;
}

export interface WritableWarehouseAdapter extends BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: true };
  ensureCanonicalTables(dim: DimensionSpec): Promise<void>;
  commitCanonical(dim: DimensionSpec, drafts: ApprovedDraft[]): Promise<CommitResult>;
}

export interface ReadOnlyWarehouseAdapter extends BaseWarehouseAdapter {
  readonly capabilities: AdapterCapabilities & { readonly writable: false };
  exportCanonicalSnapshot(dim: DimensionSpec, format: 'parquet' | 'csv'): Promise<Buffer>;
}

export type WarehouseAdapter = WritableWarehouseAdapter | ReadOnlyWarehouseAdapter;
export const isWritable = (a: WarehouseAdapter): a is WritableWarehouseAdapter =>
  a.capabilities.writable === true;
```

**Three interface rules:**

1. **No `query(sql)` escape hatch.** All query shapes the app needs are first-class methods. New shape → new method → both adapters update together.
2. **Writability is a type-level split**, not a runtime check. Calling `commitCanonical` on a `ReadOnlyWarehouseAdapter` is a compile error.
3. **Quoting and casting are owned by the adapter**, not a shared helper. There is no portable `qid()` — Snowflake stores unquoted identifiers UPPERCASE, BigQuery lowercases, DuckDB preserves but is case-insensitive on lookup.

***REMOVED******REMOVED******REMOVED*** Credentials & registry

```ts
// Zod discriminated union; validated at the boundary
const DuckDbCredentials = z.object({ type: z.literal('duckdb'), token: z.string(), path: z.string().optional() });
const SnowflakeCredentials = z.object({
  type: z.literal('snowflake'),
  account: z.string(), user: z.string(),
  privateKey: z.string(), privateKeyPassphrase: z.string().optional(),
  warehouse: z.string(), database: z.string(), schema: z.string(),
});
export const WarehouseCredentials = z.discriminatedUnion('type', [DuckDbCredentials, SnowflakeCredentials]);

// Mapped-type factory registry; missing factory = compile error
type AdapterFactory<C extends WarehouseCredentials> = (creds: C) => WarehouseAdapter;
const factories: { [K in WarehouseCredentials['type']]: AdapterFactory<Extract<WarehouseCredentials, { type: K }>> } = {
  duckdb: (creds) => new DuckDbAdapter(creds),
  snowflake: (creds) => new SnowflakeAdapter(creds),
};

export function resolveAdapter(raw: unknown): WarehouseAdapter {
  const creds = WarehouseCredentials.parse(raw);
  const factory = factories[creds.type] as AdapterFactory<typeof creds>;
  return factory(creds);
}
```

Workspace row in Postgres gains a `warehouse_config jsonb` carrying the credential blob. `getAdapter(workspaceId)` returns a cached instance, lazy-init.

***REMOVED******REMOVED******REMOVED*** File layout

```
server/src/warehouse/
  adapter.ts          ***REMOVED*** interface + types + isWritable guard
  registry.ts         ***REMOVED*** getAdapter(workspaceId) → cached WarehouseAdapter
  credentials.ts      ***REMOVED*** Zod discriminated union + factory registry
  duckdb/index.ts     ***REMOVED*** DuckDbAdapter (covers DuckDB + MotherDuck)
  snowflake/index.ts  ***REMOVED*** SnowflakeAdapter
```

Current `server/src/db.ts` shrinks to "open the DuckDB process handle the DuckDbAdapter uses internally." Current `server/src/repo-scan.ts` becomes adapter-agnostic. `whTable()` in `repo-shared.ts` dies — every callsite routes through `adapter.qualifyRef()`.

***REMOVED******REMOVED******REMOVED*** Canonical-store modes

Workspace's adapter capability determines storage:

- **`writable: true` (e.g. Snowflake with writable creds)** → `commit()` runs `adapter.commitCanonical(dim, drafts)` inside a Postgres transaction (alongside Postgres-canonical mirror + audit). MERGE into `dim_*`/`map_*` in the user's warehouse, configurable schema (default `zugzug`).
- **`writable: false` (e.g. read-only MotherDuck token, BC's case)** → `commit()` only writes to Postgres. Users hit `GET /api/dimensions/:id/snapshot.parquet` (API-token-authed) to fetch the latest snapshot; integration into dbt is via `external` source, `dbt seed`, or a CI script. We document the three patterns; we don't pick one.

The Postgres mirror of `dim_*`/`map_*` exists in **both modes** as the OLTP working copy — what changes is whether commit also propagates to the warehouse.

**UI surfaces of mode:**
- Dashboard "Canonical destination" badge: `🟢 Snowflake (writable)` vs `📦 Local + export`.
- Commit affordance copy: `Approve & commit to warehouse` vs `Approve & save (snapshot available for download)`.
- No engineer-mode hiding — this is information every user needs.

**Mode-upgrade migration:** when a workspace's credentials change from read-only to writable, on the next commit the server runs `adapter.ensureCanonicalTables(dim)` + `adapter.commitCanonical(dim, allCanonicalRecords)` for every dimension once (silent backfill), then subsequent commits flow normally.

***REMOVED******REMOVED******REMOVED*** Auth refactor

- **Local password auth** (default): argon2 hashing, sessions via existing cookie + Postgres `app.session` table. Routes: `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/logout`. First user becomes admin; subsequent users invited (existing invite table reused).
- **OIDC plugin**: env-driven (`OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`). Uses [`openid-client`](https://github.com/panva/openid-client). Login page conditionally shows "Sign in with SSO." Google OAuth becomes a generic OIDC provider configuration, not a hard-coded path.
- **API tokens**: new `app.api_token` table (token hash, user_id, name, last_used_at). Generated from a Settings page; passed via `Authorization: Bearer ...`. Required for `GET /api/dimensions/:id/snapshot.parquet` and headless integrations.

***REMOVED******REMOVED******REMOVED*** BC-ism strip

| Item | Action |
|---|---|
| Google OAuth hardcoded path | Replaced by OIDC plugin (one of N providers, env-driven) |
| Engineer-mode default = OFF | Flip default to ON; keep toggle as per-user pref; BC can override via initial-seed config |
| Multi-tenant workspace UI | Hide behind `ZUGZUG_MULTI_TENANT=true` env flag (default false for OSS, true for BC/cloud); schema and code unchanged |
| BC-specific seed dimensions (`partner`, `channel`, BC values) | Replaced with generic examples (`product_category`, `customer_segment`, generic countries) in `seed-rich.ts` / `seed.ts` |
| BC jargon in UI copy | Grep + sweep; remove "Zugzug," "BC," internal hostnames, internal-team-name tooltips |
| Sentry DSN, MotherDuck tokens, BC hostnames in git history | `git-filter-repo` scrub before first public push (Phase 5) |

---

***REMOVED******REMOVED*** Phased work plan

Six phases, each with a hard verification gate. The gates exist because Approach A's bet is that the adapter abstraction generalizes — if it doesn't, that needs to surface before the cosmetic work, not after.

***REMOVED******REMOVED******REMOVED*** Phase 1 — Extract `WarehouseAdapter` against DuckDB only (~weeks 1–3)
Refactor in place. Every existing query routed through the new interface; DuckDB is the only concrete adapter. The Snowflake adapter file exists but is a stub.

**Gate:** all existing tests pass; manual UI smoke (Sources, Triage, Tables, Dashboard) feature-equivalent to today; zero raw DuckDB calls outside `warehouse/duckdb/`; zero `whTable()` callsites remaining in app code.

***REMOVED******REMOVED******REMOVED*** Phase 2 — Implement `SnowflakeAdapter` (~weeks 4–6) — **gating phase**
This is the load-bearing technical bet. Sign up for a Snowflake free trial (30 days, $400 credit). Implement against a real Snowflake account with a representative test dataset (~1000 rows across 3 schemas). Four day-one blockers will hit here:

- Identifier casing (UPPERCASE unquoted default; quoting makes it case-sensitive)
- `CAST AS VARCHAR` vs `CAST AS STRING` (Snowflake accepts both; BigQuery later won't)
- `SHOW TABLES` vs `INFORMATION_SCHEMA.TABLES` for catalog browsing
- Key-pair auth wiring with `snowflake-sdk`

**Gate:** full Sources → Triage → commit-to-warehouse flow works end-to-end against Snowflake. `commitCanonical` produces correct `dim_*`/`map_*` rows; a hand-written dbt model `LEFT JOIN`-ing them returns expected results.

**Abort point:** if Phase 2 exposes that two adapters can't share a meaningful interface, stop the pivot and reconsider. Don't push through.

***REMOVED******REMOVED******REMOVED*** Phase 3 — Canonical-store modes (~weeks 7–8)
- Implement `WritableWarehouseAdapter.commitCanonical` (Snowflake MERGE).
- Implement `ReadOnlyWarehouseAdapter.exportCanonicalSnapshot` (DuckDB-driven Parquet writer over Postgres canonical; DuckDB stays linked in-process even when the warehouse adapter is Snowflake).
- Workspace upgrade path (read-only → writable backfill).
- Dashboard canonical-destination badge.
- Commit affordance copy per mode.

**Gate:** both modes round-trip: fresh workspace with read-only MotherDuck token works via export (download Parquet, verify schema); workspace with writable Snowflake creds works via MERGE (commit, query Snowflake directly, rows match Postgres mirror). Mode-upgrade backfill verified once.

***REMOVED******REMOVED******REMOVED*** Phase 4 — Strip BC-isms (~weeks 9–10)
Auth refactor (local password + OIDC + API tokens), engineer-mode default flip, workspace UI gating, seed-data scrub, copy sweep.

**Gate:** clean self-host walkthrough works on a fresh machine: `bun run bootstrap`, signup as first user (becomes admin), invite second user, both log in with passwords, optional OIDC tested against a self-hosted Authentik or similar, API token generated, `GET /api/dimensions/:id/snapshot.parquet` returns valid Parquet. No Google-OAuth-only code paths remain.

***REMOVED******REMOVED******REMOVED*** Phase 5 — Legal + scrub (~week 11)
BC legal written sign-off on IP assignment + MIT release. `git-filter-repo` pass against full history (tokens, hostnames, customer names, `zugzug` substrings). LICENSE (MIT) + NOTICE + CONTRIBUTING.md (DCO) + SECURITY.md drafted. GitHub repo rename. `license-checker` in CI with deny-list for GPL/AGPL/SSPL.

**Gate:** `git log --all -p | grep -iE '(token|secret|sentry|@bettercollective|zugzug)'` returns nothing. License audit clean. BC legal sign-off in writing.

***REMOVED******REMOVED******REMOVED*** Phase 6 — Public push + v1.0 (~week 12)
Force-push scrubbed history to fresh public repo. Tag `v1.0.0`. Launch post (HN, dbt Slack, r/dataengineering) with locked positioning. Issue templates for "add adapter for X."

**Gate:** docs render, install works on clean machine in <10 min, contributor can scaffold a new adapter file from the `WarehouseAdapter` example.

***REMOVED******REMOVED******REMOVED*** Time budget
~12 weeks solo, full-time. Roughly half (6 weeks) is the adapter work; the other half is cosmetic but unavoidable. Plan slippage in Phase 2 — Snowflake adapters always take longer than estimated.

---

***REMOVED******REMOVED*** Out of scope (v1.1+)

Captured here so they're not re-litigated and don't leak into v1.0 scope creep.

| Item | Reason deferred | Trigger to pull forward |
|---|---|---|
| BigQuery adapter | v1 scope cut for ship velocity | Community PR or 5+ inbound "does it support BigQuery?" issues |
| Databricks adapter | Same | Same trigger |
| Redshift adapter | Cheap follow-on to Postgres-warehouse (PG wire protocol) | After v1.1 PG-warehouse lands |
| Postgres-as-warehouse adapter | v1 scope cut | Community PR or self-host request |
| dbt package (`zugzug_utils` with macros) | v1 stays "plain SQL output, BYO consumer" | After v1.0 launch metrics show dbt-team adoption |
| S3/GCS snapshot push | Download endpoint sufficient for v1 | First user request for scheduled exports |
| Scheduled exports / webhook-on-commit | Same | Same |
| OIDC web UI configuration | Env-only sufficient for v1 self-hosters | Cloud offering, if it ever exists |
| Workspace switcher UI for OSS | Single-tenant locked for v1 | Cloud offering trigger |
| `Sql` branded type project-wide cleanup | Half-branded gives false confidence | Any project-wide refactor touching `qid`/`cq`/`whTable` callsites |

---

***REMOVED******REMOVED*** Killed / closed doors

Decisions that take items off the table permanently (or near-permanently). Captured so they don't re-emerge later as "what about X?"

| Item | Disposition | What would reopen it |
|---|---|---|
| OpenRefine Reconciliation API | Dropped for focus, not parked | A 10× distribution opportunity tied specifically to the OpenRefine community |
| Apache-2.0 + CLA + BSL escape hatch | Closed by MIT+DCO choice — one-way door | Would require every contributor to sign a relicense; effectively unavailable post-launch |
| ADBC as the warehouse abstraction | Wrong for Node stack in 2026 | A production-grade Node ADBC binding with Databricks + Snowflake + BigQuery driver coverage |
| Brand rebrand pre-launch | Deferred to "if traction" | Blizzard cease-and-desist, USPTO trademark filing, or genuine breakout |
| Generic MDM positioning | Killed by competitive landscape (Tamr/Stibo own that lane) | Never — explicit anti-goal |
| Airtable-shaped feature surface (rich types, attachments, app builder) | Killed by positioning discipline | Never — explicit anti-goal |

---

***REMOVED******REMOVED*** Risks & open questions

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase 2 Snowflake adapter exposes that the abstraction can't generalize | Medium | Hard abort point at Phase 2 gate; reconsider rather than push through |
| BC legal sign-off blocks Phase 5 indefinitely | Medium | Start legal conversation in Phase 1 (parallel track), not Phase 5 |
| `git-filter-repo` misses a secret | Low-medium | Run `gitleaks` + manual grep before public push; revoke any leaked credentials |
| Engineer-mode default flip surprises BC users | Low | Override via initial-seed config for BC's deployment |
| MIT license closes future commercial moat | Accepted | Locked decision; can't reopen without re-papering contributors |
| Snowflake free-trial $400 credit runs out mid-Phase-2 | Low | Pay-as-you-go after trial is cheap for this query volume (single-digit dollars) |

**Open questions (resolve before Phase 5):**
- Specific MIT copyright holder: "Zugzug A/S and contributors" vs "Frederik Hagelund and contributors" — BC legal call.
- Public GitHub org: keep `Fredehagelund92/zugzug` or move to a new org. Affects URL forever.

---

***REMOVED******REMOVED*** Roadmap rewrite

`ROADMAP.md` is rewritten in the same commit as this spec. The current BC-internal Now/Next/Later buckets archive to a "Pre-pivot (paused 2026-06-08)" section; this spec's Phases 1–6 become the new Now/Next/Later; v1.1 items above populate the post-launch bucket.

In-flight BC epics paused today:
- ***REMOVED***59 multi-tenant workspaces (phase 1) — multi-tenant UI work specifically; the schema/middleware work already done is preserved and gated behind `ZUGZUG_MULTI_TENANT`
- ***REMOVED***45 canonical_history / per-record revert
- ***REMOVED***33 bulk operations in Triage

These reopen post-v1.0 if BC's deployment still needs them and they're not already covered by v1.0 features.

---

***REMOVED******REMOVED*** References

- Brainstorming conversation transcript: 2026-06-08 session
- Parallel agent critiques (product, API-design, license, competitive): summarized inline above
- ADBC driver status: <https://arrow.apache.org/adbc/current/driver/status.html>
- OpenRefine Reconciliation API spec: <https://www.w3.org/community/reports/reconciliation/CG-FINAL-specs-0.1-20230321/>
- Current architecture (pre-pivot): `app/ARCHITECTURE.md`
- Hard data-access rules (still apply post-pivot): `CLAUDE.md`
