/* repo.ts — barrel re-export. The actual implementations live in:
 *   - repo-scan.ts     (warehouse scanning + sources registry)
 *   - repo-canonical.ts (dimensions + canonical CRUD + fields)
 *   - repo-drafts.ts   (drafts + commit)
 *   - repo-meta.ts     (users, audit, preferences, grid layout)
 *   - repo-shared.ts   (cross-domain types and helpers)
 *
 * Importers continue to use `import * as repo from "./repo.ts"` unchanged.
 */
export * from "./repo-scan.ts";
export * from "./repo-canonical.ts";
export * from "./repo-drafts.ts";
export * from "./repo-meta.ts";
export * from "./repo-shared.ts";
export * from "./repo-ai-hint.ts";
export * from "./repo-activity.ts";
