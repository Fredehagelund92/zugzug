import { AppError } from "./errors.ts";
import { pgContext } from "./pg.ts";
import * as repoMeta from "./repo-meta.ts";
import * as repoRecord from "./repo-record.ts";
import * as repoDrafts from "./repo-drafts.ts";
import * as repoScan from "./repo-scan.ts";
import * as repoSourceScan from "./repo-source-scan.ts";
import * as repoAiHint from "./repo-ai-hint.ts";
import * as repoActivity from "./repo-activity.ts";
import * as repoVersions from "./repo-versions.ts";
import type {
  Preferences,
  RecordValue,
  OptionDef,
  PaletteName,
  NumberFormat,
  GridLayoutConfig,
  AuditEntry,
  RefTableMeta,
  MappingRefTable,
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
    // Drop the TenantRepo guard but preserve the parent tx — otherwise nested
    // pg.* calls grab a second pool conn while pgTxScoped is still holding the
    // first, deadlocking the pool under parallel tenant requests.
    const parent = pgContext.getStore();
    return pgContext.run({ insideTenantRepo: false, tx: parent?.tx }, fn);
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
  listAudit(limit = 30, filter: repoMeta.AuditFilter = {}): Promise<AuditEntry[]> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return this.withClearCtx(() => repoMeta.listAudit(limit, scope, filter));
  }

  listAuditActions(): Promise<string[]> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return this.withClearCtx(() => repoMeta.listAuditActions(scope));
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

  // --- record (read) ------------------------------------------------------
  listRefTables(): Promise<RefTableMeta[]> {
    return this.withClearCtx(() => repoRecord.listRefTables(this.tenantId));
  }

  getRefTable(
    id: string,
    opts?: { scalars?: repoSourceScan.SourceScanScalars[] },
  ): Promise<MappingRefTable | null> {
    return this.withClearCtx(() => repoRecord.getRefTable(id, this.tenantId, opts));
  }

  /** Lightweight refTable lookup — id + label only. Used by AI suggest flow
   *  where the full record materialization is overkill. */
  getRefTableBasic(id: string): Promise<{ id: string; label: string } | null> {
    return this.withClearCtx(() => repoRecord.getRefTableBasic(id, this.tenantId));
  }

  /** Sample of existing record labels for a refTable (default limit 30).
   *  Used to build AI context and workbench previews. */
  getRecordValues(id: string, opts: { limit?: number } = {}): Promise<string[]> {
    return this.withClearCtx(() => repoRecord.getRecordValues(id, this.tenantId, opts));
  }

  listFields(refTableId: string): Promise<FieldDef[]> {
    return this.withClearCtx(() => repoRecord.listFields(refTableId, this.tenantId));
  }

  listVariants(refTableId: string, key: string): Promise<string[]> {
    return this.withClearCtx(() => repoRecord.listVariants(refTableId, key, this.tenantId));
  }

  // --- record (mutate) ----------------------------------------------------
  addRefTable(
    name: string,
    sources: repoRecord.QualifiedSource[] = [],
    opts: { keyKind?: "slug" | "external_id"; silent?: boolean } = {},
    userId: string,
  ): Promise<string> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoRecord.addRefTable(name, sources, opts, userId, this.tenantId),
    );
  }

  deleteRefTable(refTableId: string, userId: string): Promise<boolean> {
    this.assertRole("curate");
    return this.withClearCtx(() => repoRecord.deleteRefTable(refTableId, userId, this.tenantId));
  }

  updateRefTableMeta(
    refTableId: string,
    patch: repoRecord.UpdateRefTableMetaInput,
    userId: string,
  ): Promise<{
    id: string;
    orderingMode: string;
    description: string | null;
    color: string | null;
  }> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoRecord.updateRefTableMeta(refTableId, patch, userId, this.tenantId),
    );
  }

  addRecord(refTableId: string, values: RecordValue[]): Promise<void> {
    this.assertRole("commit");
    return this.withClearCtx(() => repoRecord.addRecord(refTableId, values, this.tenantId));
  }

  addRecordOne(
    refTableId: string,
    label: string,
    key: string | undefined,
    userId: string,
  ): Promise<void> {
    this.assertRole("commit");
    return this.withClearCtx(() =>
      repoRecord.addRecordOne(refTableId, label, key, userId, this.tenantId),
    );
  }

  addRecordOneAt(
    refTableId: string,
    label: string,
    key: string | undefined,
    insertAt: { anchor: string; direction: "above" | "below" },
    userId: string,
  ): Promise<void> {
    this.assertRole("commit");
    return this.withClearCtx(() =>
      repoRecord.addRecordOneAt(refTableId, label, key, insertAt, userId, this.tenantId),
    );
  }

  reorderRecordRow(
    refTableId: string,
    rowKey: string,
    before: string | null | undefined,
    after: string | null | undefined,
    userId: string,
  ): Promise<{ position: string }> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoRecord.reorderRecordRow(refTableId, rowKey, before, after, userId, this.tenantId),
    );
  }

  importRecord(
    refTableId: string,
    rows: repoRecord.ImportRow[],
    userId: string,
  ): Promise<{ created: number; updated: number; skipped: number }> {
    this.assertRole("commit");
    return this.withClearCtx(() =>
      repoRecord.importRecord(refTableId, rows, userId, this.tenantId),
    );
  }

  renameRecord(
    refTableId: string,
    key: string,
    label: string,
    userId: string,
    expectedVersion: number,
  ): Promise<{ version: number }> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoRecord.renameRecord(refTableId, key, label, userId, expectedVersion, this.tenantId),
    );
  }

  mergeRecord(
    refTableId: string,
    survivor: string,
    losers: string[],
    userId: string,
    expectedVersions: Record<string, number>,
  ): Promise<number> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoRecord.mergeRecord(refTableId, survivor, losers, userId, expectedVersions, this.tenantId),
    );
  }

  retireRecord(
    refTableId: string,
    key: string,
    userId: string,
    expectedVersion: number,
  ): Promise<{ ok: boolean; variants: number }> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoRecord.retireRecord(refTableId, key, userId, expectedVersion, this.tenantId),
    );
  }

  updateField(
    refTableId: string,
    field: string,
    updates: { description?: string | null; fieldConfig?: string | null },
    userId: string,
  ): Promise<void> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoRecord.updateField(refTableId, field, updates, userId, this.tenantId),
    );
  }

  addField(
    refTableId: string,
    label: string,
    type: string | undefined,
    options: OptionDef[] | undefined,
    opts: {
      silent?: boolean;
      numberFormat?: NumberFormat;
      ratingMax?: number;
      referencedRefTableId?: string;
      displayFields?: string[];
      required?: boolean;
      validation?: { unique?: boolean; min?: number | string | null; max?: number | string | null };
      formula?: {
        expr: string;
        resultType: "text" | "number" | "boolean";
        numberFormat?: NumberFormat;
      };
    } = {},
    userId: string,
  ): Promise<{ field: string } | null> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoRecord.addField(refTableId, label, type, options, opts, userId, this.tenantId),
    );
  }

  validateTableFormula(
    refTableId: string,
    expr: string,
    _userId: string,
  ): Promise<{ ok: boolean; error?: string; warning?: string; sample?: string | null }> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoRecord.validateTableFormula(refTableId, expr, this.tenantId),
    );
  }

  renameColumn(refTableId: string, field: string, newLabel: string, userId: string): Promise<void> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoRecord.renameColumn(refTableId, field, newLabel, userId, this.tenantId),
    );
  }

  changeColumnType(
    refTableId: string,
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
      repoRecord.changeColumnType(refTableId, field, opts, this.tenantId),
    );
  }

  deleteColumn(refTableId: string, field: string, userId: string): Promise<{ ok: boolean }> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoRecord.deleteColumn(refTableId, field, userId, this.tenantId),
    );
  }

  addColumnOption(
    refTableId: string,
    field: string,
    label: string,
    color: PaletteName | null = null,
    opts: { silent?: boolean } = {},
    userId: string,
  ): Promise<{ options: OptionDef[] } | null> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoRecord.addColumnOption(refTableId, field, label, color, opts, userId, this.tenantId),
    );
  }

  setFieldValue(
    refTableId: string,
    key: string,
    field: string,
    value: string | null,
    userId: string,
  ): Promise<void> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoRecord.setFieldValue(refTableId, key, field, value, userId, this.tenantId),
    );
  }

  // --- drafts ----------------------------------------------------------------
  listDrafts(refTableId: string): Promise<Draft[]> {
    return this.withClearCtx(() => repoDrafts.listDrafts(refTableId, this.tenantId));
  }

  listAllDraftsPage(opts?: {
    cursor?: string | null;
    limit?: number;
  }): Promise<{ drafts: Draft[]; nextCursor: string | null }> {
    return this.withClearCtx(() => repoDrafts.listAllDraftsPage(this.tenantId, opts));
  }

  saveDraft(
    refTableId: string,
    raw: string,
    status: "mapped" | "skipped",
    targetLabel: string | null,
    targetKey: string | null,
    userId: string,
  ): Promise<void> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoDrafts.saveDraft(refTableId, raw, status, targetLabel, targetKey, userId, this.tenantId),
    );
  }

  /** AI-aware draft insert that captures provenance metadata (`source`,
   *  `confidence`, `reasoning`). Returns the persisted row. */
  createDraft(
    input: repoDrafts.CreateDraftInput,
    userId: string,
  ): Promise<
    Draft & {
      source: "user" | "ai";
      confidence: "high" | "medium" | "low" | null;
      reasoning: string | null;
    }
  > {
    this.assertRole("curate");
    return this.withClearCtx(() => repoDrafts.createDraft(input, userId, this.tenantId));
  }

  discardDraft(refTableId: string, raw: string, userId: string): Promise<void> {
    this.assertRole("curate");
    return this.withClearCtx(() => repoDrafts.discardDraft(refTableId, raw, userId, this.tenantId));
  }

  rejectDrafts(
    refTableId: string,
    raws: string[],
    reason: string,
    reviewerId: string,
  ): Promise<{ rejected: number }> {
    this.assertRole("curate");
    return this.withClearCtx(() =>
      repoDrafts.rejectDrafts(refTableId, this.tenantId, raws, reason, reviewerId),
    );
  }

  commit(
    refTableId: string,
    userId: string,
    draftKeys?: string[],
    opts?: { onlyAuthor?: string },
  ): Promise<{
    committed: number;
    rowsRecovered: number;
    warehouseSynced: "n/a" | "synced" | "synced-additive" | "failed";
  }> {
    this.assertRole("commit");
    return this.withClearCtx(() =>
      repoDrafts.commit(refTableId, userId, this.tenantId, draftKeys, opts),
    );
  }

  getPublishState(refTableId: string): Promise<repoDrafts.PublishState> {
    return this.withClearCtx(() => repoDrafts.getPublishState(refTableId, this.tenantId));
  }

  revertToPublished(refTableId: string, userId: string): Promise<{ reverted: number }> {
    this.assertRole("curate");
    return this.withClearCtx(() => repoDrafts.revertToPublished(refTableId, userId, this.tenantId));
  }

  listVersions(refTableId: string): Promise<repoVersions.VersionInfo[]> {
    return this.withClearCtx(() => repoVersions.listVersions(refTableId, this.tenantId));
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

  scanOneDim(refTableId: string): Promise<void> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() => repoScan.scanOneDim(refTableId, this.tenantId));
  }

  refTablesWithWiredSources(): Promise<string[]> {
    return this.withClearCtx(() => repoScan.refTablesWithWiredSources(this.tenantId));
  }

  autoStageExactMatches(refTableId: string): Promise<{ matched: number; unmatched: number }> {
    this.assertRole("curate");
    return this.withClearCtx(() => repoScan.autoStageExactMatches(refTableId, this.tenantId));
  }

  addSource(
    refTableId: string,
    table: string,
    column: string,
    opts: { silent?: boolean } = {},
  ): Promise<void> {
    this.assertRole("manage_adapter");
    return this.withClearCtx(() =>
      repoScan.addSource(refTableId, table, column, this.tenantId, opts),
    );
  }

  topUnmapped(
    refTableId: string,
    table: string,
    column: string,
    limit = 5,
  ): Promise<repoScan.UnmappedSample[]> {
    return this.withClearCtx(() =>
      repoScan.topUnmapped(refTableId, table, column, limit, this.tenantId),
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

  getSourceScanScalars(): Promise<repoSourceScan.SourceScanScalars[]> {
    return this.withClearCtx(() => repoSourceScan.getSourceScanScalars(this.tenantId));
  }

  getSourceScanValuesPage(
    refTableId: string,
    opts: repoSourceScan.PageOpts,
  ): Promise<repoSourceScan.ValuesPage> {
    return this.withClearCtx(() =>
      repoSourceScan.getSourceScanValuesPage(this.tenantId, refTableId, opts),
    );
  }

  getRefTableClusters(
    refTableId: string,
    opts: repoSourceScan.ClusterFeedOpts,
  ): Promise<repoSourceScan.RefTableClusterFeed> {
    return this.withClearCtx(() =>
      repoSourceScan.getRefTableClusters(this.tenantId, refTableId, opts),
    );
  }

  deriveRecord(
    refTableId: string,
    table: string,
    column: string,
    nameColumn: string | undefined,
    opts: { silent?: boolean; force?: boolean } = {},
    userId: string,
  ): Promise<{ derived: number; mode: "seed" | "connect"; matched: number; unmatched: number }> {
    this.assertRole("commit");
    return this.withClearCtx(() =>
      repoScan.deriveRecord(refTableId, table, column, nameColumn, opts, userId, this.tenantId),
    );
  }

  // --- ai-hint ---------------------------------------------------------------
  getAiHint(
    refTableId: string,
    raw: string,
    recordLabels: string[],
    refTable: { label: string },
  ): Promise<repoAiHint.AiHintResult> {
    return this.withClearCtx(() =>
      repoAiHint.getAiHint(refTableId, raw, recordLabels, refTable, this.tenantId),
    );
  }

  // --- activity --------------------------------------------------------------
  getRowActivitySince(tableId: string, since: Date): Promise<repoActivity.RowActivityEntry[]> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return this.withClearCtx(() => repoActivity.getRowActivitySince(tableId, since, scope));
  }

  listRecordHistory(
    tableId: string,
    rowKey: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<repoActivity.RecordHistoryPage> {
    const scope = this.isSuperAdmin && this.tenantId === "*" ? "*" : this.tenantId;
    return this.withClearCtx(() => repoActivity.listRecordHistory(tableId, rowKey, scope, opts));
  }

  // --- users (workspace-scoped) ---------------------------------------------
  listUsers(): Promise<User[]> {
    return this.withClearCtx(() => repoMeta.listUsers(this.tenantId));
  }

  // --- user-scoped (no tenant) ----------------------------------------------
  getGridLayout(userId: string, refTableId: string): Promise<GridLayoutConfig> {
    return this.withClearCtx(() => repoMeta.getGridLayout(userId, refTableId));
  }

  setGridLayout(userId: string, refTableId: string, config: GridLayoutConfig): Promise<void> {
    return this.withClearCtx(() => repoMeta.setGridLayout(userId, refTableId, config));
  }
}
