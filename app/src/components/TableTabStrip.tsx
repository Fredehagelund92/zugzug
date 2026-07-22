import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { PALETTE, type PaletteName } from "../lib/palette";
import { IconPlus, IconX, IconSearch } from "./Icons";
import { useDimensions, useDrafts, useCanEdit, deleteDimension } from "../store";
import { useOpenTabs, type OpenTab } from "../lib/open-tabs";
import type { MappingDimension } from "../data";
import { ContextMenu } from "./datagrid/ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { toast } from "./Toast";

const DROPDOWN_W = 280;

function TabMono({
  label,
  color,
  active,
}: {
  label: string;
  color: PaletteName | null;
  active: boolean;
}) {
  const ch = label.charAt(0).toUpperCase();
  if (color) {
    const t = PALETTE[color];
    return (
      <div
        className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-sm font-display text-[10px] font-bold"
        style={{ background: active ? t.bg : t.wash, color: active ? "#FFFFFF" : t.fg }}
      >
        {ch}
      </div>
    );
  }
  return (
    <div
      className={cx(
        "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-sm font-display text-[10px] font-bold",
        active ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent",
      )}
    >
      {ch}
    </div>
  );
}

function AddTabPopover({
  anchorRef,
  dims,
  openIds,
  onPick,
  onClose,
  onCreate,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  dims: MappingDimension[];
  openIds: Set<string>;
  onPick: (id: string) => void;
  onClose: () => void;
  onCreate?: () => void;
}) {
  const [q, setQ] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const place = () => {
      const dropdown = dropdownRef.current;
      const anchor = anchorRef.current;
      if (!dropdown || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const dropH = dropdown.offsetHeight;

      if (window.innerWidth < 768) {
        const margin = 8;
        const w = window.innerWidth - margin * 2;
        dropdown.style.width = `${w}px`;
        dropdown.style.left = `${margin}px`;
        let top = rect.bottom + 2;
        if (top + dropH > window.innerHeight - 8) top = Math.max(8, rect.top - 2 - dropH);
        dropdown.style.top = `${top}px`;
        return;
      }

      dropdown.style.width = `${DROPDOWN_W}px`;
      // right-align with the anchor button
      let left = rect.right - DROPDOWN_W;
      if (left < 8) left = 8;
      if (left + DROPDOWN_W > window.innerWidth - 8) left = window.innerWidth - DROPDOWN_W - 8;

      let top = rect.bottom + 2;
      if (top + dropH > window.innerHeight - 8) top = Math.max(8, rect.top - 2 - dropH);

      dropdown.style.left = `${left}px`;
      dropdown.style.top = `${top}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (dropdownRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  const list = dims.filter((d) => d.dimension.toLowerCase().includes(q.toLowerCase().trim()));

  return createPortal(
    <div
      ref={dropdownRef}
      style={{ position: "fixed", top: 0, left: 0 }}
      className="zz-pop-in z-50 overflow-hidden rounded-md border border-line-2 bg-surface-elevated shadow-pop"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-ink-3">
        <IconSearch className="h-3.5 w-3.5" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="open a table…"
          className="w-full bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3"
        />
      </div>
      <ul className="max-h-72 overflow-y-auto py-1">
        {list.map((d) => {
          const isOpen = openIds.has(d.id);
          return (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(d.id);
                  onClose();
                }}
                className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors hover:bg-hover"
              >
                <TabMono label={d.dimension} color={d.color ?? null} active={false} />
                <span className="min-w-0 flex-1 truncate font-display text-[13px] font-semibold text-ink">
                  {d.dimension}
                </span>
                {isOpen && <span className="font-mono text-[10px] text-ink-3">open</span>}
              </button>
            </li>
          );
        })}
        {list.length === 0 && (
          <li className="px-3 py-2 font-mono text-[12px] text-ink-3">no match</li>
        )}
      </ul>
      {onCreate && (
        <button
          type="button"
          data-testid="create-table-button"
          onClick={() => {
            onClose();
            onCreate();
          }}
          className="flex w-full items-center gap-2 border-t border-line px-3 py-2 font-mono text-[12px] text-accent transition-colors hover:bg-accent-wash"
        >
          <IconPlus className="h-3.5 w-3.5" /> New table
        </button>
      )}
    </div>,
    document.body,
  );
}

interface TabItemProps {
  tab: OpenTab;
  dim: MappingDimension;
  active: boolean;
  dirty: boolean;
  onFocus: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

function TabItem({ tab, dim, active, dirty, onFocus, onClose, onContextMenu }: TabItemProps) {
  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      onClick={onFocus}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onFocus();
        }
      }}
      tabIndex={0}
      className={cx(
        "group relative flex h-full cursor-pointer items-center gap-2 border-r border-line px-3 text-[12.5px] transition-colors",
        active ? "bg-surface text-ink" : "bg-surface-2 text-ink-2 hover:bg-hover hover:text-ink",
      )}
    >
      {active && <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
      <TabMono label={dim.dimension} color={dim.color ?? null} active={active} />
      <span className="max-w-[120px] truncate font-display font-semibold md:max-w-[160px]">
        {dim.dimension}
      </span>
      {dirty && (
        <span
          aria-label="unpublished drafts"
          className="h-1.5 w-1.5 rounded-pill bg-accent"
          title="unpublished drafts"
        />
      )}
      <button
        type="button"
        aria-label={`Close ${dim.dimension}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cx(
          "grid h-4 w-4 place-items-center rounded-sm text-ink-3 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 hover:bg-line hover:text-ink",
          active
            ? "opacity-60 hover:opacity-100"
            : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
        )}
      >
        <IconX className="h-3 w-3" />
      </button>
    </div>
  );
}

export function TableTabStrip({ onCreateRequested }: { onCreateRequested?: () => void }) {
  const dims = useDimensions();
  const drafts = useDrafts();
  const canEdit = useCanEdit();
  const { tabs, activeId, focusTab, closeTab, openTab } = useOpenTabs();
  const [addOpen, setAddOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: OpenTab } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MappingDimension | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Dismiss the tab context menu on outside mousedown or Escape
  useEffect(() => {
    if (!tabMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTabMenu(null);
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[role="menu"]')) return;
      setTabMenu(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [tabMenu]);

  const dirtyDimIds = useMemo(() => {
    const s = new Set<string>();
    for (const d of Object.values(drafts)) s.add(d.dimId);
    return s;
  }, [drafts]);

  const dimById = useMemo(() => new Map(dims.map((d) => [d.id, d])), [dims]);
  const openIds = useMemo(() => new Set(tabs.map((t) => t.dimId)), [tabs]);

  return (
    <div
      role="tablist"
      className="sticky top-0 z-10 flex h-9 items-stretch border-b border-line bg-surface-2"
    >
      <div className="flex flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [-webkit-overflow-scrolling:touch]">
        {tabs.map((tab) => {
          const dim = dimById.get(tab.dimId);
          if (!dim) return null;
          return (
            <TabItem
              key={tab.id}
              tab={tab}
              dim={dim}
              active={tab.id === activeId}
              dirty={dirtyDimIds.has(tab.dimId)}
              onFocus={() => focusTab(tab.id)}
              onClose={() => closeTab(tab.id)}
              onContextMenu={(e) => setTabMenu({ x: e.clientX, y: e.clientY, tab })}
            />
          );
        })}
      </div>

      <div className="flex items-center border-l border-line">
        <button
          ref={addBtnRef}
          type="button"
          onClick={() => setAddOpen((o) => !o)}
          aria-label="Open table"
          className="grid h-full w-9 place-items-center text-ink-3 transition-colors hover:bg-hover hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <IconPlus className="h-4 w-4" />
        </button>
        {addOpen && (
          <AddTabPopover
            anchorRef={addBtnRef}
            dims={dims}
            openIds={openIds}
            onPick={(id) => openTab(id)}
            onClose={() => setAddOpen(false)}
            onCreate={onCreateRequested}
          />
        )}
      </div>

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          items={[
            { label: "Close tab", onClick: () => closeTab(tabMenu.tab.id) },
            ...(canEdit
              ? [
                  {
                    label: "Delete table…",
                    onClick: () => {
                      const dim = dims.find((d) => d.id === tabMenu.tab.dimId);
                      if (dim) setDeleteTarget(dim);
                    },
                  },
                ]
              : []),
          ]}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          open
          danger
          loading={deleting}
          title={`Delete ${deleteTarget.dimension}?`}
          confirmLabel="Delete table"
          confirmPhrase={deleteTarget.dimension}
          body={
            <>
              Permanently delete <strong>{deleteTarget.dimension}</strong>? Its{" "}
              {deleteTarget.rows.toLocaleString()} records and their mappings are deleted, and
              anything reading <code>dim_{deleteTarget.id}</code> from the warehouse will break.
              This cannot be undone.
            </>
          }
          onConfirm={async () => {
            setDeleting(true);
            try {
              await deleteDimension(deleteTarget.id);
              const open = tabs.find((t) => t.dimId === deleteTarget.id);
              if (open) closeTab(open.id);
              toast(`Deleted ${deleteTarget.dimension}.`);
              setDeleteTarget(null);
            } catch (err) {
              toast(
                `Couldn't delete ${deleteTarget.dimension} — ${err instanceof Error ? err.message : "please try again"}`,
                "error",
              );
            } finally {
              setDeleting(false);
            }
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
