import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../lib/cx";
import { PALETTE, type PaletteName } from "../lib/palette";
import { IconPlus, IconX, IconSearch } from "./Icons";
import { useDimensions, useDrafts } from "../store";
import { useOpenTabs, type OpenTab } from "../lib/open-tabs";
import type { MappingDimension } from "../data";

function TabMono({ label, color, active }: { label: string; color: PaletteName | null; active: boolean }) {
  const ch = label.charAt(0).toUpperCase();
  if (color) {
    const t = PALETTE[color];
    return (
      <div
        className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-sm font-display text-[10px] font-bold"
        style={{ background: active ? t.bg : t.wash, color: active ? "***REMOVED***FFFFFF" : t.fg }}
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
  dims,
  openIds,
  onPick,
  onClose,
  onCreate,
}: {
  dims: MappingDimension[];
  openIds: Set<string>;
  onPick: (id: string) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const list = dims.filter((d) => d.dimension.toLowerCase().includes(q.toLowerCase().trim()));
  return (
    <div
      ref={ref}
      className="zz-pop-in absolute right-0 top-full z-50 mt-px w-[280px] overflow-hidden rounded-md border border-line-2 bg-surface-elevated shadow-pop"
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
        {list.length === 0 && <li className="px-3 py-2 font-mono text-[12px] text-ink-3">no match</li>}
      </ul>
      <button
        type="button"
        onClick={() => {
          onClose();
          onCreate();
        }}
        className="flex w-full items-center gap-2 border-t border-line px-3 py-2 font-mono text-[12px] text-accent transition-colors hover:bg-accent-wash"
      >
        <IconPlus className="h-3.5 w-3.5" /> New table
      </button>
    </div>
  );
}

interface TabItemProps {
  tab: OpenTab;
  dim: MappingDimension;
  active: boolean;
  dirty: boolean;
  onFocus: () => void;
  onClose: () => void;
}

function TabItem({ tab, dim, active, dirty, onFocus, onClose }: TabItemProps) {
  return (
    <div
      role="tab"
      aria-selected={active}
      data-tab-id={tab.id}
      onClick={onFocus}
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
        active
          ? "bg-surface text-ink"
          : "bg-surface-2 text-ink-2 hover:bg-hover hover:text-ink",
      )}
    >
      {active && <span aria-hidden className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
      <TabMono label={dim.dimension} color={dim.color ?? null} active={active} />
      <span className="max-w-[160px] truncate font-display font-semibold">{dim.dimension}</span>
      {dirty && (
        <span
          aria-label="uncommitted drafts"
          className="h-1.5 w-1.5 rounded-pill bg-accent"
          title="uncommitted drafts"
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
          "grid h-4 w-4 place-items-center rounded-sm text-ink-3 transition-opacity hover:bg-line hover:text-ink",
          active ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
        )}
      >
        <IconX className="h-3 w-3" />
      </button>
    </div>
  );
}

export function TableTabStrip({ onCreateRequested }: { onCreateRequested: () => void }) {
  const dims = useDimensions();
  const drafts = useDrafts();
  const { tabs, activeId, focusTab, closeTab, openTab } = useOpenTabs();
  const [addOpen, setAddOpen] = useState(false);

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
      <div className="flex flex-1 items-stretch overflow-x-auto">
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
            />
          );
        })}
      </div>

      <div className="relative flex items-center border-l border-line">
        <button
          type="button"
          onClick={() => setAddOpen((o) => !o)}
          aria-label="Open table"
          className="grid h-full w-9 place-items-center text-ink-3 transition-colors hover:bg-hover hover:text-accent"
        >
          <IconPlus className="h-4 w-4" />
        </button>
        {addOpen && (
          <AddTabPopover
            dims={dims}
            openIds={openIds}
            onPick={(id) => openTab(id)}
            onClose={() => setAddOpen(false)}
            onCreate={onCreateRequested}
          />
        )}
      </div>
    </div>
  );
}
