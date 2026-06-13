import { AppError } from "./errors.ts";
import { pgContext } from "./pg.ts";
import * as repoMeta from "./repo-meta.ts";
import * as repoCanonical from "./repo-canonical.ts";
import * as repoDrafts from "./repo-drafts.ts";
import * as repoScan from "./repo-scan.ts";
import * as repoAiHint from "./repo-ai-hint.ts";
import * as repoActivity from "./repo-activity.ts";
import type {
  Preferences,
  CanonicalValue,
  OptionDef,
  PaletteName,
  NumberFormat,
  GridLayoutConfig,
  AuditEntry,
  DimensionMeta,
  MappingDimension,
  FieldDef,
  Draft,
  SourceInfo,
  SchemaFacet,
  CatalogTable,
  User,
} from "./repo-shared.ts";

export type Role = "admin" | "editor" | "viewer";
export type Operation = "curate" | "commit" | "manage_adapter";

const ROLE_OPS: Record<Role, Operation[]> = {
  admin: ["curate", "commit", "manage_adapter"],
  editor: ["curate", "commit"],
  viewer: [],
};

/* TenantRepo — request-scoped DB surface.
 *
 * PR2a ships the class with preferences + audit methods. Every method takes the
 * tenant scope from `this.tenantId` and forwards to the underlying repo-*.ts
 * function (which now accepts a `tenantId` parameter — see repo-meta.ts). PR2b
 * expands this to the remaining ~40 repo functions.
 *
 * Mutation methods call `this.assertRole(op)` first. The static permission
 * matrix here mirrors auth.ts.canMutate. */
export class TenantRepo {
  constructor(
    public readonly tenantId: string,
    public readonly role: Role,
    public readonly isSuperAdmin: boolean = false,
  ) {}

  assertRole(op: Operation): void {
    if (this.isSuperAdmin) return; // super-admin bypasses per-tenant role gates
    if (!ROLE_OPS[this.role].includes(op)) {
      throw new AppError("FORBIDDEN", `role '${this.role}' cannot ${op}`, 403);
    }
  }

  private withClearCtx<T>(fn: () => Promise<T>): Promise<T> {
    return pgContext.run({ insideTenantRepo: false }, fn);
  }

  // --- preferences -----------------------------------------------------------
  getPreferences(): Promise<Preferences> {
    return this.withClearCtx(() => repoMeta.getPreferences(this.tenantId));
  }

  setPreferences(p: Preferences): Promise<void> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() => repoMeta.setPreferences(p, this.tenantId));
  }

  // --- audit -----------------------------------------------------------------
  listAudit(limit = 30): Promise<AuditEntry[]> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return this.withClearCtx(() => repoMeta.listAudit(limit, scope));
  }

  appendAudit(
    userId: string,
    action: string,
    detail: string,
    ctx: { tableId?: string; rowKey?: string } = {},
  ): Promise<void> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoMeta.appendAuditAs(userId, action, detail, { ...ctx, tenantId: this.tenantId }),
    );
  }

  // --- canonical (read) ------------------------------------------------------
  listDimensions(): Promise<DimensionMeta[]> {
    return this.withClearCtx(() => repoCanonical.listDimensions(this.tenantId));
  }

  getDimension(id: string): Promise<MappingDimension | null> {
    return this.withClearCtx(() => repoCanonical.getDimension(id, this.tenantId));
  }

  listFields(dimId: string): Promise<FieldDef[]> {
    return this.withClearCtx(() => repoCanonical.listFields(dimId, this.tenantId));
  }

  listVariants(dimId: string, key: string): Promise<string[]> {
    return this.withClearCtx(() => repoCanonical.listVariants(dimId, key, this.tenantId));
  }

  // --- canonical (mutate) ----------------------------------------------------
  addDimension(
    name: string,
    sources: { table: string; column: string }[] = [],
    opts: { keyKind?: "slug" | "external_id"; silent?: boolean } = {},
    userId: string,
  ): Promise<string> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoCanonical.addDimension(name, sources, opts, userId, this.tenantId),
    );
  }

  addCanonical(dimId: string, values: CanonicalValue[]): Promise<void> {
    this.assertRole("commit");
    return this.withClearCtx(() => repoCanonical.addCanonical(dimId, values, this.tenantId));
  }

  addCanonicalOne(
    dimId: string,
    label: string,
    key: string | undefined,
    userId: string,
  ): Promise<void> {
    this.assertRole("commit");
    return this.withClearCtx(() =>
      repoCanonical.addCanonicalOne(dimId, label, key, userId, this.tenantId),
    );
  }

  importCanonical(
    dimId: string,
    rows: repoCanonical.ImportRow[],
    userId: string,
  ): Promise<{ created: number; updated: number; skipped: number }> {
    this.assertRole("commit");
    return this.withClearCtx(() =>
      repoCanonical.importCanonical(dimId, rows, userId, this.tenantId),
    );
  }

  renameCanonical(
    dimId: string,
    key: string,
    label: string,
    userId: string,
    expectedVersion: number,
  ): Promise<{ version: number }> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoCanonical.renameCanonical(dimId, key, label, userId, expectedVersion, this.tenantId),
    );
  }

  mergeCanonical(
    dimId: string,
    survivor: string,
    losers: string[],
    userId: string,
    expectedVersions: Record<string, number>,
  ): Promise<number> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoCanonical.mergeCanonical(
        dimId,
        survivor,
        losers,
        userId,
        expectedVersions,
        this.tenantId,
      ),
    );
  }

  retireCanonical(
    dimId: string,
    key: string,
    userId: string,
    expectedVersion: number,
  ): Promise<{ ok: boolean; variants: number }> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoCanonical.retireCanonical(dimId, key, userId, expectedVersion, this.tenantId),
    );
  }

  updateField(
    dimId: string,
    field: string,
    updates: { description?: string | null; fieldConfig?: string | null },
    userId: string,
  ): Promise<void> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoCanonical.updateField(dimId, field, updates, userId, this.tenantId),
    );
  }

  addField(
    dimId: string,
    label: string,
    type: string | undefined,
    options: OptionDef[] | undefined,
    opts: {
      silent?: boolean;
      numberFormat?: NumberFormat;
      ratingMax?: number;
      referencedDimId?: string;
      displayFields?: string[];
    } = {},
    userId: string,
  ): Promise<{ field: string } | null> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoCanonical.addField(dimId, label, type, options, opts, userId, this.tenantId),
    );
  }

  renameColumn(dimId: string, field: string, newLabel: string, userId: string): Promise<void> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoCanonical.renameColumn(dimId, field, newLabel, userId, this.tenantId),
    );
  }

  changeColumnType(
    dimId: string,
    field: string,
    opts: {
      newType: string;
      options?: OptionDef[];
      numberFormat?: NumberFormat;
      ratingMax?: number;
      coerceInvalidToNull: boolean;
      userId: string;
    },
  ): Promise<{ ok: boolean; invalidCount?: number; options?: OptionDef[] }> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoCanonical.changeColumnType(dimId, field, opts, this.tenantId),
    );
  }

  deleteColumn(dimId: string, field: string, userId: string): Promise<{ ok: boolean }> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() => repoCanonical.deleteColumn(dimId, field, userId, this.tenantId));
  }

  addColumnOption(
    dimId: string,
    field: string,
    label: string,
    color: PaletteName | null = null,
    opts: { silent?: boolean } = {},
    userId: string,
  ): Promise<{ options: OptionDef[] } | null> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoCanonical.addColumnOption(dimId, field, label, color, opts, userId, this.tenantId),
    );
  }

  setFieldValue(dimId: string, key: string, field: string, value: string | null): Promise<void> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoCanonical.setFieldValue(dimId, key, field, value, this.tenantId),
    );
  }

  // --- drafts ----------------------------------------------------------------
  listDrafts(dimId: string): Promise<Draft[]> {
    return this.withClearCtx(() => repoDrafts.listDrafts(dimId, this.tenantId));
  }

  saveDraft(
    dimId: string,
    raw: string,
    status: "mapped" | "skipped",
    targetLabel: string | null,
    targetKey: string | null,
    userId: string,
  ): Promise<void> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoDrafts.saveDraft(dimId, raw, status, targetLabel, targetKey, userId, this.tenantId),
    );
  }

  discardDraft(dimId: string, raw: string, userId: string): Promise<void> {
    this.assertRole("curate");
    return this.withClearCtx(() => repoDrafts.discardDraft(dimId, raw, userId, this.tenantId));
  }

  commit(
    dimId: string,
    userId: string,
  ): Promise<{
    committed: number;
    rowsRecovered: number;
    warehouseSynced: "n/a" | "synced" | "failed";
  }> {
    this.assertRole("commit");
    return this.withClearCtx(() => repoDrafts.commit(dimId, userId, this.tenantId));
  }

  // --- scan ------------------------------------------------------------------
  listSources(opts: { q?: string; schema?: string; status?: string }): Promise<SourceInfo[]> {
    return this.withClearCtx(() => repoScan.listSources({ ...opts, tenantId: this.tenantId }));
  }

  sourceFacets(): Promise<SchemaFacet[]> {
    return this.withClearCtx(() => repoScan.sourceFacets(this.tenantId));
  }

  scanSources(): Promise<number> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() => repoScan.scanSources(this.tenantId));
  }

  dimensionsWithWiredSources(): Promise<string[]> {
    return this.withClearCtx(() => repoScan.dimensionsWithWiredSources(this.tenantId));
  }

  autoStageExactMatches(dimId: string): Promise<number> {
    this.assertRole("curate");
    return this.withClearCtx(() => repoScan.autoStageExactMatches(dimId, this.tenantId));
  }

  addSource(
    dimId: string,
    table: string,
    column: string,
    opts: { silent?: boolean } = {},
  ): Promise<void> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() => repoScan.addSource(dimId, table, column, this.tenantId, opts));
  }

  topUnmapped(
    dimId: string,
    table: string,
    column: string,
    limit = 5,
  ): Promise<repoScan.UnmappedSample[]> {
    return this.withClearCtx(() =>
      repoScan.topUnmapped(dimId, table, column, limit, this.tenantId),
    );
  }

  anyScanDue(now: Date = new Date()): Promise<boolean> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return this.withClearCtx(() => repoScan.anyScanDue(now, scope));
  }

  scanStatus(): Promise<repoScan.ScanStatusResult> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return this.withClearCtx(() => repoScan.scanStatus(scope));
  }

  searchCatalog(opts: { q?: string; schema?: string; limit?: number; offset?: number }): Promise<{
    rows: CatalogTable[];
    total: number;
    schemas: { schema: string; tables: number }[];
  }> {
    return this.withClearCtx(() => repoScan.searchCatalog({ ...opts, tenantId: this.tenantId }));
  }

  deriveCanonical(
    dimId: string,
    table: string,
    column: string,
    nameColumn: string | undefined,
    opts: { silent?: boolean } = {},
    userId: string,
  ): Promise<{ derived: number }> {
    this.assertRole("commit");
    return this.withClearCtx(() =>
      repoScan.deriveCanonical(dimId, table, column, nameColumn, opts, userId, this.tenantId),
    );
  }

  // --- ai-hint ---------------------------------------------------------------
  getAiHint(
    dimId: string,
    raw: string,
    canonicalLabels: string[],
    dim: { label: string },
  ): Promise<repoAiHint.AiHintResult> {
    return this.withClearCtx(() =>
      repoAiHint.getAiHint(dimId, raw, canonicalLabels, dim, this.tenantId),
    );
  }

  // --- activity --------------------------------------------------------------
  getRowActivitySince(tableId: string, since: Date): Promise<repoActivity.RowActivityEntry[]> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return this.withClearCtx(() => repoActivity.getRowActivitySince(tableId, since, scope));
  }

  // --- user-scoped (no tenant) ----------------------------------------------
  listUsers(): Promise<User[]> {
    return this.withClearCtx(() => repoMeta.listUsers());
  }

  getGridLayout(userId: string, dimId: string): Promise<GridLayoutConfig> {
    return this.withClearCtx(() => repoMeta.getGridLayout(userId, dimId));
  }

  setGridLayout(userId: string, dimId: string, config: GridLayoutConfig): Promise<void> {
    return this.withClearCtx(() => repoMeta.setGridLayout(userId, dimId, config));
  }
}
