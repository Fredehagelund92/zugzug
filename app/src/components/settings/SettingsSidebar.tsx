import { NavLink } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can, type Action } from "../../lib/permissions";
import { cx } from "../../lib/cx";

interface Item {
  label: string;
  to: string;
  action: Action;
}

const ITEMS: Item[] = [
  { label: "General", to: "general", action: "settings.general.view" },
  { label: "Members", to: "members", action: "settings.members.view" },
  { label: "Matching", to: "matching", action: "settings.matching.view" },
  { label: "Warehouse", to: "warehouse", action: "settings.warehouse.view" },
  { label: "Danger", to: "danger", action: "settings.danger.leave" },
];

export function SettingsSidebar() {
  const tenant = useTenant();
  const visible = ITEMS.filter((i) => can(tenant, i.action));

  return (
    <nav aria-label="Settings sections">
      <div className="flex items-center gap-3 px-3 pb-3 mb-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
          Workspace
        </span>
        <div className="flex-1 h-px bg-line" />
      </div>

      <div className="space-y-0.5">
        {visible.map((item, i) => (
          <NavLink key={item.to} to={item.to} end>
            {({ isActive }) => (
              <span
                className={cx(
                  "relative flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm rounded-sm transition-all duration-150 w-full",
                  isActive
                    ? "text-accent bg-accent-soft"
                    : "text-ink-2 hover:text-ink hover:bg-hover hover:translate-x-[2px]",
                )}
              >
                {isActive && (
                  <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent" />
                )}
                <span
                  className={cx(
                    "font-mono text-[10px] tabular-nums w-[18px] text-right shrink-0 transition-colors",
                    isActive ? "text-accent/70" : "text-ink-3",
                  )}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="font-body">{item.label}</span>
              </span>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
