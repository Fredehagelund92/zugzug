import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cx } from "../lib/cx";
import { PALETTE, type PaletteName } from "../lib/palette";
import { IconPlus, IconPin, IconSearch } from "./Icons";
import { useDimensions, useDrafts } from "../store";
import { useOpenTabs } from "../lib/open-tabs";
import { useCreateTableModal } from "../lib/create-table-modal";
import type { MappingDimension } from "../data";

const PINNED_KEY = "zugzug:pinned-dims";

function usePinnedDims(): [Set<string>, (id: string, pinned: boolean) => void] {
  const [ids, setIds] = useState<Set<string>>(() => {
    if (typeof localStorage === "undefined") return new Set();
    try {
      const raw = localStorage.getItem(PINNED_KEY);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string, pinned: boolean) => {
    setIds((cur) => {
      const next = new Set(cur);
      if (pinned) next.add(id);
      else next.delete(id);
      try {
        localStorage.setItem(PINNED_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  };
  return [ids, toggle];
}

function DimMono({ label, color, active }: { label: string; color: PaletteName | null; active: boolean }) {
  const ch = label.charAt(0).toUpperCase();
  if (color) {
    const t = PALETTE[color];
    return (
      <div
        className="grid h-6 w-6 shrink-0 place-items-center rounded-sm font-display text-[11px] font-bold"
        style={{ background: active ? t.bg : t.wash, color: active ? "***REMOVED***FFFFFF" : t.fg }}
      >
        {ch}
      </div>
    );
  }
  return (
    <div
      className={cx(
        "grid h-6 w-6 shrink-0 place-items-center rounded-sm font-display text-[11px] font-bold",
        active ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent",
      )}
    >
      {ch}
    </div>
  );
}

interface DimRowProps {
  dim: MappingDimension;
  active: boolean;
  dirty: boolean;
  pinned: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
}

function DimRow({ dim, active, dirty, pinned, onOpen, onTogglePin }: DimRowProps) {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className={cx(
          "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors max-md:min-h-[44px]",
          active
            ? "text-accent shadow-[inset_2px_0_0_var(--accent)]"
            : "text-ink-2 hover:bg-hover hover:text-ink",
        )}
      >
        <DimMono label={dim.dimension} color={dim.color ?? null} active={active} />
        <span
          className={cx(
            "min-w-0 flex-1 truncate font-display text-[13px] font-semibold",
            active ? "text-accent" : "text-ink",
          )}
        >
          {dim.dimension}
        </span>
        {dirty && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-pill bg-accent" title="uncommitted drafts" />
        )}
      </button>
      <button
        type="button"
        aria-label={pinned ? `Unpin ${dim.dimension}` : `Pin ${dim.dimension}`}
        onClick={onTogglePin}
        className={cx(
          "absolute right-2 top-1/2 -translate-y-1/2 grid h-5 w-5 place-items-center rounded-sm transition-opacity",
          pinned
            ? "text-accent opacity-100"
            : "text-ink-3 opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:text-ink",
        )}
      >
        <IconPin className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

export function SidebarTableTree({ onNavigate }: { onNavigate?: () => void }) {
  const dims = useDimensions();
  const drafts = useDrafts();
  const { activeId, openTab } = useOpenTabs();
  const create = useCreateTableModal();
  const navigate = useNavigate();
  const [pinnedIds, togglePin] = usePinnedDims();
  const [q, setQ] = useState("");
  const activeDimId = activeId ? activeId.slice("tables:".length) : null;

  const dirtyDimIds = useMemo(() => {
    const s = new Set<string>();
    for (const d of Object.values(drafts)) s.add(d.dimId);
    return s;
  }, [drafts]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return dims.filter((d) => !needle || d.dimension.toLowerCase().includes(needle));
  }, [dims, q]);

  const pinned = filtered.filter((d) => pinnedIds.has(d.id));
  const unpinned = filtered.filter((d) => !pinnedIds.has(d.id));

  const openDim = (id: string) => {
    openTab(id);
    navigate("/app/tables");
    onNavigate?.();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pb-2 pt-1">
        <button
          type="button"
          onClick={create.open}
          className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-accent bg-accent px-3 py-1.5 font-display text-[12.5px] font-semibold text-accent-ink transition-colors hover:brightness-105"
        >
          <IconPlus className="h-3.5 w-3.5" /> New table
        </button>
      </div>

      <div className="shrink-0 flex items-center gap-2 border-y border-line px-3 py-2 text-ink-3">
        <IconSearch className="h-3.5 w-3.5" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter tables…"
          className="w-full bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-3"
        />
        {dims.length > 0 && (
          <span className="font-mono text-[10px] tabular-nums text-ink-3">{dims.length}</span>
        )}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {pinned.length > 0 && (
          <>
            <li className="px-3 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3">
              Pinned
            </li>
            {pinned.map((d) => (
              <DimRow
                key={d.id}
                dim={d}
                active={d.id === activeDimId}
                dirty={dirtyDimIds.has(d.id)}
                pinned
                onOpen={() => openDim(d.id)}
                onTogglePin={() => togglePin(d.id, false)}
              />
            ))}
            <li className="my-1 mx-3 border-t border-line" aria-hidden />
          </>
        )}
        {unpinned.map((d) => (
          <DimRow
            key={d.id}
            dim={d}
            active={d.id === activeDimId}
            dirty={dirtyDimIds.has(d.id)}
            pinned={false}
            onOpen={() => openDim(d.id)}
            onTogglePin={() => togglePin(d.id, true)}
          />
        ))}
        {filtered.length === 0 && (
          <li className="px-3 py-3 font-mono text-[11px] text-ink-3">no match</li>
        )}
      </ul>
    </div>
  );
}
