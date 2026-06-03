import { useEffect, useRef, useState } from "react";
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const norm = q.trim();
  const list = options.filter((o) => o.toLowerCase().includes(norm.toLowerCase()));
  const canCreate = allowCreate && norm.length > 0 && !options.some((o) => o.toLowerCase() === norm.toLowerCase());

  const choose = (v: string) => {
    onPick(v);
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={ref} className="relative w-full min-w-[150px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          "flex w-full items-center justify-between gap-2 rounded-sm border px-2.5 py-1.5 text-[12.5px] transition-colors",
          value ? "border-line-2 font-medium text-accent hover:border-accent" : "border-dashed border-line-2 font-mono text-ink-3 hover:border-accent hover:text-ink-2",
        )}
      >
        <span className="truncate">{value ?? (suggestion ? `${suggestion}?` : placeholder)}</span>
        <IconChevron className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1 w-60 overflow-hidden rounded-sm border border-line-2 bg-surface shadow-pop">
          <div className="flex items-center gap-2 border-b border-line px-2.5 py-2 text-ink-3">
            <IconSearch className="h-3.5 w-3.5" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (list[0] ? choose(list[0]) : canCreate && choose(norm))}
              placeholder="Search or create…"
              className="w-full bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-ink-3"
            />
          </div>
          <ul className="max-h-52 overflow-auto py-1">
            {list.map((o) => (
              <li key={o}>
                <button
                  type="button"
                  onClick={() => choose(o)}
                  className={cx("flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-hover", o === value ? "text-accent" : "text-ink")}
                >
                  <span className="truncate">{o}</span>
                  {o === suggestion && <span className="text-accent-2">★</span>}
                </button>
              </li>
            ))}
            {canCreate && (
              <li>
                <button type="button" onClick={() => choose(norm)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-accent transition-colors hover:bg-hover">
                  <IconPlus className="h-3.5 w-3.5" /> Create “{norm}”
                </button>
              </li>
            )}
            {list.length === 0 && !canCreate && <li className="px-2.5 py-2 font-mono text-[12px] text-ink-3">no match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
