import { useEffect, useRef } from "react";
import type { MappingValue } from "../../data";
import { valueRows } from "../../data";
import type { ColumnDef, EditCtx } from "../datagrid/types";
import { ComboSelect, type ComboSelectHandle } from "../ComboSelect";
import { Chip } from "../datagrid";
import { cx } from "../../lib/cx";

const confBar = (c: number) => (c >= 90 ? "bg-ok" : c >= 70 ? "bg-warn" : "bg-danger/30");
const confText = (c: number) => (c >= 90 ? "text-ok" : c >= 70 ? "text-warn" : "text-danger");

export interface MatchRowState {
  target: string | null;
  status: "mapped" | "new" | "skipped" | "rejected";
  rejectedReason?: string | null;
}

/** ComboSelect as a DataGrid edit cell: opens on mount, commits the pick,
 *  cancels when the popover closes without one (Escape, outside click) —
 *  the cancel is critical, otherwise DataGrid stays in edit mode and silently
 *  swallows subsequent clicks. */
function TargetEditor({
  row,
  ctx,
  options,
  allowCreate,
  current,
}: {
  row: MappingValue;
  ctx: EditCtx<MappingValue>;
  options: string[];
  allowCreate: boolean;
  current: string | null;
}) {
  const handle = useRef<ComboSelectHandle>(null);
  const committedRef = useRef(false);
  useEffect(() => {
    handle.current?.open();
  }, []);
  return (
    <ComboSelect
      ref={handle}
      options={options}
      value={current}
      suggestion={row.suggestion}
      allowCreate={allowCreate}
      onPick={(t) => {
        committedRef.current = true;
        ctx.commit(t);
      }}
      onClose={() => {
        if (!committedRef.current) ctx.cancel();
      }}
    />
  );
}

export function matchColumns(opts: {
  refTableLabel: string;
  options: string[];
  state: Record<string, MatchRowState>;
  external: boolean;
  canEdit: boolean;
  onToggleDrill: (value: string) => void;
  openDrill: string | null;
}): ColumnDef<MappingValue>[] {
  const { refTableLabel, options, state, external, canEdit, onToggleDrill, openDrill } = opts;
  return [
    {
      field: "value",
      label: "Source value · where it's seen",
      config: { type: "text" },
      editable: false,
      pinnedLeft: true,
      render: (r) => {
        const primary = r.sources[0];
        return (
          <span className="min-w-0">
            <span className="block truncate font-mono text-[13px] text-ink">{r.value}</span>
            {primary && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleDrill(r.value);
                }}
                className={cx(
                  "block truncate font-mono text-[10px] transition-colors",
                  openDrill === r.value ? "text-ink-2" : "text-ink-3 hover:text-ink-2",
                )}
              >
                {primary.table}.{primary.column}
                {r.sources.length > 1 ? ` +${r.sources.length - 1}` : ""} ·{" "}
                {valueRows(r).toLocaleString()} rows
              </button>
            )}
          </span>
        );
      },
    },
    {
      field: "target",
      label: `${refTableLabel.toLowerCase()} record`,
      config: { type: "text" },
      editable: canEdit,
      render: (r) => {
        const target = state[r.value]?.target ?? null;
        if (target)
          return <span className="truncate font-display text-[13px] text-ink">{target}</span>;
        if (r.suggestion)
          return (
            <span className="truncate font-mono text-[12px] text-ink-3">
              {r.suggestion} <span className="text-accent">(suggested)</span>
            </span>
          );
        return <span className="font-mono text-[12px] text-ink-3">—</span>;
      },
      edit: (r, ctx) => (
        <TargetEditor
          row={r}
          ctx={ctx}
          options={options}
          allowCreate={!external}
          current={state[r.value]?.target ?? null}
        />
      ),
    },
    {
      field: "confidence",
      label: "Confidence",
      config: { type: "text" },
      editable: false,
      width: 110,
      render: (r) =>
        r.confidence > 0 ? (
          <span className="flex items-center gap-2">
            <span className="h-1 w-8 overflow-hidden rounded-pill bg-surface-2">
              <span
                className={cx("block h-full rounded-pill", confBar(r.confidence))}
                style={{ width: `${r.confidence}%` }}
              />
            </span>
            <span className={cx("font-mono text-[11px] tabular-nums", confText(r.confidence))}>
              {r.confidence}
            </span>
          </span>
        ) : (
          <span className="font-mono text-[11px] text-ink-2">—</span>
        ),
    },
    {
      field: "status",
      label: "Status",
      config: { type: "text" },
      editable: false,
      width: 96,
      render: (r) => {
        const row = state[r.value];
        const s = row?.status ?? "new";
        if (s === "mapped") return <Chip label="Mapped" bucket="chip-1" dot />;
        if (s === "skipped") return <Chip label="Skipped" bucket="chip-5" />;
        if (s === "rejected") {
          const reason = row?.rejectedReason ?? null;
          return (
            <span
              className="inline-block max-w-full truncate rounded-sm bg-danger-soft px-1.5 py-0.5 font-mono text-[10px] text-danger"
              title={reason ?? undefined}
            >
              rejected{reason ? `: ${reason.slice(0, 60)}${reason.length > 60 ? "…" : ""}` : ""}
            </span>
          );
        }
        return <Chip label="New" bucket="chip-2" dot />;
      },
    },
  ];
}
