import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useNavLinks } from "../../lib/use-tenant-navigate";
import { Badge } from "../Badge";
import { Button } from "../Button";
import { Checkbox } from "../Checkbox";
import { ComboSelect } from "../ComboSelect";
import { DataGrid, useUndoStack } from "../datagrid";
import { IconArrowRight, IconCheck, IconX } from "../Icons";
import { cx } from "../../lib/cx";
import { useEngineerMode } from "../../lib/engineer-mode";
import type { MappingDimension, MappingValue, SourceOccurrence } from "../../data";
import { matchColumns } from "./match-columns";
import {
  commit,
  currentUser,
  discardDraft,
  dkey,
  listDrafts,
  saveDraft,
  useDrafts,
  useCanEdit,
} from "../../store";
import { GetSuggestionButton } from "../GetSuggestionButton";
import { toast } from "../Toast";
import { useDimValuesPage, type ScanValueRow } from "../../lib/use-dim-values-page";
import { useAiHint } from "../../lib/use-ai-hint";

/* MatchModeBody — per-tab single-dim Match workbench. Lazy-fetches a paginated
   page of scan_value rows via useDimValuesPage; the eager `dim.values` array
   is gone now. AI suggestions are fetched per focused cursor row (`useAiHint`);
   the bulk-row "automap" affordance is dropped because it required eager
   per-row suggestions that aren't in the paged payload. */

type RStatus = "mapped" | "new" | "skipped" | "rejected";
type ValueState = Record<string, { target: string | null; status: RStatus; rejectedReason?: string | null }>;
type Filter = "new" | "all" | "mapped";

// Escape a string for use inside a double-quoted CSS attribute selector.
const attrEsc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Brief accent-wash on a row after the user acted on it.
function flashRow(selector: string): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.classList.remove("zz-row-flash");
    void el.offsetWidth;
    el.classList.add("zz-row-flash");
    window.setTimeout(() => el.classList.remove("zz-row-flash"), 1700);
  });
}

function useSessionState<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (window.sessionStorage.getItem(key) as T) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      window.sessionStorage.setItem(key, next);
    } catch {
      /* ignore quota / disabled storage */
    }
  };
  return [v, set];
}

interface MatchModeBodyProps {
  /** Fully resolved dimension. Parent guarantees non-null. */
  dim: MappingDimension;
  /** Whether this pane is currently the active tab. Only the active pane
   *  consumes the ?value= deep link at mount. */
  isActive: boolean;
}

// Adapt a paged ScanValueRow into the shape `matchColumns` expects — the
// existing DataGrid + column defs are typed on MappingValue. Suggestion /
// confidence default to empty (no per-row AI in the paged payload).
function adaptRow(r: ScanValueRow): MappingValue {
  const sources: SourceOccurrence[] = r.occurrences.map((o) => ({
    table: o.table,
    column: o.column,
    rows: o.rows,
  }));
  return {
    value: r.raw,
    status: r.isMapped ? "mapped" : "new",
    current: r.mappedLabel,
    suggestion: null,
    confidence: 0,
    sources,
  };
}

export function MatchModeBody({ dim, isActive }: MatchModeBodyProps) {
  const allDrafts = useDrafts();
  const { engineer } = useEngineerMode();
  const canEdit = useCanEdit();
  const [searchParams] = useSearchParams();
  const undo = useUndoStack();
  const nav = useNavLinks();

  const [sel, setSel] = useState<string[]>([]);
  const [filter, setFilter] = useSessionState<Filter>("zz:mapping:filter", "new");
  const [searchText, setSearchText] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [review, setReview] = useState(false);
  const [flash, setFlash] = useState<{ n: number } | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [cursorRaw, setCursorRaw] = useState<string | null>(null);

  // Paged fetch — re-keys on (dim.id, filter, q).
  const valuesPage = useDimValuesPage({
    dimId: dim.id,
    filter,
    q: searchText || undefined,
  });

  // Focus-refetch: when the user returns to the tab, reload so other curators'
  // edits show up.
  useEffect(() => {
    const onFocus = () => valuesPage.refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [valuesPage]);

  // AI hint for the cursor row only — mirrors Triage. Powers the `A` shortcut
  // (accept suggestion) when no per-row suggestion is available eagerly.
  const aiHint = useAiHint(dim.id, cursorRaw ?? "", cursorRaw !== null);

  // Per-page lookup. Returns null when the row isn't in the loaded window —
  // callers must handle that (e.g. accept on a not-loaded row is a no-op).
  const byVal = (v: string): ScanValueRow | null =>
    valuesPage.items.find((r) => r.raw === v) ?? null;

  const keyFor = (label: string) =>
    dim.canonical.find((c) => c.label === label)?.key ??
    label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const options = useMemo(() => dim.canonical.map((c) => c.label), [dim.canonical]);
  const external = dim.keyKind === "external_id";

  // Committed truth (from the loaded page) overlaid with each value's pending
  // draft. Only covers the loaded window — that's all the grid renders anyway.
  const state: ValueState = useMemo(
    () =>
      Object.fromEntries(
        valuesPage.items.map((v) => {
          const d = allDrafts[dkey(dim.id, v.raw)];
          return [
            v.raw,
            d
              ? { target: d.targetLabel, status: d.status, rejectedReason: d.rejectedReason }
              : { target: v.mappedLabel, status: v.isMapped ? "mapped" : "new" },
          ];
        }),
      ),
    [valuesPage.items, allDrafts, dim.id],
  );

  // Counts come from the server-side scalars (queue size for the whole dim,
  // independent of the loaded page or active search). With search active,
  // chip counts still reflect the underlying dim — they're the queue size,
  // not the search view.
  const counts = {
    all: dim.counts.totalDistinct,
    new: dim.counts.newCount,
    mapped: dim.counts.mappedCount,
  };

  const stageMap = (v: string, label: string) => {
    if (state[v]?.status === "rejected") return;
    const prev = allDrafts[dkey(dim.id, v)];
    undo.push({
      label: `match "${v}" → ${label}`,
      surface: "Match",
      apply: () => saveDraft(dim.id, v, "mapped", label, keyFor(label)),
      inverse: () =>
        prev && prev.status !== "rejected"
          ? saveDraft(dim.id, v, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(dim.id, v),
    });
    return saveDraft(dim.id, v, "mapped", label, keyFor(label));
  };
  // Accept relies on the per-cursor AI hint — same pattern as Triage's
  // acceptCross. No per-row suggestion in the paged payload, so accepting a
  // non-cursor row (e.g. via bulk Accept) is a no-op + toast.
  const accept = (v: string) => {
    const suggestion = cursorRaw === v ? aiHint.hint?.suggestion : null;
    if (!suggestion) {
      toast(`No suggestion to accept for "${v}".`, "error");
      return;
    }
    void stageMap(v, suggestion);
    flashRow(`[data-row="${attrEsc(v)}"]`);
  };
  const pick = (v: string, t: string) => {
    void stageMap(v, t);
    flashRow(`[data-row="${attrEsc(v)}"]`);
  };
  // Skip without the row flash — bulkApply uses this so a skipped selection
  // doesn't fire N flash animations.
  const skipPersist = (v: string) => {
    if (state[v]?.status === "rejected") return;
    const prev = allDrafts[dkey(dim.id, v)];
    undo.push({
      label: `skip "${v}"`,
      surface: "Match",
      apply: () => saveDraft(dim.id, v, "skipped", null, null),
      inverse: () =>
        prev && prev.status !== "rejected"
          ? saveDraft(dim.id, v, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(dim.id, v),
    });
    return saveDraft(dim.id, v, "skipped", null, null);
  };
  const skip = (v: string) => {
    void skipPersist(v);
    flashRow(`[data-row="${attrEsc(v)}"]`);
  };
  const reset = (v: string) => {
    const prev = allDrafts[dkey(dim.id, v)];
    if (!prev) return;
    undo.push({
      label: `reset "${v}"`,
      surface: "Match",
      apply: () => discardDraft(dim.id, v),
      // Rejected drafts cannot be re-saved via saveDraft; discard is the safe fallback.
      inverse: () =>
        prev.status !== "rejected"
          ? saveDraft(dim.id, v, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(dim.id, v),
    });
    return discardDraft(dim.id, v);
  };
  const bulkApply = async (label: string, fn: (v: string) => unknown) => {
    if (sel.length === 0) return;
    const values = [...sel];
    setSel([]);
    undo.beginTransaction(label);
    try {
      await Promise.all(values.map((v) => Promise.resolve(fn(v))));
    } finally {
      undo.endTransaction();
    }
  };

  // Drop a single staged draft from the review panel. Undo-able.
  const discardStaged = (raw: string) => {
    const prev = allDrafts[dkey(dim.id, raw)];
    if (!prev) return;
    undo.push({
      label: `discard "${raw}"`,
      surface: "Match",
      apply: () => discardDraft(dim.id, raw),
      // Rejected drafts cannot be re-saved via saveDraft; discard is the safe fallback.
      inverse: () =>
        prev.status !== "rejected"
          ? saveDraft(dim.id, raw, prev.status, prev.targetLabel, prev.targetKey)
          : discardDraft(dim.id, raw),
    });
    void discardDraft(dim.id, raw);
  };

  // Visible rows — adapted from the paged ScanValueRow into the shape
  // matchColumns/DataGrid expects. Server filter already narrows to
  // new/all/mapped; the loaded page is the visible set.
  const visible = useMemo(() => valuesPage.items.map(adaptRow), [valuesPage.items]);
  const visIds = visible.map((v) => v.value);
  const allSel = visIds.length > 0 && visIds.every((id) => sel.includes(id));
  const headState: "on" | "off" | "mixed" = allSel ? "on" : sel.length ? "mixed" : "off";

  // Columns for the DataGrid. Suggestion/confidence cols still render but are
  // always null/0 — the paged payload has no per-row AI data.
  const columns = useMemo(
    () =>
      matchColumns({
        dimensionLabel: dim.dimension,
        options,
        state,
        external,
        canEdit,
        onToggleDrill: (v) => setOpen((cur) => (cur === v ? null : v)),
        openDrill: open,
      }),
    [dim.dimension, options, state, external, canEdit, open],
  );

  // ── Default mapping target (?target=) ────────────────────────────────────
  // A deep link may supply ?target=<recordKey> (e.g. from Task 5's URL writer).
  // On mount, resolve the key to its canonical record, show an affordance, and
  // default the filter to "new". Consumed once (active pane only); stale keys
  // are silently ignored.
  const initialTargetRef = useRef<string | null>(isActive ? searchParams.get("target") : null);
  const [defaultTarget, setDefaultTarget] = useState<{ key: string; label: string } | null>(null);
  useEffect(() => {
    const key = initialTargetRef.current;
    if (!key) return;
    initialTargetRef.current = null;
    const rec = dim.canonical.find((c) => c.key === key);
    if (!rec) return; // stale key → ignore, no crash
    setDefaultTarget({ key: rec.key, label: rec.label });
    setFilter("new");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim.id, dim.canonical, setFilter]);

  // ── Deep-linking ─────────────────────────────────────────────────────────
  // URL ?value=… points at a specific row. Without an eager values list we
  // can't pre-validate existence; best-effort: when the row appears in the
  // currently-loaded page, scroll + flash. If filtered out, widen to "all".
  const initialUrlValueRef = useRef<string | null>(isActive ? searchParams.get("value") : null);
  useEffect(() => {
    const pinned = initialUrlValueRef.current;
    if (!pinned) return;
    if (valuesPage.loading) return;
    const inPage = valuesPage.items.some((r) => r.raw === pinned);
    if (!inPage) {
      // Widen the lens once in case the value exists but is filtered out.
      if (filter !== "all") {
        setFilter("all");
        return;
      }
      // Give up — value not in loaded window.
      initialUrlValueRef.current = null;
      return;
    }
    initialUrlValueRef.current = null;
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-row="${attrEsc(pinned)}"]`)
        ?.scrollIntoView({ block: "center" });
    });
    flashRow(`[data-row="${attrEsc(pinned)}"]`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim.id, valuesPage.items, valuesPage.loading, filter]);

  // staged drafts awaiting commit — the review set. Without eager values we
  // can't filter against current warehouse state (that drop-no-op semantics
  // landed in Triage too); the server reconciles on commit.
  const stagedDrafts = useMemo(
    () => listDrafts(dim.id).filter((d) => d.status === "mapped"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dim.id, allDrafts],
  );
  const staged = stagedDrafts.map((d) => ({ raw: d.raw, label: d.targetLabel! }));

  const sql = useMemo(() => {
    if (!staged.length) return "";
    const created = [...new Set(staged.map((s) => s.label))].filter(
      (l) => !dim.canonical.some((c) => c.label === l),
    );
    const dimSql = created.length
      ? `-- new master records → ${dim.dimTable}\nINSERT INTO ${dim.dimTable} (${dim.keyCol}, label) VALUES\n${created.map((l) => `  ('${keyFor(l)}', '${l.replace(/'/g, "''")}')`).join(",\n")}\nON CONFLICT (${dim.keyCol}) DO NOTHING;\n\n`
      : "";
    const merge = `-- value lookup → ${dim.mapTable}\nMERGE INTO ${dim.mapTable} AS m\nUSING (VALUES\n${staged.map((s) => `  ('${s.raw.replace(/'/g, "''")}', '${keyFor(s.label)}')`).join(",\n")}\n) AS s(raw, ${dim.keyCol})\nON lower(m.raw) = lower(s.raw)\nWHEN NOT MATCHED THEN INSERT (raw, ${dim.keyCol}) VALUES (s.raw, s.${dim.keyCol});`;
    return dimSql + merge;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staged, dim]);

  const approveAndCommit = async () => {
    setCommitError(null);
    if (staged.length === 0) return;
    setFlash({ n: staged.length });
    setShowSql(false);
    setReview(false);
    try {
      const res = await commit(dim.id);
      if (!res.committed) {
        setFlash(null);
        return;
      }
      setFlash({ n: res.committed });
      setTimeout(() => setFlash(null), 2800);
    } catch (err) {
      setFlash(null);
      setCommitError(
        err instanceof Error
          ? err.message
          : "Publish failed — check your connection and try again.",
      );
    }
  };

  const FILTERS: { k: Filter; label: string; n: number }[] = [
    { k: "new", label: "Needs review", n: counts.new },
    { k: "all", label: "All", n: counts.all },
    { k: "mapped", label: "Mapped", n: counts.mapped },
  ];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex flex-1 flex-col min-h-0">
        {/* toolbar / bulk bar */}
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-line bg-surface px-4 py-3">
          {sel.length === 0 || !canEdit ? (
            <>
              <Checkbox
                state={headState}
                onClick={() => setSel(allSel ? [] : visIds)}
                aria-label="Select all"
              />
              <div className="flex flex-wrap items-center gap-1.5">
                {FILTERS.map((f) => (
                  <button
                    key={f.k}
                    type="button"
                    onClick={() => setFilter(f.k)}
                    className={cx(
                      "rounded-sm px-2.5 py-1 font-mono text-[11px] transition-colors",
                      filter === f.k
                        ? "bg-accent-wash text-accent"
                        : "text-ink-3 hover:bg-hover hover:text-ink-2",
                    )}
                  >
                    {f.label} <span className="opacity-60">{f.n}</span>
                  </button>
                ))}
              </div>
              <input
                type="search"
                placeholder="Search source values…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="min-h-[32px] rounded-sm border border-line bg-bg px-2 font-mono text-[11px]"
              />
              {counts.new > 0 && (
                <Badge tone="warn" dot>
                  {counts.new} need review
                </Badge>
              )}
            </>
          ) : (
            <>
              <Checkbox state={headState} onClick={() => setSel([])} aria-label="Clear selection" />
              <span className="font-mono text-[12px] text-ink">{sel.length} selected</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  icon={<IconCheck className="h-3.5 w-3.5" />}
                  onClick={() =>
                    void bulkApply(
                      `accept ${sel.length} match${sel.length === 1 ? "" : "es"}`,
                      (v) => {
                        // No per-row suggestion in the paged payload — bulk
                        // accept can only land for the cursor row, which is
                        // not how bulk works. Surface a single toast.
                        if (cursorRaw === v && aiHint.hint?.suggestion) {
                          return stageMap(v, aiHint.hint.suggestion);
                        }
                        return undefined;
                      },
                    )
                  }
                >
                  Accept
                </Button>
                <div className="w-48">
                  <ComboSelect
                    options={options}
                    value={null}
                    allowCreate={!external}
                    placeholder="Merge all to…"
                    onPick={(t) =>
                      void bulkApply(
                        `merge ${sel.length} value${sel.length === 1 ? "" : "s"} → ${t}`,
                        (v) => stageMap(v, t),
                      )
                    }
                  />
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconX className="h-3.5 w-3.5" />}
                  onClick={() =>
                    void bulkApply(`skip ${sel.length} value${sel.length === 1 ? "" : "s"}`, (v) =>
                      skipPersist(v),
                    )
                  }
                >
                  Skip
                </Button>
              </div>
              <button
                type="button"
                onClick={() => setSel([])}
                className="ml-auto font-mono text-[11px] text-ink-3 hover:text-ink"
              >
                clear
              </button>
            </>
          )}
        </div>

        {/* default-target affordance — shown when ?target= resolved to a record */}
        {defaultTarget && (
          <div className="flex items-center gap-2 border-b border-line bg-accent-wash px-4 py-2 font-mono text-[11.5px]">
            <span className="text-ink-2">
              Mapping values to{" "}
              <span className="font-semibold text-ink">{defaultTarget.label}</span>
            </span>
            <Button
              size="sm"
              onClick={() => {
                for (const v of sel) void stageMap(v, defaultTarget.label);
              }}
            >
              Map selected
            </Button>
            <button
              type="button"
              aria-label="Clear target"
              onClick={() => setDefaultTarget(null)}
              className="ml-auto text-ink-3 hover:text-ink"
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* rows — DataGrid owns cursor, range selection, copy/paste, header */}
        <DataGrid<MappingValue>
          rows={visible}
          rowKey={(r) => r.value}
          columns={columns}
          selection={{ selected: sel, onChange: setSel }}
          getValue={(r, field) =>
            field === "target"
              ? (state[r.value]?.target ?? "")
              : (r as unknown as Record<string, unknown>)[field]
          }
          onCursorChange={(c) => setCursorRaw(c?.rowKey ?? null)}
          onCommit={
            canEdit
              ? async (rowKey, field, value) => {
                  if (field !== "target" || typeof value !== "string" || !value) return;
                  pick(rowKey, value);
                }
              : undefined
          }
          onCellKeyDown={(e, ctx) => {
            const v = ctx.cursor?.rowKey;
            if (canEdit && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void approveAndCommit();
              return;
            }
            if (!v) return;
            const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
            if (!plain) return;
            const k = e.key.toLowerCase();
            if (canEdit && k === "a") {
              e.preventDefault();
              accept(v);
            } else if (canEdit && k === "s") {
              e.preventDefault();
              skip(v);
            } else if (canEdit && k === "r") {
              e.preventDefault();
              reset(v);
            } else if (canEdit && k === "m") {
              e.preventDefault();
              ctx.startEdit();
            }
          }}
          renderRowDetail={(r) => {
            if (open !== r.value) return null;
            const row = state[r.value];
            const scan = byVal(r.value);
            const totalRows = scan?.totalRows ?? 0;
            return (
              <div className="px-4 py-3 pl-[52px]">
                <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
                  appears in
                </div>
                <div className="mt-2 grid gap-1.5">
                  {r.sources.map((o, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-4 font-mono text-[11.5px]"
                    >
                      <span className="text-ink-2">
                        {o.table}
                        <span className="text-ink-3">.{o.column}</span>
                      </span>
                      <span className="text-ink-3 tabular-nums">
                        {o.rows.toLocaleString()} rows
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 font-mono text-[10.5px] text-ink-3">
                  {row?.target ? (
                    engineer ? (
                      <>
                        → writes{" "}
                        <span className="text-accent">
                          (&#39;{r.value}&#39;, &#39;{keyFor(row.target)}&#39;)
                        </span>{" "}
                        to {dim.mapTable}
                      </>
                    ) : (
                      <>
                        → will resolve to <span className="text-accent">{row.target}</span> in{" "}
                        {dim.dimension}
                      </>
                    )
                  ) : engineer ? (
                    <>
                      ⚠ unresolved — these {totalRows.toLocaleString()} rows currently{" "}
                      <span className="text-danger">LEFT JOIN to NULL</span>
                    </>
                  ) : (
                    <>
                      ⚠ <span className="text-danger">Unmapped</span> —{" "}
                      {totalRows.toLocaleString()} downstream rows are missing this value
                    </>
                  )}
                </div>
                {(() => {
                  const d = allDrafts[dkey(dim.id, r.value)];
                  if (!d) return null;
                  if (d.status === "rejected") {
                    const reason = d.rejectedReason ?? null;
                    return (
                      <div className="mt-2">
                        <span
                          className="inline-block max-w-full truncate rounded-sm bg-danger-soft px-1.5 py-0.5 font-mono text-[10px] text-danger"
                          title={reason ?? undefined}
                        >
                          rejected{reason ? `: ${reason.slice(0, 60)}${reason.length > 60 ? "…" : ""}` : ""}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
                      <span className="grid h-4 w-4 place-items-center rounded-pill bg-surface-3 text-[8px] text-ink-2">
                        {d.user.initials}
                      </span>
                      staged {d.status === "skipped" ? "(skipped) " : ""}by{" "}
                      {d.user.id === currentUser.id ? "you" : d.user.name} · {d.at}
                      {engineer ? " · uncommitted draft" : " · awaiting publish"}
                    </div>
                  );
                })()}
                {state[r.value]?.status === "new" && canEdit && (
                  <div className="mt-2">
                    <GetSuggestionButton dimensionId={dim.id} rawValue={r.value} />
                  </div>
                )}
              </div>
            );
          }}
          empty={
            valuesPage.loading ? (
              <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
                loading…
              </div>
            ) : valuesPage.error ? (
              <div className="px-4 py-12 text-center font-mono text-[12px] text-danger">
                Failed to load values: {valuesPage.error}{" "}
                <button onClick={() => valuesPage.refetch()} className="text-accent hover:underline">
                  retry
                </button>
              </div>
            ) : filter === "new" ? (
              <div className="px-4 py-10 text-center">
                <div className="font-display text-[18px] font-semibold text-ink">
                  {dim.dimension} is fully matched 🎉
                </div>
                <div className="mt-1.5 font-mono text-[11.5px] text-ink-3">
                  See what else needs attention across all tables.
                </div>
                <div className="mt-4">
                  <Link to={nav.triage}>
                    <Button size="sm" icon={<IconArrowRight className="h-3.5 w-3.5" />}>
                      Open Triage
                    </Button>
                  </Link>
                </div>
              </div>
            ) : (
              <div className="px-4 py-12 text-center font-mono text-[12px] text-ink-3">
                no values in this view
              </div>
            )
          }
        />

        {/* Infinite-scroll sentinel + pager footer mirror Triage's pattern. */}
        <ScrollSentinel page={valuesPage} />

        {/* review & commit footer — drafts stage in Postgres, commit batch-MERGEs to DuckDB */}
        <div className="sticky bottom-0 z-10 border-t border-line bg-surface">
          {commitError && (
            <div className="flex items-center justify-between gap-3 border-b border-danger/40 bg-danger-soft px-4 py-2 text-[12px] text-danger">
              <span>Commit failed — {commitError}</span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setCommitError(null)}>
                  Dismiss
                </Button>
                {canEdit && (
                  <Button size="sm" onClick={() => void approveAndCommit()}>
                    Retry
                  </Button>
                )}
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <span className="font-mono text-[11px] text-ink-2">
              {flash ? (
                <span
                  className="zz-rise text-committed"
                  style={{ animationDuration: "var(--dur-slide)" }}
                >
                  ✓ {flash.n} {engineer ? "draft" : "change"}
                  {flash.n === 1 ? "" : "s"}{" "}
                  {engineer ? <>merged into {dim.mapTable}</> : <>published to {dim.dimension}</>}
                </span>
              ) : staged.length > 0 ? (
                engineer ? (
                  <>
                    {staged.length} staged draft{staged.length === 1 ? "" : "s"} → batch MERGE to{" "}
                    <span className="text-ink-2">{dim.dimTable}</span> +{" "}
                    <span className="text-ink-2">{dim.mapTable}</span>
                  </>
                ) : (
                  <>
                    {staged.length} change{staged.length === 1 ? "" : "s"} ready to publish to{" "}
                    <span className="text-ink-2">{dim.dimension}</span>
                  </>
                )
              ) : (
                <>nothing to publish yet — accept or merge values above to stage them</>
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={!undo.canUndo}
                onClick={() => void undo.undo()}
                title={undo.topLabel ?? undefined}
              >
                ↶ Undo
                {undo.topSurface && (
                  <span className="ml-1.5 font-mono text-[10px] text-ink-3">
                    ({undo.topSurface})
                  </span>
                )}
                {undo.topLabel && (
                  <span className="ml-1.5 inline-block max-w-[140px] truncate align-bottom text-[11px] text-ink-3">
                    {undo.topLabel}
                  </span>
                )}
                <span className="ml-2 font-mono text-[10px] opacity-60">⌘Z</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={staged.length === 0}
                onClick={() => setReview((s) => !s)}
              >
                {review ? "Hide review" : `Review ${staged.length}`}
              </Button>
              {engineer && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={staged.length === 0}
                  onClick={() => setShowSql((s) => !s)}
                >
                  {showSql ? "Hide SQL" : "Preview SQL"}
                </Button>
              )}
              <Button
                size="sm"
                disabled={staged.length === 0 || !canEdit}
                onClick={approveAndCommit}
              >
                {`Publish ${staged.length} change${staged.length === 1 ? "" : "s"}`}
                <span className="ml-2 font-mono text-[10px] opacity-60">⌘↵</span>
              </Button>
            </div>
          </div>
          {review && staged.length > 0 && (
            <div className="border-t border-line">
              <div className="px-5 pt-3 font-mono text-[10px] uppercase tracking-wider text-ink-3">
                Staged for review · {stagedDrafts.length}
              </div>
              <div className="mt-1 max-h-64 overflow-y-auto px-5 pb-2">
                {(() => {
                  const byTarget = new Map<string, typeof stagedDrafts>();
                  for (const d of stagedDrafts) {
                    const t = d.targetLabel ?? "—";
                    const arr = byTarget.get(t) ?? [];
                    arr.push(d);
                    byTarget.set(t, arr);
                  }
                  return [...byTarget.entries()]
                    .sort((a, b) => b[1].length - a[1].length)
                    .map(([target, drafts]) => (
                      <div key={target} className="pb-1.5">
                        <div className="flex items-center gap-2 pt-1.5 font-mono text-[11px]">
                          <IconArrowRight className="h-3 w-3 shrink-0 text-ink-3" />
                          <span className="truncate text-accent">{target}</span>
                          <span className="text-ink-3 tabular-nums">({drafts.length})</span>
                        </div>
                        <ul className="mt-1 divide-y divide-line">
                          {drafts.map((d) => (
                            <li
                              key={d.raw}
                              className="zz-rise flex items-center gap-3 py-1 pl-5 font-mono text-[11px]"
                              style={{ animationDuration: "var(--dur-slide)" }}
                            >
                              <span
                                className="grid h-5 w-5 shrink-0 place-items-center rounded-pill bg-surface-3 text-[9px] text-ink-2"
                                title={d.user.name}
                              >
                                {d.user.initials}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-ink">{d.raw}</span>
                              {d.source === "ai" && (
                                <span className="flex shrink-0 items-center gap-1">
                                  <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-semibold text-blue-700">
                                    AI
                                  </span>
                                  {d.confidence && (
                                    <span
                                      className={cx(
                                        "rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                                        d.confidence === "high" && "bg-green-100 text-green-700",
                                        d.confidence === "medium" &&
                                          "bg-yellow-100 text-yellow-700",
                                        d.confidence === "low" && "bg-red-100 text-red-700",
                                      )}
                                      title={d.reasoning ?? undefined}
                                    >
                                      {d.confidence.charAt(0).toUpperCase() + d.confidence.slice(1)}
                                    </span>
                                  )}
                                  {d.reasoning && (
                                    <span
                                      title={d.reasoning}
                                      className="inline-grid h-3.5 w-3.5 cursor-help place-items-center rounded-full bg-surface-3 text-[8px] text-ink-3"
                                    >
                                      ?
                                    </span>
                                  )}
                                </span>
                              )}
                              <span className="shrink-0 text-ink-2 tabular-nums">
                                {d.user.id === currentUser.id ? "you" : d.user.name} · {d.at}
                              </span>
                              <button
                                type="button"
                                onClick={() => discardStaged(d.raw)}
                                title="Discard this draft"
                                aria-label="Discard draft"
                                className="shrink-0 text-ink-3 transition-colors hover:text-danger"
                              >
                                <IconX className="h-3.5 w-3.5" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ));
                })()}
              </div>
            </div>
          )}
          {showSql && staged.length > 0 && (
            <pre className="overflow-x-auto border-t border-line bg-bg px-5 py-4 font-mono text-[11.5px] leading-relaxed text-ink-2">
              {sql}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

/* Infinite-scroll sentinel — observes a 1px div under the grid; when it
   intersects the viewport, advance the pager. Same shape as Triage's. */
function ScrollSentinel({ page }: { page: ReturnType<typeof useDimValuesPage> }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) page.loadMore();
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [page]);
  return (
    <>
      <div ref={ref} />
      {page.loading && page.items.length > 0 && (
        <div className="px-4 py-3 text-center font-mono text-[11px] text-ink-3">loading…</div>
      )}
      {!page.hasMore && page.items.length > 0 && (
        <div className="px-4 py-3 text-center font-mono text-[10px] text-ink-3">end of list</div>
      )}
    </>
  );
}
