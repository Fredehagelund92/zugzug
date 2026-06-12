import { Link, useLocation } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can, type Action } from "../../lib/permissions";
import { cx } from "../../lib/cx";

interface Item {
  label: string;
  to: string;
  action: Action;
}

const ITEMS: Item[] = [
  { label: "General",    to: "general",    action: "settings.general.view" },
  { label: "Members",    to: "members",    action: "settings.members.view" },
  { label: "Tokens",     to: "tokens",     action: "settings.tokens.view" },
  { label: "Scans",      to: "scans",      action: "settings.scans.view" },
  { label: "Matching",   to: "matching",   action: "settings.matching.view" },
  { label: "Warehouse",  to: "warehouse",  action: "settings.warehouse.view" },
  { label: "Appearance", to: "appearance", action: "settings.appearance.edit" },
  { label: "Audit",      to: "audit",      action: "settings.audit.view" },
  { label: "Danger",     to: "danger",     action: "settings.danger.leave" },
];

export function SettingsSidebar() {
  const tenant = useTenant();
  const location = useLocation();
  const visible = ITEMS.filter((i) => can(tenant, i.action));

  return (
    <nav aria-label="Settings sections" className="space-y-1">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-3 px-3 pb-2">
        Workspace
      </div>
      {visible.map((item) => {
        const isActive = location.pathname.endsWith(item.to);
        return (
          <Link
            key={item.to}
            to={item.to}
            className={cx(
              "block px-3 py-1.5 text-sm font-body transition-colors rounded-sm",
              isActive
                ? "bg-surface-2 text-ink"
                : "text-ink-2 hover:text-ink hover:bg-hover",
            )}
            aria-current={isActive ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
