import { useEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";
import { IconPlus, IconCheck, IconX, IconChevron, IconSearch } from "./Icons";
import { slug } from "../store";
import { useEngineerMode } from "../lib/engineer-mode";
import type { MappingDimension } from "../data";

/* DimensionPicker — a searchable switcher for the master-data dimension you're
   working in (+ create a new dim_* / map_* pair). Compact + type-to-find, so it
   scales from 3 to 300 dimensions without wrapping or blind scrolling. */

function stats(d: MappingDimension) {
  const total = d.values.length;
  const mapped = d.values.filter((v) => v.current).length;
  const fresh = d.values.filter((v) => v.status === "new").length;
  return { total, fresh, pct: total ? Math.round((mapped / total) * 100) : 0 };
}

function Mono({ label, active }: { label: string; active?: boolean }) {
  return (
    <div className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-sm font-display text-[13px] font-bold", active ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent")}>
      {label.charAt(0).toUpperCase()}
    </div>
  );
}

export function DimensionPicker({
  dims,
  activeId,
  onSelect,
  onCreate,
}: {
  dims: MappingDimension[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string, keyKind: "slug" | "external_id") => void;
}) {
  const { engineer } = useEngineerMode();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [externalId, setExternalId] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const close = () => { setOpen(false); setCreating(false); setQ(""); setName(""); setExternalId(false); };
  const active = dims.find((d) => d.id === activeId) ?? dims[0];
  const list = dims.filter((d) => d.dimension.toLowerCase().includes(q.toLowerCase().trim()));
  const submit = () => { if (!name.trim()) return; onCreate(name.trim(), externalId ? "external_id" : "slug"); close(); };
  const choose = (id: string) => { onSelect(id); close(); };

  const aStats = stats(active);

  return (
    <div ref={ref} className="relative inline-block">
      {/* trigger */}
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={cx("flex min-w-[260px] items-center gap-2.5 rounded-md border bg-surface px-3 py-2 text-left transition-colors", open ? "border-accent" : "border-line-2 hover:border-accent")}>
        <Mono label={active.dimension} active />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-display text-[14px] font-semibold text-ink">{active.dimension}</span>
            {aStats.fresh > 0 && <span className="shrink-0 rounded-pill bg-warn-soft px-1.5 font-mono text-[10px] text-warn">{aStats.fresh} new</span>}
          </div>
          <div className="truncate font-mono text-[10px] text-ink-3">
            {engineer ? active.mapTable : `${aStats.total - aStats.fresh} mapped · ${aStats.fresh} new`}
          </div>
        </div>
        <IconChevron className={cx("h-4 w-4 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1.5 w-[320px] overflow-hidden rounded-md border border-line-2 bg-surface shadow-pop">
          {!creating ? (
            <>
              <div className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-ink-3">
                <IconSearch className="h-3.5 w-3.5" />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a dimension…"
                  className="w-full bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3" />
              </div>
              <ul className="max-h-72 overflow-y-auto py-1">
                {list.map((d) => {
                  const s = stats(d);
                  const on = d.id === activeId;
                  return (
                    <li key={d.id}>
                      <button type="button" onClick={() => choose(d.id)} className={cx("flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors", on ? "bg-accent-wash" : "hover:bg-hover")}>
                        <Mono label={d.dimension} active={on} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className={cx("truncate font-display text-[13.5px] font-semibold", on ? "text-accent" : "text-ink")}>{d.dimension}</span>
                            {s.fresh > 0 && <span className="shrink-0 rounded-pill bg-warn-soft px-1.5 font-mono text-[10px] text-warn">{s.fresh}</span>}
                          </div>
                          <div className="truncate font-mono text-[10px] text-ink-3">
                            {engineer ? d.mapTable : `${s.total - s.fresh} mapped · ${s.fresh} new`}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[10px] text-ink-3 tabular-nums">{s.total ? `${s.pct}%` : "empty"}</span>
                        {on && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
                      </button>
                    </li>
                  );
                })}
                {list.length === 0 && <li className="px-3 py-3 font-mono text-[12px] text-ink-3">no match</li>}
              </ul>
              <button type="button" onClick={() => setCreating(true)} className="flex w-full items-center gap-2 border-t border-line px-3 py-2.5 font-mono text-[12px] text-accent transition-colors hover:bg-accent-wash">
                <IconPlus className="h-4 w-4" /> New dimension
              </button>
            </>
          ) : (
            <div className="p-3">
              <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-3">New dimension</div>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => (e.key === "Enter" ? submit() : e.key === "Escape" && setCreating(false))}
                placeholder="e.g. Currency"
                className="w-full rounded-sm border border-line-2 bg-bg px-2.5 py-1.5 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent" />
              <div className="mt-2 font-mono text-[10px] leading-relaxed text-ink-3">
                {engineer
                  ? <>creates <span className="text-ink-2">zugzug.dim_{slug(name) || "…"}</span> + <span className="text-ink-2">zugzug.map_{slug(name) || "…"}</span></>
                  : <>Creates a new master list{name.trim() ? <> called <span className="text-ink-2">"{name.trim()}"</span></> : ""}</>}
              </div>
              <label className="mt-2.5 flex items-center gap-2 font-mono text-[11px] text-ink-2">
                <input type="checkbox" checked={externalId} onChange={(e) => setExternalId(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
                Key is an external ID (resolve names live)
              </label>
              <div className="mt-2.5 flex items-center gap-2">
                <button type="button" onClick={submit} disabled={!name.trim()} className="flex items-center gap-1.5 rounded-sm bg-accent px-2.5 py-1.5 font-mono text-[11px] text-accent-ink disabled:opacity-50">
                  <IconCheck className="h-3.5 w-3.5" /> Create
                </button>
                <button type="button" onClick={() => { setCreating(false); setName(""); }} className="grid h-7 w-7 place-items-center rounded-sm border border-line-2 text-ink-3 hover:border-danger hover:text-danger">
                  <IconX className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
