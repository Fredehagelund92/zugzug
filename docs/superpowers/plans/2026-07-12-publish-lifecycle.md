# Publish Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restorable publishes (snapshot + rollback), a lightweight four-eyes review inbox, and draft-scoped commits — per `docs/superpowers/specs/2026-07-12-publish-lifecycle-design.md`.

**Architecture:** One migration adds `dimension_version` (snapshot per publish) and draft-rejection columns. The existing `commit()` transaction (server/src/repo-drafts.ts:289) gains an optional `draftKeys` scope and writes the snapshot with the same in-tx version counter. Rollback restores a snapshot into the working copy and republishes through the same commit path. The client reuses PublishPreviewDialog for inbox publishing; the Review page gains an "Awaiting review" section.

**Tech Stack:** Bun + Postgres (raw SQL + Drizzle migrations), React + TS + vitest.

## Global Constraints

- Quality bar (maintained from sub-project A): `cd app && bun run typecheck && bun run test && bun run lint` all exit 0; `cd server && bun test` exit 0 — after EVERY task.
- Glossary (CONTEXT.md): record, source value, Review, table, mapping, publish, version. Never user-facing: canonical/raw/triage/commit/master.
- Spec decisions are binding: rollback = snapshot + republish with working-copy reset (staged drafts preserved); inbox is lightweight (publish or reject-with-required-reason, no other states); rollback is admin-role-only.
- Versions published before this feature have no snapshot; rollback for them is refused (409 `NO_SNAPSHOT`) and disabled in UI with the reason "published before version history existed".
- Outbound `dimension.committed` gains ONLY additive fields `kind` and `restores_version` — existing consumers must see an unchanged event otherwise.
- TDD for all server behavior. Escalation contract: if an integration point behaves differently than this plan assumes (esp. warehouse full-resync, canonical_version bookkeeping), STOP and report BLOCKED — do not improvise publish semantics.
- Commits: conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Branch `publish-lifecycle` off main. NO auto-merge — the run ends at the report.

---

### Task 1: Migration + schema — dimension_version and draft rejection `[sonnet]`

**Files:**
- Create: `server/drizzle/migrations/0036_publish_lifecycle.sql`
- Modify: `server/drizzle/schema.ts` (new table + draft columns; read the file's existing table style first), `server/drizzle/migrations/meta/_journal.json` (append entry idx 36, mirroring idx 35's shape)

**Interfaces:**
- Produces: table `zugzug_app.dimension_version`; draft columns `rejected_reason`, `rejected_by`; draft status domain accepts `'rejected'`.

- [ ] **Step 1: Write the migration** (`0036_publish_lifecycle.sql`):

```sql
CREATE TABLE IF NOT EXISTS "zugzug_app"."dimension_version" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL,
  "dim_id" text NOT NULL,
  "version" integer NOT NULL,
  "kind" text NOT NULL DEFAULT 'publish',
  "restores_version" integer,
  "snapshot" jsonb NOT NULL,
  "published_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dimension_version_kind_chk" CHECK ("kind" IN ('publish','rollback')),
  CONSTRAINT "dimension_version_unique" UNIQUE ("tenant_id","dim_id","version")
);
ALTER TABLE "zugzug_app"."dimension_version" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_iso" ON "zugzug_app"."dimension_version"
  USING ("tenant_id" = current_setting('app.tenant_id', true));

ALTER TABLE "zugzug_app"."draft" ADD COLUMN IF NOT EXISTS "rejected_reason" text;
ALTER TABLE "zugzug_app"."draft" ADD COLUMN IF NOT EXISTS "rejected_by" text;
```

Before writing the RLS policy lines, read migration `0032_dim_scan_values.sql` and copy ITS exact RLS/policy phrasing (the `current_setting` key and policy shape must match the house pattern — if it differs from the above, the house pattern wins). Check whether `draft.status` is enforced by a CHECK constraint (`grep -n "status" server/drizzle/schema.ts` and read the draft table block); if a CHECK exists, extend it to include `'rejected'` in this migration.

- [ ] **Step 2: Update `schema.ts`** — add the `dimension_version` table and the two draft columns, matching neighbors' style exactly. Append the journal entry.
- [ ] **Step 3: Apply + verify** — apply migrations the same way sub-project A's Task 23 did (check `server/package.json` scripts / how 0035 was applied; the test DB must have the new objects). Run `cd server && bun test` → exit 0 (nothing uses the new objects yet; the RLS test counts tables with policies — if it now expects 15, update `server/test/rls-policies.test.ts` count in THIS task with a comment naming the new table).
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(versions): dimension_version snapshots and draft rejection columns

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Snapshot write in commit + versions listing `[sonnet]`

**Files:**
- Modify: `server/src/repo-drafts.ts` (inside `commit()`'s `pgTx`, after the fold and after `v` is computed at ~line 455)
- Create: `server/src/repo-versions.ts`
- Modify: `server/src/server.ts` (GET route, near the publish-state route — grep `publish-state`)
- Test: `server/src/repo-versions.test.ts`

**Interfaces:**
- Consumes: `commit()`'s in-tx version counter `v` and `dbNow`; `pg()`/`cq()` helpers; the tx helpers.
- Produces: `writeVersionSnapshot(tx, {tenantId, dimId, version, kind, restoresVersion, publishedBy, dimTable, mapTable, keyCol})` in repo-versions.ts; `listVersions(dimId, tenantId): Promise<VersionInfo[]>` where `VersionInfo = {version, kind, restoresVersion: number|null, publishedBy, publishedByName, at, counts: {records, mappings}, hasSnapshot: true}`; commit() gains internal opts `{kind?: 'publish'|'rollback', restoresVersion?: number}` (Task 5 uses them); route `GET /api/dimensions/:id/versions`.

- [ ] **Step 1: Failing test** (`server/src/repo-versions.test.ts`, using the harness conventions from `repo-drafts.test.ts` — read it first for fixture setup):

```ts
it("commit writes a snapshot with the same version as the outbound event", async () => {
  await stageDraft(dimId, "usa", "United States", U);
  const res = await repo.commit(dimId, U, T);
  expect(res.committed).toBe(1);
  const versions = await listVersions(dimId, T);
  expect(versions).toHaveLength(1);
  expect(versions[0].kind).toBe("publish");
  expect(versions[0].counts.mappings).toBeGreaterThanOrEqual(1);
  const snap = await getSnapshot(dimId, T, versions[0].version);
  expect(snap!.records.some((r: {key: string}) => r.key === "united_states")).toBe(true);
  expect(snap!.mappings).toContainEqual({ raw: "usa", targetKey: "united_states" });
});
```

(Adapt `stageDraft`/ids to the harness. Export `getSnapshot(dimId, tenantId, version)` from repo-versions.ts too — Task 5 needs it.)

- [ ] **Step 2: Run → FAIL** (module not found).
- [ ] **Step 3: Implement `repo-versions.ts`:**

```ts
import { pg, cq, qid } from "./repo-shared";
import { pgAll, pgGet } from "./pg";

export interface VersionInfo {
  version: number;
  kind: "publish" | "rollback";
  restoresVersion: number | null;
  publishedBy: string;
  publishedByName: string;
  at: string;
  counts: { records: number; mappings: number };
  hasSnapshot: true;
}

export interface Snapshot {
  records: Array<Record<string, unknown>>; // full row objects incl. dynamic attribute columns
  mappings: Array<{ raw: string; targetKey: string }>;
}

/** Capture the just-published content. Runs INSIDE commit()'s transaction so the
 *  snapshot and the version counter are atomic. Dynamic attribute columns are
 *  captured via to_jsonb(t) — the snapshot is schema-agnostic. */
export async function writeVersionSnapshot(
  tx: { run: (sql: string, params?: unknown[]) => Promise<unknown>; all: <T>(sql: string, params?: unknown[]) => Promise<T[]> },
  p: {
    tenantId: string; dimId: string; version: number;
    kind: "publish" | "rollback"; restoresVersion: number | null;
    publishedBy: string; dimTable: string; mapTable: string; keyCol: string;
  },
): Promise<void> {
  const records = await tx.all<Record<string, unknown>>(
    `SELECT to_jsonb(t) AS row FROM ${cq(p.dimTable)} t`,
  );
  const mappings = await tx.all<{ raw: string; targetKey: string }>(
    `SELECT raw, ${qid(p.keyCol)} AS "targetKey" FROM ${cq(p.mapTable)}`,
  );
  const snapshot: Snapshot = {
    records: records.map((r) => (r as { row: Record<string, unknown> }).row),
    mappings,
  };
  await tx.run(
    `INSERT INTO ${pg("dimension_version")}
       (id, tenant_id, dim_id, version, kind, restores_version, snapshot, published_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      `dv_${crypto.randomUUID().replace(/-/g, "")}`,
      p.tenantId, p.dimId, p.version, p.kind, p.restoresVersion,
      JSON.stringify(snapshot), p.publishedBy,
    ],
  );
}

export async function listVersions(dimId: string, tenantId: string): Promise<VersionInfo[]> {
  return pgAll<VersionInfo>(
    `SELECT v.version, v.kind, v.restores_version AS "restoresVersion",
            v.published_by AS "publishedBy", COALESCE(u.name, v.published_by) AS "publishedByName",
            v.created_at AS at,
            json_build_object(
              'records', jsonb_array_length(v.snapshot->'records'),
              'mappings', jsonb_array_length(v.snapshot->'mappings')
            ) AS counts,
            true AS "hasSnapshot"
     FROM ${pg("dimension_version")} v
     LEFT JOIN ${pg("users")} u ON u.id = v.published_by
     WHERE v.dim_id = $1 AND v.tenant_id = $2
     ORDER BY v.version DESC`,
    [dimId, tenantId],
  );
}

export async function getSnapshot(dimId: string, tenantId: string, version: number): Promise<Snapshot | null> {
  const row = await pgGet<{ snapshot: Snapshot }>(
    `SELECT snapshot FROM ${pg("dimension_version")}
     WHERE dim_id = $1 AND tenant_id = $2 AND version = $3`,
    [dimId, tenantId, version],
  );
  return row?.snapshot ?? null;
}
```

(Verify `cq`/`qid`/`pg` import locations against repo-drafts.ts's imports; verify the tx helper's method names against pg.ts. Adjust the `tx.all` jsonb row unwrapping to what the driver actually returns — write a quick harness assertion rather than assuming.)

- [ ] **Step 4: Wire into `commit()`** — signature becomes `commit(dimId, userId, tenantId, draftKeys?: string[], opts?: { kind?: "publish" | "rollback"; restoresVersion?: number })` (Task 3 implements draftKeys; this task adds it as an unused-but-typed param so the signature lands once — pass-through only). Inside the tx, immediately after `v` is computed and the fold statements ran (after the DELETE, before/adjacent to `dispatchOutbound`), call:

```ts
await writeVersionSnapshot(tx, {
  tenantId, dimId, version: v,
  kind: opts?.kind ?? "publish",
  restoresVersion: opts?.restoresVersion ?? null,
  publishedBy: userId,
  dimTable: meta.dimTable, mapTable: meta.mapTable, keyCol: meta.keyCol,
});
```

And add to the outbound payload (additive): `kind: opts?.kind ?? "publish"` and, when set, `restores_version: opts.restoresVersion`.

- [ ] **Step 5: Route** — in server.ts next to the publish-state route: `GET /api/dimensions/:id/versions` (gate: same as publish-state — read its gate and mirror) returning `json(await listVersions(id, tenantCtx.tenantId))`.
- [ ] **Step 6: Run tests → PASS; full server suite → exit 0. Commit** (`feat(versions): snapshot every publish, versions listing`).

---

### Task 3: Draft-scoped commit `[sonnet, opus review]`

**Files:**
- Modify: `server/src/repo-drafts.ts` `commit()` (~289-470), `server/src/server.ts` commit route (grep `"commit"` near dimensions routes)
- Test: `server/src/repo-drafts.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2's extended signature.
- Produces: `draftKeys?: string[]` honored end-to-end; route accepts optional JSON body `{draftKeys?: string[]}`.

- [ ] **Step 1: Failing tests:**

```ts
it("commit with draftKeys folds only those drafts", async () => {
  await stageDraft(dimId, "usa", "United States", U);
  await stageDraft(dimId, "u.s.", "United States", U);
  const res = await repo.commit(dimId, U, T, ["usa"]);
  expect(res.committed).toBe(1);
  const remaining = await listDrafts(dimId, T);
  expect(remaining.map((d) => d.raw)).toEqual(["u.s."]); // untouched, still staged
});
it("commit with an unknown draft key folds nothing and 400s", async () => {
  await stageDraft(dimId, "usa", "United States", U);
  await expect(repo.commit(dimId, U, T, ["usa", "ghost"])).rejects.toThrow(/ghost/);
  expect((await listDrafts(dimId, T)).length).toBe(1);
});
it("four-eyes gate checks only the folded set", async () => {
  await setPreferences({ ...(await getPreferences(T)), requireSecondPublisher: true }, T);
  await stageDraft(dimId, "aaa", "A", U);      // U's draft
  await stageDraft(dimId, "bbb", "B", U2);     // U2's draft
  await expect(repo.commit(dimId, U, T, ["bbb"])).resolves.toMatchObject({ committed: 1 }); // U publishes U2's — fine
  await expect(repo.commit(dimId, U, T, ["aaa"])).rejects.toThrow(/second/i);               // U can't publish own
  await setPreferences({ ...(await getPreferences(T)), requireSecondPublisher: false }, T);
});
```

(Adapt helpers to the harness; `listDrafts` is whatever the harness/repo exposes.)

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Mechanics — one pattern applied consistently:
  - Validate first: when `draftKeys` present, `SELECT raw FROM draft WHERE dim_id/tenant/status='mapped' AND target_key IS NOT NULL AND raw = ANY($3)`; if any requested key is missing from the result, `throw new AppError("VALIDATION_FAILED", \`unknown or unstaged draft keys: ${missing.join(", ")}\`, 400)` BEFORE anything else.
  - Add `AND d.raw = ANY($n)` (or `raw = ANY($n)` on the non-aliased statements) to EVERY draft-filtered statement when scoped: the `approved` count, the four-eyes `ownDrafts` count, `committedRows`, `approvedDrafts`, `remappedDrafts`, the remap UPDATE, both DIMT INSERT branches, the MAPT INSERT, and the DELETE. The DELETE keeps its existing breadth semantics per scope: scoped → `status='mapped' AND raw = ANY($n)`; unscoped → unchanged.
  - The zero-work early return: when scoped and validation passed, `committed` ≥ 1 by construction, so the canonical-changed early return path is unaffected.
  - `rowsRecovered` (rowsForUnmappedDrafts): read its implementation; if it derives from the draft set, pass the scope through; if it derives from the map table only, leave it (state which in the report).
  - Route: parse optional body `{draftKeys}` — `const body = req.headers.get("content-length") ? await req.json().catch(() => null) : null;` style consistent with neighboring routes (read one that takes an optional body); pass to `reqRepo.commit(id, me, body?.draftKeys)`. Note: `reqRepo.commit` — check how tenantId is bound in reqRepo (it was `reqRepo.commit(id, me)` pre-A; sub-project A's Task 23 made it `commit(dimId, userId, tenantId)` — read the current adapter and keep its shape, adding the two new params).
- [ ] **Step 4: Run → PASS; full suite exit 0. Commit** (`feat(publish): commit accepts an explicit draft list`).

---

### Task 4: Reject endpoint `[sonnet]`

**Files:**
- Modify: `server/src/repo-drafts.ts` (new function), `server/src/server.ts` (route next to the drafts routes)
- Test: `server/src/repo-drafts.test.ts` (extend)

**Interfaces:**
- Produces: `rejectDrafts(dimId, tenantId, raws: string[], reason: string, reviewerId: string): Promise<{rejected: number}>`; route `POST /api/dimensions/:id/drafts/reject` `{raws, reason}`, gate `curate`. Draft rows: `status='rejected'`, `rejected_reason`, `rejected_by` set; `saveDraft` re-staging a rejected raw clears both fields (verify how saveDraft upserts — add the clearing to its ON CONFLICT SET list).

- [ ] **Step 1: Failing tests:**

```ts
it("reject sets status, reason, reviewer; re-staging clears them", async () => {
  await stageDraft(dimId, "usa", "United States", U);
  const r = await repo.rejectDrafts(dimId, T, ["usa"], "wrong target — USA is a country not a partner", U2);
  expect(r.rejected).toBe(1);
  const [d] = await listDrafts(dimId, T);
  expect(d.status).toBe("rejected");
  expect(d.rejectedReason).toMatch(/wrong target/);
  await stageDraft(dimId, "usa", "United States of America", U); // re-stage
  const [d2] = await listDrafts(dimId, T);
  expect(d2.status).toBe("mapped");
  expect(d2.rejectedReason).toBeNull();
});
it("reject with empty reason 400s", async () => {
  await expect(repo.rejectDrafts(dimId, T, ["usa"], "  ", U2)).rejects.toThrow(/reason/i);
});
```

- [ ] **Step 2: Run → FAIL.** **Step 3: Implement:**

```ts
export async function rejectDrafts(
  dimId: string, tenantId: string, raws: string[], reason: string, reviewerId: string,
): Promise<{ rejected: number }> {
  const trimmed = reason.trim();
  if (!trimmed) throw new AppError("VALIDATION_FAILED", "a rejection reason is required", 400);
  if (raws.length === 0) return { rejected: 0 };
  const res = await pgAll<{ raw: string }>(
    `UPDATE ${pg("draft")}
        SET status = 'rejected', rejected_reason = $4, rejected_by = $5
      WHERE dim_id = $1 AND tenant_id = $2 AND raw = ANY($3) AND status = 'mapped'
      RETURNING raw`,
    [dimId, tenantId, raws, trimmed, reviewerId],
  );
  return { rejected: res.length };
}
```

(Check the drafts list/serialization path (`listDrafts`/whatever feeds GET drafts) and add `rejectedReason`/`rejectedBy` to its SELECT + wire shape. Update `saveDraft`'s upsert to `rejected_reason = NULL, rejected_by = NULL` on conflict. If the draft status CHECK constraint exists and Task 1 extended it, nothing more; else confirm 'rejected' inserts cleanly.) Route: `POST .../drafts/reject`, gate `curate`, body `{raws: string[], reason: string}` validated, audit entry `appendAuditAs(reviewerId, "Rejected drafts", \`${n} in ${dimId}: ${trimmed}\`, {tenantId, tableId: dimId})` — mirror neighboring audit calls' shape.
- [ ] **Step 4: PASS; suite exit 0. Commit** (`feat(review): reject drafts with a required reason`).

---

### Task 5: Rollback `[sonnet, opus review — highest-stakes task]`

**Files:**
- Create: `server/src/repo-rollback.ts`
- Modify: `server/src/server.ts` (route)
- Test: `server/src/repo-rollback.test.ts`

**Interfaces:**
- Consumes: `getSnapshot` (Task 2), `commit(dimId, userId, tenantId, draftKeys?, opts?)` (Tasks 2–3).
- Produces: `rollbackToVersion(dimId, tenantId, toVersion, userId)` → commit's return shape + `{restoredVersion: number}`; route `POST /api/dimensions/:id/rollback` `{toVersion}` — requester's tenant role must be exactly `admin`.

- [ ] **Step 1: INVESTIGATE (mandatory, before any code):**
  1. **Warehouse full-resync:** the writable adapter's `commitCanonical(dimSpec, approvedDrafts)` merges drafts incrementally — a rollback publish has zero drafts, so the warehouse would keep stale rows. Find the existing full-resync mechanism (Dashboard shows "manual resync required" — grep `resync` and `sync` across server/src and app/src). If a full-table sync primitive exists, rollback uses it post-commit. If NONE exists, STOP: report BLOCKED with what you found — do not invent warehouse deletion semantics.
  2. **canonical_version bookkeeping:** read how `changedKeysSince` and the OCC `expectedVersion` checks use the `canonical_version` table (grep `canonical_version` in server/src). Determine what rollback's delete+reinsert must do so that (a) OCC on subsequent record edits still works, (b) publish-state's changedKeys doesn't resurrect ghosts. Write the finding in the report; the expected answer is "delete canonical_version rows for keys absent from the snapshot; leave/touch the rest" — verify rather than assume.
- [ ] **Step 2: Failing tests:**

```ts
it("rollback restores content and publishes a new version", async () => {
  await stageDraft(dimId, "usa", "United States", U);
  await repo.commit(dimId, U, T);                       // v1
  const v1 = (await listVersions(dimId, T))[0].version;
  await addCanonical(dimId, "Mistake Record", T, U);    // mutate working copy (adapt to real signature)
  await repo.commit(dimId, U, T);                       // v2
  const res = await rollbackToVersion(dimId, T, v1, ADMIN);
  expect(res.restoredVersion).toBe(v1);
  const versions = await listVersions(dimId, T);
  expect(versions[0].kind).toBe("rollback");
  expect(versions[0].restoresVersion).toBe(v1);
  const rows = await listCanonical(dimId, T);           // adapt
  expect(rows.some((r) => r.label === "Mistake Record")).toBe(false);
  expect(rows.some((r) => r.key === "united_states")).toBe(true);
});
it("rollback preserves staged drafts", async () => { /* stage a draft between v2 and rollback; assert it still lists as mapped after */ });
it("rollback to a snapshotless version 409s", async () => {
  await expect(rollbackToVersion(dimId, T, 999, ADMIN)).rejects.toThrow(/NO_SNAPSHOT|no snapshot/i);
});
```

- [ ] **Step 3: Implement `repo-rollback.ts`** — shape (adapt SQL details to Step 1's findings):

```ts
export async function rollbackToVersion(
  dimId: string, tenantId: string, toVersion: number, userId: string,
) {
  const snap = await getSnapshot(dimId, tenantId, toVersion);
  if (!snap) throw new AppError("NO_SNAPSHOT", `version ${toVersion} has no snapshot`, 409);
  const meta = /* same dimension meta read as commit() — extract or repeat */;
  await pgTx(async (tx) => {
    await tx.run(`DELETE FROM ${cq(meta.mapTable)}`);
    await tx.run(`DELETE FROM ${cq(meta.dimTable)}`);
    const cols = await tx.all<{ column_name: string }>(/* information_schema for dimTable */);
    const colSet = new Set(cols.map((c) => c.column_name));
    for (const rec of snap.records) {
      const keys = Object.keys(rec).filter((k) => colSet.has(k)); // schema drift: intersect
      await tx.run(
        `INSERT INTO ${cq(meta.dimTable)} (${keys.map(qid).join(",")})
         VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        keys.map((k) => rec[k]),
      );
    }
    for (const m of snap.mappings) {
      await tx.run(
        `INSERT INTO ${cq(meta.mapTable)} (raw, ${qid(meta.keyCol)}) VALUES ($1, $2)`,
        [m.raw, m.targetKey],
      );
    }
    /* canonical_version bookkeeping per Step 1.2 findings */
  });
  const res = await commit(dimId, userId, tenantId, [], {
    kind: "rollback", restoresVersion: toVersion,
  });
  /* warehouse full-resync per Step 1.1 findings, mirroring commit()'s
     post-tx warehouse block (audit + synced/failed surface) */
  return { ...res, restoredVersion: toVersion };
}
```

CAREFUL — `commit(..., [], ...)`: Task 3 made an empty scoped list… decide explicitly: calling with `draftKeys: []` must mean "fold no drafts, publish record state" — verify Task 3's validation allows an empty array (zero requested keys, zero missing → passes; `approved`=0; the canonical-changed check sees the restore's changes). If Task 3's implementation rejects empty arrays, fix the semantic THERE (empty array = valid, folds nothing) as part of this task, with a test. The restore must count as canonical change — confirm `changedKeysSince` sees the reinserted rows (per Step 1.2); if the restore is invisible to it, the commit would no-op: in that case pass a flag through opts (`forcePublish: true`) that skips the zero-work early return, with a test.
- [ ] **Step 4: Route** — `POST /api/dimensions/:id/rollback`: read how the tenant role is available in the route context (grep how workspace-delete or Danger-tier routes check admin) and gate on role === "admin" exactly; body `{toVersion: number}` validated as a positive integer.
- [ ] **Step 5: PASS; full suite exit 0. Commit** (`feat(publish): rollback republishes a snapshotted version`).

---

### Task 6: Client store — versions, rollback, reject, scoped commit `[sonnet]`

**Files:**
- Modify: `app/src/store.ts`
- Test: extend an existing store-adjacent test only if one covers these shapes (do not build a fetch-mock harness just for this).

**Interfaces:**
- Produces (exact, later tasks import these):

```ts
export interface VersionInfo { version: number; kind: "publish" | "rollback"; restoresVersion: number | null; publishedBy: string; publishedByName: string; at: string; counts: { records: number; mappings: number }; hasSnapshot: boolean; }
export async function fetchVersions(dimId: string): Promise<VersionInfo[]>
export async function rollbackDim(dimId: string, toVersion: number): Promise<void>   // POSTs, then refreshDim/refreshDrafts/refreshAudit + emit like commit()
export async function rejectDrafts(dimId: string, raws: string[], reason: string): Promise<void>  // POSTs, refreshDrafts, emit
export async function commit(dimId: string, draftKeys?: string[]): Promise<{ committed: number; rowsRecovered: number }>  // body {draftKeys} when provided
```

- Draft interface += `rejectedReason: string | null; rejectedBy: string | null;` and status union += `"rejected"` — mirror the server wire shape (Task 4 extended the drafts serialization; verify field names against it).

- [ ] **Step 1:** Extend `commit` (currently store.ts ~760: POST with no body) to send `{draftKeys}` when provided; add the three new functions following `commit`'s refresh/emit pattern; extend the Draft type and wherever drafts are parsed.
- [ ] **Step 2:** `cd app && bun run typecheck && bun run test` → clean (the Draft union widening may touch switch/status branches in Triage — fix type errors minimally: `rejected` drafts render via Task 8's UI; until then they simply exist in the map). Commit (`feat(store): versions, rollback, reject, draft-scoped commit`).

---

### Task 7: Preview passes displayed draft keys `[sonnet]`

**Files:**
- Modify: `app/src/components/TablePane.tsx` (publish preview onConfirm), `app/src/routes/Triage.tsx` (`approveAndCommitAll` + preview wiring)

**Interfaces:**
- Consumes: `commit(dimId, draftKeys?)` from Task 6; the preview state (`PublishGroup[]`) both surfaces already hold.

- [ ] **Step 1: TablePane** — the PublishPreviewDialog's `onConfirm` currently runs `doPublish()`; thread the displayed keys: `doPublish(publishGroups.flatMap(g => g.drafts.map(d => d.raw)))` — change `doPublish` to `doPublish(draftKeys?: string[])` passing through to `commit(activeId, draftKeys)`. The publish button still opens the preview; nothing else changes.
- [ ] **Step 2: Triage** — `approveAndCommitAll` iterates dimIds calling `commit(id)`; change it to accept the preview groups and call `commit(g.dimId, g.drafts.map(d => d.raw))` per group (the groups are the source of truth for what was shown). The dialog's `onConfirm` passes its CURRENT `preview` state (post-discards). Keep the outcome-collection/toast logic identical.
- [ ] **Step 3:** Stale-key failure path: commit now 400s listing missing keys (Task 3); both surfaces already surface commit errors (danger flash / commitError banner) — verify the 400 message flows there, no new UI. `bun run typecheck && bun run test` clean. Commit (`fix(publish): preview commits exactly the drafts it displayed`).

---

### Task 8: Review inbox — Awaiting review section `[sonnet, biggest UI task]`

**Files:**
- Create: `app/src/components/AwaitingReview.tsx`
- Modify: `app/src/routes/Triage.tsx` (render section at top), `app/src/components/PublishPreviewDialog.tsx` (only if a prop gap emerges — expected none)
- Test: `app/test/awaiting-review.test.tsx`

**Interfaces:**
- Consumes: `useDrafts`, `useDimensions`, `useCanEdit`, current user identity (find how the client knows "me": grep `useMe\|currentUser\|auth/me` in app/src — BootGate holds it; use whatever hook exists), `rejectDrafts` + `commit` (Task 6), `PublishPreviewDialog` + `PublishGroup`, `fetchPublishState`.
- Produces: `<AwaitingReview />` — self-contained; renders null when it has no content.

- [ ] **Step 1: Component behavior spec (build exactly this):**
  - Data: all drafts with `status === "mapped"` whose `user.id !== me.id`. Group: table → author (author `u_system` labeled "System (rescan)"). Each row: source value → target label, provenance (AI · confidence / author name), relative time.
  - Header: `Awaiting review · N` (count of drafts). Collapsed by default when N > 20 per table (show first 20 + "and N more").
  - Selection: per-table select-all checkbox + per-row checkboxes (reuse the codebase's Checkbox component).
  - Actions (visible only when `canEdit`): **Publish selected** → fetch publish state for the affected tables, open PublishPreviewDialog with groups built from the SELECTED drafts only; confirm → `commit(dimId, selectedRaws)` per table (reuse Task 7's outcome pattern — import `summarizeOutcomes` from `../lib/commit-outcomes`). **Reject selected** → inline reason input (required, disabled button until non-empty) → `rejectDrafts(dimId, raws, reason)` per affected table → rows leave the list (status change re-renders via store).
  - Viewers (`!canEdit`): section renders read-only, no checkboxes/buttons.
  - Copy uses the glossary: "Awaiting review", "source value", "record", "Publish selected", "Reject selected", "Reason (required)".
- [ ] **Step 2: Failing tests** (render-level, following `app/test/conflict-banner.test.tsx`'s style — mock the store hooks the way existing route tests do):

```tsx
it("lists only others' staged drafts, grouped by table and author", ...);
it("renders nothing when all staged drafts are mine", ...);
it("reject requires a reason before the button enables", ...);
it("system drafts appear under System (rescan)", ...);
```

- [ ] **Step 3: Implement; wire into Triage** above the dim sections: `<AwaitingReview />`. Run app suite + lint → clean. Commit (`feat(review): awaiting-review inbox with publish/reject`).

---

### Task 9: Rejected drafts — author's view `[sonnet]`

**Files:**
- Modify: `app/src/routes/Triage.tsx` (row status rendering — the `rowStatus` helper and row badges around DimSectionBody), `app/src/components/AwaitingReview.tsx` (none — rejected drafts are NOT in the inbox)
- Test: extend `app/test/` triage-adjacent test if one renders draft badges; else add a focused test for the status mapping helper if one is extractable without ceremony.

- [ ] **Step 1:** In Triage's row rendering, drafts with `status === "rejected"` show a danger-tinted badge `rejected: <reason>` (truncate reason at ~60 chars, full text in title attr). Row actions for a rejected draft: **Re-stage** (calls the existing `saveDraft` path with the same target — which clears rejection fields per Task 4) and the existing discard. The `rowStatus` helper (Triage.tsx ~597) must map `rejected` explicitly (today it would fall through — verify and handle).
- [ ] **Step 2:** Filter interaction: rejected drafts appear under the "Needs review"/new filter (they need the author's attention) — read the `Filter` type handling (`new | all | mapped`) and include rejected rows in `new` and `all`, not `mapped`.
- [ ] **Step 3:** App suite + lint clean. Commit (`feat(review): rejected drafts return to the author with the reason`).

---

### Task 10: Version history + rollback UI `[sonnet]`

**Files:**
- Create: `app/src/components/VersionHistory.tsx`
- Modify: `app/src/components/TablePane.tsx` (a "History" ghost button beside the Publish button opening the panel)
- Test: `app/test/version-history.test.tsx`

**Interfaces:**
- Consumes: `fetchVersions`, `rollbackDim`, `VersionInfo` (Task 6); `ConfirmDialog` (confirmPhrase prop exists); tenant role via `useTenant()`/`can()` (read `app/src/lib/permissions.ts` — add action `"table.rollback"` returning `t.role === "admin"`, following the existing switch style).

- [ ] **Step 1: Component:** a right-side drawer/panel (follow the owner-panel pattern in TablePane if one exists — grep `openOwnerPanel`; else a simple modal like CatalogExplorer) listing versions: `v{n} · {kind === "rollback" ? `restores v${restoresVersion}` : "publish"} · {publishedByName} · {relative time} · {counts.records} records / {counts.mappings} mappings`. For admins, each version except the newest gets a **Roll back to v{n}** button. Non-snapshot versions (pre-feature): the server only returns snapshotted ones — show a footer note "Versions published before version history existed can't be rolled back."
- [ ] **Step 2: Rollback dialog:** ConfirmDialog with `confirmPhrase={"v" + n}`, danger, body: `Publishes a new version v{latest + 1} with v{n}'s content — {counts.records} records, {counts.mappings} mappings. Your staged drafts are kept. Other systems receive a normal publish event marked as a rollback.` Confirm → `rollbackDim(dimId, n)` → panel refreshes; failure surfaces via the danger flash (Task 8-A pattern already in TablePane).
- [ ] **Step 3: Tests:** renders versions; rollback button admin-only; confirm disabled until phrase typed (reuse ConfirmDialog's existing tested behavior — assert the button presence/absence per role instead of re-testing the dialog). App suite + lint clean. Commit (`feat(versions): history panel with admin rollback`).

---

### Task 11: Webhook docs + final verification + judge review `[haiku docs; controller gate]`

**Files:**
- Modify: `app/src/routes/integrations/Webhooks.tsx` and/or the webhook reference component (grep `dimension.committed` in app/src — the payload example component) to document the additive `kind` and `restores_version` fields with one sentence: "Rollbacks arrive as a normal publish with `kind: "rollback"` and the version it restores — downstream systems that ignore these fields stay correct."

- [ ] **Step 1:** Docs edit above; app suite + lint clean; commit (`docs(webhooks): document kind and restores_version`).
- [ ] **Step 2 (controller):** Full bar: app typecheck/test/lint exit 0; server suite exit 0; glossary sweep over changed files clean.
- [ ] **Step 3 (controller):** Whole-branch review (fable) with special attention: rollback transaction boundaries, draft-scoping completeness (every statement in commit() honors the scope — a missed statement silently over-publishes), inbox permission gating, and green honesty. Fix waves per findings.
- [ ] **Step 4 (controller):** Report to `docs/superpowers/plans/2026-07-12-publish-lifecycle.REPORT.md`, commit. **STOP — no merge.** The branch waits for the maintainer.
