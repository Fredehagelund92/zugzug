import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx";

export interface MenuItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  separator?: boolean;
  icon?: React.ReactNode;
  shortcut?: string;
}

export function ContextMenu({
  items,
  x,
  y,
  onClose,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let top = y,
      left = x;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
    setPos({ top, left });
  }, [x, y]);

  return createPortal(
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
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={cx(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink",
              item.disabled ? "cursor-not-allowed opacity-40" : "hover:bg-hover",
            )}
          >
            {item.icon && (
              <span className="h-3.5 w-3.5 shrink-0 text-ink-3">{item.icon}</span>
            )}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="ml-2 shrink-0 font-mono text-[10px] text-ink-3">{item.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
