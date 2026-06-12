import { NavLink } from "react-router-dom";
import { cx } from "../../lib/cx";

const ITEMS = [
  { label: "Profile",       to: "profile" },
  { label: "Appearance",    to: "appearance" },
  { label: "Notifications", to: "notifications" },
];

export function AccountSidebar() {
  return (
    <nav aria-label="Account sections" className="space-y-1">
      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-3 px-3 pb-2">
        Account
      </div>
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end
          className={({ isActive }) =>
            cx(
              "block px-3 py-1.5 text-sm font-body transition-colors rounded-sm",
              isActive
                ? "bg-surface-2 text-ink"
                : "text-ink-2 hover:text-ink hover:bg-hover",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
