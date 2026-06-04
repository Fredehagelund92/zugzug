import type { ReactNode } from "react";

/* PageHeader — one shape for every route masthead.
   Kicker (mono uppercase) + h1 + optional lede + optional right-side action +
   optional meta row below the title (status bar, counts, breadcrumbs). The
   `backdrop` slot is for a decorative SVG that bleeds into the corner. */
export function PageHeader({
  kicker,
  title,
  lede,
  action,
  meta,
  backdrop,
}: {
  kicker?: string;
  title: ReactNode;
  lede?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
  backdrop?: ReactNode;
}) {
  return (
    <div className="zz-rise relative overflow-hidden">
      {backdrop}
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {kicker && (
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">
              {kicker}
            </div>
          )}
          <h1 className="mt-1.5 font-display text-[clamp(30px,4vw,44px)] font-extrabold leading-[0.95] tracking-[-0.035em] text-ink">
            {title}
          </h1>
          {lede && <p className="mt-2 max-w-2xl text-[14px] text-ink-2">{lede}</p>}
          {meta && <div className="mt-3">{meta}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}
