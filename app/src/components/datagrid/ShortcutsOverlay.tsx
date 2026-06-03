import { useEffect } from "react";
import { cx } from "../../lib/cx";

/* ShortcutsOverlay — '?' opens this modal. Grouped by surface so users learn
   the keys for the page they're on without scanning irrelevant bindings. */

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: "Grid",
    rows: [
      ["↑ ↓ ← →", "move cursor"],
      ["Enter", "edit / commit"],
      ["Tab / Shift+Tab", "commit + move →/←"],
      ["Esc", "cancel edit"],
      ["Space", "toggle row selection"],
      ["⌘A", "select all visible"],
      ["⌘⌫", "remove selected"],
      ["/", "focus filter"],
    ],
  },
  {
    title: "Mapping",
    rows: [
      ["A", "accept suggestion"],
      ["M", "pick master"],
      ["S", "skip"],
      ["R", "reset draft"],
      ["⌘↵", "publish staged drafts"],
    ],
  },
  {
    title: "Global",
    rows: [
      ["⌘Z", "undo"],
      ["⌘⇧Z", "redo"],
      ["?", "this overlay"],
    ],
  },
];

export function ShortcutsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-6" onClick={onClose}>
      <div className="w-[560px] max-w-full rounded-lg border border-line-2 bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-[18px] font-semibold text-ink">Keyboard shortcuts</h2>
          <button type="button" className="font-mono text-[11px] text-ink-3 hover:text-ink" onClick={onClose}>esc</button>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{g.title}</div>
              <ul className="mt-1.5 space-y-1.5">
                {g.rows.map(([k, v]) => (
                  <li key={k} className="flex items-center justify-between gap-2 text-[11.5px] text-ink-2">
                    <span><Kbd>{k}</Kbd></span>
                    <span className="text-right">{v}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span className={cx(
    "inline-block rounded border-[1px] border-b-2 border-line-2 bg-surface-2 px-1.5 py-0.5",
    "font-mono text-[10.5px] text-ink",
  )}>{children}</span>;
}
