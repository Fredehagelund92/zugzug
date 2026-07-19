import type { ReactNode } from "react";

/* The page header for a settings screen: a small breadcrumb, the page title,
   a one-line subtitle, and optional trailing content (e.g. a status pill).
   Sits above the page's SettingsSections. No shadow — hairline separation
   only, per DESIGN.md §7. */
export function SettingsPageHeader({
  group = "Settings",
  title,
  subtitle,
  aside,
}: {
  /** Breadcrumb prefix — "Settings" for workspace settings, "Account" for the account area. */
  group?: string;
  title: string;
  subtitle?: string;
  /** Trailing content aligned to the right of the title block. */
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">
          {group} / {title}
        </div>
        <h1 className="mt-1.5 font-display text-[28px] font-bold leading-none tracking-tight text-ink">
          {title}
        </h1>
        {subtitle && <p className="mt-2 max-w-[56ch] text-[13px] text-ink-2">{subtitle}</p>}
      </div>
      {aside && <div className="shrink-0 pb-0.5">{aside}</div>}
    </div>
  );
}
