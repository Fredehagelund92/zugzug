import type { ReactNode } from "react";

export function EmptyState({
  title,
  body,
  action,
  secondary,
  glyph,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  secondary?: ReactNode;
  glyph?: ReactNode;
}) {
  return (
    <div className="border border-line bg-surface-2/40 px-6 py-12 text-center">
      {glyph && <div className="mx-auto mb-4 grid place-items-center text-ink-3">{glyph}</div>}
      <h3 className="font-display text-base font-bold text-ink">{title}</h3>
      {body && <p className="mx-auto mt-1.5 max-w-md text-[13px] text-ink-2">{body}</p>}
      {(action || secondary) && (
        <div className="mt-5 flex flex-col items-center gap-2">
          {action}
          {secondary && <div className="font-mono text-[11px] text-ink-3">{secondary}</div>}
        </div>
      )}
    </div>
  );
}
