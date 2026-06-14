import { NavLink, Link } from "react-router-dom";
import { cx } from "../../lib/cx";
import { IconBuilding, IconUsers, IconAudit, IconDatabase } from "../Icons";
import type { SVGProps, ComponentType } from "react";

interface Item {
  label: string;
  to: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const ITEMS: Item[] = [
  { label: "Workspaces", to: "workspaces", Icon: IconBuilding },
  { label: "Users", to: "users", Icon: IconUsers },
  { label: "Audit", to: "audit", Icon: IconAudit },
  { label: "Warehouse", to: "warehouse", Icon: IconDatabase },
];

export function AdminSidebar() {
  return (
    <nav aria-label="Admin sections">
      {/* Group label — amber tint */}
      <div className="flex items-center gap-3 px-3 pb-3 mb-1">
        <span
          className="font-mono text-[10px] uppercase tracking-[0.18em]"
          style={{ color: "var(--accent-2)" }}
        >
          System
        </span>
        <div className="flex-1 h-px bg-line" />
      </div>

      <div className="space-y-0.5">
        {ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} end>
            {({ isActive }) => (
              <span
                className={cx(
                  "group relative flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm rounded-sm transition-all duration-150 w-full",
                  isActive
                    ? "text-ink"
                    : "text-ink-2 hover:text-ink hover:bg-hover hover:translate-x-[2px]",
                )}
                style={isActive ? { background: "var(--accent-2-soft)" } : undefined}
              >
                {isActive && (
                  <span
                    className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full"
                    style={{ background: "var(--accent-2)" }}
                  />
                )}
                <item.Icon
                  className={cx(
                    "h-3.5 w-3.5 shrink-0 transition-opacity",
                    isActive ? "opacity-100" : "opacity-60 group-hover:opacity-100",
                  )}
                  style={isActive ? { color: "var(--accent-2)" } : undefined}
                />
                <span className="font-body">{item.label}</span>
              </span>
            )}
          </NavLink>
        ))}
      </div>

      {/* Back to app */}
      <div className="mt-6 px-3">
        <Link
          to="/app"
          className="flex items-center gap-2 text-xs text-ink-3 hover:text-ink-2 transition-colors"
        >
          <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 12L6 8l4-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Back to app
        </Link>
      </div>
    </nav>
  );
}
