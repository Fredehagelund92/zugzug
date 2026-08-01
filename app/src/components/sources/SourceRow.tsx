import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { IconWand } from "../Icons";
import { cx } from "../../lib/cx";
import { AnchoredPopover } from "../AnchoredPopover";
import { ago } from "./utils";
import type { SourceInfo } from "../../store";

interface SourceRowProps {
  row: SourceInfo;
  mapValuesHref: string;
  canEdit?: boolean;
  busy?: boolean;
  onDerive: () => void;
  onRemove: () => void;
}

export function SourceRow({
  row,
  mapValuesHref,
  canEdit = true,
  busy,
  onDerive,
  onRemove,
}: SourceRowProps) {
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  // Derive connection state
  const state =
    row.scanned && !row.present
      ? { label: "⚠ column not found", tone: "text-danger" }
      : !row.scanned && !row.scannedAt
        ? { label: "never scanned", tone: "text-warn" }
        : {
            label: row.scannedAt ? `scanned ${ago(row.scannedAt)} ago` : "scanned",
            tone: "text-ink-3",
          };

  // Render schema.table.column as one mono string:
  //   schema.  — dimmed (text-ink-3)
  //   table    — normal (text-ink)
  //   .column  — dimmed (text-ink-3)
  // row.table is "schema.table" (dot-separated); row.column is the column name.
  const dotIdx = row.table.indexOf(".");
  const schemaPrefix = dotIdx !== -1 ? row.table.slice(0, dotIdx + 1) : null;
  const tableOnly = dotIdx !== -1 ? row.table.slice(dotIdx + 1) : row.table;

  return (
    <div className="relative grid grid-cols-1 items-start gap-x-4 gap-y-1 border-b border-line px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-2/40 sm:grid-cols-[minmax(0,1fr)_minmax(120px,auto)_150px_32px] sm:items-center sm:gap-y-0 sm:px-6 sm:py-3 sm:pl-10">
      {/* Column identity: schema.table.column */}
      <div className="truncate font-mono text-[12.5px]">
        {schemaPrefix && <span className="text-ink-3">{schemaPrefix}</span>}
        <span className="text-ink">{tableOnly}</span>
        <span className="text-ink-3">.{row.column}</span>
      </div>

      {/* Target refTable */}
      <div className="whitespace-nowrap text-[12.5px]">
        <span className="mr-1.5 text-ink-3">→</span>
        <span className="font-display font-semibold text-ink">{row.refTable}</span>
      </div>

      {/* Connection state */}
      <div className={cx("whitespace-nowrap font-mono text-[11px]", state.tone)}>{state.label}</div>

      {/* Actions menu */}
      <div className="absolute right-3 top-2.5 sm:relative sm:right-auto sm:top-auto sm:justify-self-end">
        <button
          ref={menuBtn}
          type="button"
          aria-label="More actions"
          onClick={() => setMenu((v) => !v)}
          className="px-1.5 py-1 text-ink-3 transition-colors hover:text-ink"
        >
          ⋯
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            {/* Portaled: the Sources card is overflow-hidden, which clipped
                this menu on the bottom row of a group (#195). */}
            <AnchoredPopover
              anchor={menuBtn}
              align="right"
              role="menu"
              aria-label="More actions"
              onDismiss={() => setMenu(false)}
              className="rounded-lg min-w-[180px] border border-line-2 bg-surface-3 p-1 shadow-pop"
            >
              <button
                type="button"
                disabled={!canEdit || !!busy}
                onClick={() => {
                  setMenu(false);
                  onDerive();
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-40"
              >
                <IconWand className="h-3 w-3" /> Re-scan
              </button>
              <Link
                to={mapValuesHref}
                onClick={() => setMenu(false)}
                className="block px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover hover:text-ink"
              >
                Open in Map values
              </Link>
              <div className="my-1 h-px bg-line" />
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => {
                  setMenu(false);
                  onRemove();
                }}
                className="block w-full px-2.5 py-1.5 text-left text-[12.5px] text-danger hover:bg-danger-soft disabled:opacity-40"
              >
                Remove source
              </button>
            </AnchoredPopover>
          </>
        )}
      </div>
    </div>
  );
}
