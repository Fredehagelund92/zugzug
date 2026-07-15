import React, {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "../lib/cx";
import { Button } from "./Button";

/* ToolbarMenu — a small portal-anchored dropdown for toolbar overflow / grouped
   actions. Mirrors the positioning + outside-click pattern used by
   datagrid/ColumnHeaderMenu, but with a simpler flat item list. Every colour,
   radius and shadow resolves to a brand token (no hex, no dark: variants). */

const MenuCtx = React.createContext<() => void>(() => {});

const MIN_WIDTH = 244;
const GAP = 6;

export function ToolbarMenu({
  label,
  leading,
  title,
  className,
  children,
}: {
  /** Text label; when present a ▾ caret is appended. Omit for an icon-only trigger. */
  label?: ReactNode;
  /** Glyph/icon rendered before the label. */
  leading?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={anchorRef}
        variant="ghost"
        size="sm"
        title={title}
        aria-label={label == null ? title : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cx(open && "bg-hover text-ink", className)}
      >
        {leading}
        {label}
        {label != null && <span className="ml-0.5 text-[9px] text-ink-3">▾</span>}
      </Button>
      {open && (
        <MenuPortal anchorRef={anchorRef} onClose={() => setOpen(false)}>
          {children}
        </MenuPortal>
      )}
    </>
  );
}

function MenuPortal({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Fixed-position, right-aligned to the trigger, flipping up when it would
  // overflow the viewport bottom. Rendered in a portal so it escapes the
  // sticky toolbar's stacking context.
  useLayoutEffect(() => {
    const pop = ref.current;
    if (!pop) return;
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      if (!pop || !a) return;
      const w = Math.max(pop.offsetWidth, MIN_WIDTH);
      const h = pop.offsetHeight;
      let left = a.right - w;
      if (left < 8) left = 8;
      if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
      let top = a.bottom + GAP;
      if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - GAP - h);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef]);

  // Close on outside click (skipping the trigger) or Escape.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const pop = ref.current;
      const anchor = anchorRef.current;
      const t = e.target as Node;
      if (pop && pop.contains(t)) return;
      if (anchor && anchor.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorRef]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: "fixed", top: 0, left: 0, minWidth: MIN_WIDTH }}
      className="zz-pop-in z-40 rounded-sm border border-line-2 bg-surface-elevated p-1.5 shadow-pop"
    >
      <MenuCtx.Provider value={onClose}>{children}</MenuCtx.Provider>
    </div>,
    document.body,
  );
}

export function MenuSection({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-3">
      {children}
    </div>
  );
}

export function MenuSep() {
  return <div className="my-1 h-px bg-line" />;
}

const itemBase =
  "flex w-full items-start gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-hover";

export function MenuItem({
  glyph,
  title,
  desc,
  danger,
  href,
  download,
  onClick,
}: {
  glyph?: ReactNode;
  title: ReactNode;
  desc?: ReactNode;
  danger?: boolean;
  /** When set the item renders as a download anchor (used for snapshot). */
  href?: string;
  download?: string;
  onClick?: () => void;
}) {
  const close = useContext(MenuCtx);
  const handle = () => {
    onClick?.();
    close();
  };
  const body = (
    <>
      {glyph != null && (
        <span
          className={cx(
            "mt-px w-4 shrink-0 text-center text-[13px] leading-none",
            danger ? "text-accent-2" : "text-ink-3",
          )}
        >
          {glyph}
        </span>
      )}
      <span className="min-w-0">
        <span
          className={cx(
            "block text-[12.5px] font-semibold leading-tight",
            danger ? "text-accent-2" : "text-ink",
          )}
        >
          {title}
        </span>
        {desc != null && (
          <span className="mt-0.5 block text-[11px] leading-snug text-ink-3">{desc}</span>
        )}
      </span>
    </>
  );
  if (href) {
    return (
      <a role="menuitem" href={href} download={download} className={itemBase} onClick={handle}>
        {body}
      </a>
    );
  }
  return (
    <button type="button" role="menuitem" className={itemBase} onClick={handle}>
      {body}
    </button>
  );
}
