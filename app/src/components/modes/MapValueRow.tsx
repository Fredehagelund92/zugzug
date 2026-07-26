import { useMemo } from "react";
import type { Cluster } from "../../lib/use-ref-table-clusters";
import type { MappingRefTable } from "../../data";
import { ComboSelect, type ComboSelectHandle } from "../ComboSelect";
import { saveDraft, discardDraft, useDrafts, useCanEdit, slug, dkey } from "../../store";
import { recordKeyByLabel, suggestRecordLabel } from "../../lib/map-value-helpers";
import { cx } from "../../lib/cx";

/* MapValueRow — one cluster of look-alike source values rendered as a single
   worklist row: value + "+N spellings" chip, a record picker, and a status
   cell. Matches Review's `value · picker · status` grammar. Mapping (or
   skipping/clearing) a row stages one saveDraft per member spelling, so one
   decision covers the whole family. */
export interface MapValueRowProps {
  cluster: Cluster;
  refTable: MappingRefTable;
  recordLabels: string[];
  isCursor: boolean;
  onFocus: () => void;
  comboRef?: React.Ref<ComboSelectHandle>;
}

export function MapValueRow({
  cluster,
  refTable,
  recordLabels,
  isCursor,
  onFocus,
  comboRef,
}: MapValueRowProps) {
  const drafts = useDrafts();
  const canEdit = useCanEdit();

  const primaryRaw = cluster.members[0]?.raw ?? cluster.rep;
  const draft = drafts[dkey(refTable.id, primaryRaw)];

  const labelToKey = useMemo(() => recordKeyByLabel(refTable.record), [refTable.record]);
  const suggestion = useMemo(
    () => suggestRecordLabel(refTable.record, cluster.rep),
    [refTable.record, cluster.rep],
  );

  const extra = cluster.members.length - 1;
  const occ = cluster.members[0]?.occurrences[0];

  const map = (label: string) => {
    const key = labelToKey.get(label) ?? slug(label);
    for (const m of cluster.members) void saveDraft(refTable.id, m.raw, "mapped", label, key);
  };
  const skip = () => {
    for (const m of cluster.members) void saveDraft(refTable.id, m.raw, "skipped", null, null);
  };
  const clear = () => {
    for (const m of cluster.members) void discardDraft(refTable.id, m.raw);
  };

  return (
    <li
      onMouseEnter={onFocus}
      className={cx(
        "grid grid-cols-1 items-center gap-2 border-b border-l-2 border-line px-4 py-3 md:grid-cols-[minmax(0,1fr)_15rem_6rem] md:gap-4",
        isCursor ? "border-l-accent bg-accent-wash" : "border-l-transparent hover:bg-hover",
      )}
    >
      {/* value + spellings chip + provenance */}
      <div className="min-w-0">
        <span className="break-words font-mono text-[14px] font-semibold tracking-[-0.01em] text-ink">
          {cluster.rep}
          {extra > 0 && (
            <span className="ml-2 rounded-sm border border-dashed border-line-2 px-1.5 py-px font-mono text-[11px] font-normal text-ink-3">
              +{extra} spelling{extra === 1 ? "" : "s"}
            </span>
          )}
        </span>
        <div className="mt-0.5 font-mono text-[10.5px] tabular-nums text-ink-3">
          {cluster.rows.toLocaleString("en-US")} rows
          {occ ? ` · ${occ.table}.${occ.column}` : ""}
        </div>
      </div>

      {/* record picker */}
      <ComboSelect
        ref={comboRef}
        options={recordLabels}
        value={draft?.status === "mapped" ? draft.targetLabel : null}
        suggestion={suggestion}
        placeholder="Pick a record…"
        allowCreate
        disabled={!canEdit}
        onPick={map}
        ariaLabel={`Record for ${cluster.rep}`}
      />

      {/* status */}
      <div className="font-mono text-[10.5px]">
        {draft?.status === "mapped" ? (
          <button
            type="button"
            onClick={clear}
            className="inline-flex items-center gap-1.5 text-committed hover:text-ink-2"
          >
            <span className="h-1.5 w-1.5 rounded-pill bg-committed" /> draft
          </button>
        ) : draft?.status === "skipped" ? (
          <button type="button" onClick={clear} className="text-ink-3 hover:text-ink-2">
            skipped
          </button>
        ) : isCursor ? (
          <button type="button" onClick={skip} className="text-ink-3 hover:text-ink-2">
            <span className="text-ink-2">S</span> skip
          </button>
        ) : (
          <span className="text-ink-3">—</span>
        )}
      </div>
    </li>
  );
}
