/* repo.ts — barrel re-export of the un-tenanted free functions.
 *
 * Post-MT-PR2b: the public surface for HTTP routes is TenantRepo
 * (server/src/tenant-repo.ts). server.ts uses req.repo.* exclusively.
 *
 * This barrel is kept for:
 *   - tests that exercise individual repo functions
 *   - utility scripts (seed.ts, seed-rich.ts, verify-*.ts) that run outside
 *     the HTTP request lifecycle and pass tenantId="default" explicitly
 *   - tables.ts (DuckDB / warehouse interface) — system-principal access
 *
 * New code MUST NOT import this barrel from server.ts (ESLint guard in Task 16).
 *
 * Module breakdown:
 *   - repo-scan.ts      (warehouse scanning + sources registry)
 *   - repo-canonical.ts (dimensions + canonical CRUD + fields)
 *   - repo-drafts.ts    (drafts + commit)
 *   - repo-meta.ts      (users, audit, preferences, grid layout)
 *   - repo-shared.ts    (cross-domain types and helpers)
 *   - repo-ai-hint.ts   (AI mapping cache)
 *   - repo-activity.ts  (per-row activity feed)
 */
export * from "./repo-scan.ts";
export * from "./repo-canonical.ts";
export * from "./repo-drafts.ts";
export * from "./repo-meta.ts";
export * from "./repo-shared.ts";
export * from "./repo-ai-hint.ts";
export * from "./repo-activity.ts";
