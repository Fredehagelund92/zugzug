import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx";
import {
  IconEdit,
  IconType,
  IconSortAsc,
  IconSortDesc,
  IconX,
  IconEyeOff,
  IconTrash,
  IconChevronLeft,
  IconFilter,
} from "../Icons";
import type { CellType, ColumnDef } from "./types";

interface Props<Row> {
  column: ColumnDef<Row>;
  anchorRef: React.RefObject<HTMLElement | null>;
  sortDir: "asc" | "desc" | null;
  filterValue: string | null;
  onClose: () => void;
  onRename: (newLabel: string) => void;
  onSort: (dir: "asc" | "desc" | null) => void;
  onChangeType: (newType: CellType) => void;
  onHide: () => void;
  onDelete: () => void;
  onFilter: (value: string | null) => void;
}

const TYPES: CellType[] = ["text", "number", "boolean", "date", "select"];
const MENU_WIDTH = 192; // matches w-48
const GAP = 4;

export function ColumnHeaderMenu<Row>({
  column,
  anchorRef,
  sortDir,
  filterValue,
  onClose,
  onRename,
  onSort,
  onChangeType,
  onHide,
  onDelete,
  onFilter,
}: Props<Row>) {
  const [mode, setMode] = useState<"menu" | "rename" | "type" | "filter" | "confirm-delete">(
    "menu",
  );
  const [draft, setDraft] = useState(column.label);
  const [filterDraft, setFilterDraft] = useState(filterValue ?? "");
  const ref = useRef<HTMLDivElement>(null);

  // Position relative to the anchor (the ⋯ button) using fixed coords. Rendered
  // in a portal on document.body so the menu escapes the grid's stacking
  // context entirely — sticky bars and other contexts can no longer cover it.
  useLayoutEffect(() => {
    const popover = ref.current;
    const anchor = anchorRef.current;
    if (!popover || !anchor) return;
    const place = (): void => {
      const a = anchor.getBoundingClientRect();
      const popH = popover.offsetHeight;
      // align right edges, drop below the button; flip above on viewport overflow
      let left = a.right - MENU_WIDTH;
      if (left < 8) left = 8;
      if (left + MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - MENU_WIDTH - 8;
      let top = a.bottom + GAP;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - GAP - popH);
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef, mode]);

  // Close on outside click. Skip clicks on the anchor button itself so the
  // user can toggle the menu off via the same ⋯ button.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const popover = ref.current;
      const anchor = anchorRef.current;
      const target = e.target as Node;
      if (popover && popover.contains(target)) return;
      if (anchor && anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose, anchorRef]);

  const item =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[11.5px] text-ink hover:bg-hover";
  const iconCls = "h-3.5 w-3.5 shrink-0 text-ink-3";

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top: 0, left: 0, width: MENU_WIDTH }}
      className="zz-pop-in z-40 rounded-sm border border-line-2 bg-surface-elevated p-1 shadow-pop"
    >
      {mode === "menu" && (
        <>
          <button type="button" className={item} onClick={() => setMode("rename")}>
            <IconEdit className={iconCls} /> rename column
          </button>
          <button type="button" className={item} onClick={() => setMode("type")}>
            <IconType className={iconCls} /> change type
          </button>
          <button type="button" className={item} onClick={() => setMode("filter")}>
            <IconFilter className={iconCls} /> filter…
            {filterValue && (
              <span className="ml-auto rounded-pill bg-accent-wash px-1.5 font-mono text-[9px] text-accent">
                on
              </span>
            )}
          </button>
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            className={item}
            onClick={() => {
              onSort("asc");
              onClose();
            }}
          >
            <IconSortAsc className={iconCls} /> sort A→Z
          </button>
          <button
            type="button"
            className={item}
            onClick={() => {
              onSort("desc");
              onClose();
            }}
          >
            <IconSortDesc className={iconCls} /> sort Z→A
          </button>
          {sortDir != null && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onSort(null);
                onClose();
              }}
            >
              <IconX className={iconCls} /> clear sort
            </button>
          )}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            className={item}
            onClick={() => {
              onHide();
              onClose();
            }}
          >
            <IconEyeOff className={iconCls} /> hide column
          </button>
          <button
            type="button"
            className={cx(item, "text-danger")}
            onClick={() => setMode("confirm-delete")}
          >
            <IconTrash className="h-3.5 w-3.5 shrink-0" /> delete column
          </button>
        </>
      )}
      {mode === "rename" && (
        <div className="p-1">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onRename(draft.trim());
                onClose();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none"
          />
          <div className="mt-1.5 flex gap-1">
            <button
              type="button"
              className={cx(item, "justify-center bg-accent text-accent-ink hover:brightness-110")}
              onClick={() => {
                onRename(draft.trim());
                onClose();
              }}
            >
              save
            </button>
            <button type="button" className={item + " justify-center"} onClick={onClose}>
              cancel
            </button>
          </div>
        </div>
      )}
      {mode === "type" && (
        <div>
          {TYPES.map((t) => (
            <button
              key={t}
              type="button"
              className={cx(item, column.type === t && "bg-accent-wash text-accent")}
              onClick={() => {
                if (t !== column.type) onChangeType(t);
                onClose();
              }}
            >
              {t}
              {column.type === t ? " · current" : ""}
            </button>
          ))}
          <div className="my-1 h-px bg-line" />
          <button type="button" className={item} onClick={() => setMode("menu")}>
            <IconChevronLeft className={iconCls} /> back
          </button>
        </div>
      )}
      {mode === "filter" && (
        <div className="p-1">
          <input
            autoFocus
            value={filterDraft}
            onChange={(e) => setFilterDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onFilter(filterDraft.trim() || null);
                onClose();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="contains…"
            className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3"
          />
          <div className="mt-1.5 flex gap-1">
            <button
              type="button"
              className={cx(item, "justify-center bg-accent text-accent-ink hover:brightness-110")}
              onClick={() => {
                onFilter(filterDraft.trim() || null);
                onClose();
              }}
            >
              apply
            </button>
            {filterValue && (
              <button
                type="button"
                className={item + " justify-center"}
                onClick={() => {
                  setFilterDraft("");
                  onFilter(null);
                  onClose();
                }}
              >
                clear
              </button>
            )}
            <button type="button" className={item + " justify-center"} onClick={() => setMode("menu")}>
              <IconChevronLeft className={iconCls} />
            </button>
          </div>
        </div>
      )}
      {mode === "confirm-delete" && (
        <div className="p-2 text-[11.5px] text-ink-2">
          <div className="font-mono">
            Delete <span className="text-ink">{column.label}</span>? This drops the column on every
            row.
          </div>
          <div className="mt-2 flex gap-1">
            <button
              type="button"
              className={cx(item, "justify-center bg-danger text-accent-ink hover:brightness-110")}
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              delete
            </button>
            <button type="button" className={item + " justify-center"} onClick={onClose}>
              cancel
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
