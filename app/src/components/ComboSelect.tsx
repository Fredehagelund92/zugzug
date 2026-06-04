import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "../lib/cx";
import { IconSearch, IconChevron, IconPlus } from "./Icons";

/* ComboSelect — generic searchable popover over string options, with optional
   "create new value". Used to map a distinct source value to a canonical value
   (or coin a new one). Squared, token-driven, no hex. */
export function ComboSelect({
  options,
  value,
  suggestion = null,
  placeholder = "Select…",
  allowCreate = false,
  onPick,
}: {
  options: string[];
  value: string | null;
  suggestion?: string | null;
  placeholder?: string;
  allowCreate?: boolean;
  onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const norm = q.trim();
  const list = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(norm.toLowerCase())),
    [options, norm],
  );
  const canCreate =
    allowCreate && norm.length > 0 && !options.some((o) => o.toLowerCase() === norm.toLowerCase());
  const total = list.length + (canCreate ? 1 : 0);

  // When the options narrow under us, keep the highlight in bounds. When the
  // dropdown opens, prefer the suggestion row so a single Enter accepts it.
  useEffect(() => {
    if (!open) return;
    const sIdx = suggestion ? list.indexOf(suggestion) : -1;
    setHighlight(sIdx >= 0 ? sIdx : 0);
  }, [open, suggestion, options]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, total - 1)));
  }, [total]);

  // Keep the highlighted row scrolled into view as the user arrows through it.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${highlight}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const choose = (v: string) => {
    onPick(v);
    setOpen(false);
    setQ("");
    triggerRef.current?.focus();
  };

  const pickHighlighted = () => {
    if (highlight < list.length) choose(list[highlight]);
    else if (canCreate) choose(norm);
  };

  return (
    <div ref={ref} className="relative w-full min-w-[150px]">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cx(
          "flex w-full items-center justify-between gap-2 rounded-sm border px-2.5 py-1.5 text-[12.5px] transition-colors",
          value
            ? "border-line-2 font-medium text-accent hover:border-accent"
            : "border-dashed border-line-2 font-mono text-ink-3 hover:border-accent hover:text-ink-2",
        )}
      >
        <span className="truncate">{value ?? (suggestion ? `${suggestion}?` : placeholder)}</span>
        <IconChevron className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="zz-pop-in absolute left-0 z-50 mt-1 w-60 overflow-hidden rounded-sm border border-line-2 bg-surface-elevated shadow-pop">
          <div className="flex items-center gap-2 border-b border-line px-2.5 py-2 text-ink-3">
            <IconSearch className="h-3.5 w-3.5" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              role="combobox"
              aria-expanded
              aria-controls={listboxId}
              aria-activedescendant={total > 0 ? `${listboxId}-${highlight}` : undefined}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlight((h) => (total === 0 ? 0 : (h + 1) % total));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlight((h) => (total === 0 ? 0 : (h - 1 + total) % total));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  pickHighlighted();
                } else if (e.key === "Tab") {
                  setOpen(false);
                  triggerRef.current?.focus();
                  // intentional: don't preventDefault — let the natural Tab move to next focusable
                }
              }}
              placeholder="Search or create…"
              className="w-full bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-3"
            />
          </div>
          <ul ref={listRef} id={listboxId} role="listbox" className="max-h-52 overflow-auto py-1">
            {list.map((o, i) => (
              <li key={o}>
                <button
                  type="button"
                  id={`${listboxId}-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={i === highlight}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(o)}
                  className={cx(
                    "flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                    i === highlight ? "bg-hover" : "",
                    o === value ? "text-accent" : "text-ink",
                  )}
                >
                  <span className="truncate">{o}</span>
                  {o === suggestion && <span className="text-accent-2">★</span>}
                </button>
              </li>
            ))}
            {canCreate && (
              <li>
                <button
                  type="button"
                  id={`${listboxId}-${list.length}`}
                  data-idx={list.length}
                  role="option"
                  aria-selected={list.length === highlight}
                  onMouseEnter={() => setHighlight(list.length)}
                  onClick={() => choose(norm)}
                  className={cx(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-accent transition-colors",
                    list.length === highlight ? "bg-hover" : "",
                  )}
                >
                  <IconPlus className="h-3.5 w-3.5" /> Create “{norm}”
                </button>
              </li>
            )}
            {list.length === 0 && !canCreate && (
              <li className="px-2.5 py-2 font-mono text-[12px] text-ink-2">no match</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
