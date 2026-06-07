import { useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  separator?: boolean;
}

export function ContextMenu({
  items, x, y, onClose,
}: { items: MenuItem[]; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let top = y, left = x;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
    setPos({ top, left });
  }, [x, y]);

  return (
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 100 }}
      className="min-w-[180px] rounded-lg border border-line-2 bg-surface-elevated py-1 text-[12px] shadow-pop"
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => { item.onClick(); onClose(); }}
            className={cx(
              "block w-full px-3 py-1.5 text-left text-ink",
              item.disabled ? "cursor-not-allowed opacity-40" : "hover:bg-hover",
            )}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
