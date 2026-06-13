import type { ReactNode } from "react";

export function PageHeader({
  kicker,
  title,
  lede,
  action,
  meta,
  backdrop,
  count,
}: {
  kicker?: string;
  title: ReactNode;
  lede?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
  backdrop?: ReactNode;
  count?: number;
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
          <div className="mt-1.5 flex items-center gap-3">
            <h1 className="font-display text-[clamp(30px,4vw,44px)] font-extrabold leading-[0.95] tracking-[-0.035em] text-ink">
              {title}
            </h1>
            {count !== undefined && (
              <span
                data-testid="page-header-count"
                className="font-mono text-xs tabular-nums bg-surface-2 border border-line text-ink-3 px-2 py-0.5"
              >
                {count}
              </span>
            )}
          </div>
          {lede && <p className="mt-2 max-w-2xl text-[14px] text-ink-2">{lede}</p>}
          {meta && <div className="mt-3">{meta}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}
