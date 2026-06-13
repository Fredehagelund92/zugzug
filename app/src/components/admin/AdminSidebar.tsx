import { NavLink } from "react-router-dom";
import { cx } from "../../lib/cx";

const ITEMS = [
  { label: "Workspaces", to: "workspaces" },
  { label: "Users", to: "users" },
  { label: "Audit", to: "audit" },
  { label: "Warehouses", to: "warehouses" },
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
        {ITEMS.map((item, i) => (
          <NavLink key={item.to} to={item.to} end>
            {({ isActive }) => (
              <span
                className={cx(
                  "relative flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm rounded-sm transition-all duration-150 w-full",
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
                <span
                  className={cx(
                    "font-mono text-[10px] tabular-nums w-[18px] text-right shrink-0 transition-colors",
                    isActive ? "text-ink-3" : "text-ink-3",
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

      {/* Back to app */}
      <div className="mt-6 px-3">
        <a
          href="/app"
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
        </a>
      </div>
    </nav>
  );
}
