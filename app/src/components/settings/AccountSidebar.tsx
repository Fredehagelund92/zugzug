import { NavLink } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { cx } from "../../lib/cx";
import { IconUser, IconLayers } from "../Icons";
import type { SVGProps, ComponentType } from "react";

interface Item {
  label: string;
  to: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const ITEMS: Item[] = [
  { label: "Profile", to: "profile", Icon: IconUser },
  { label: "Memberships", to: "memberships", Icon: IconLayers },
];

export function AccountSidebar() {
  const tenant = useTenant();
  return (
    <>
      <nav aria-label="Account sections">
        <div className="flex items-center gap-3 px-3 pb-3 mb-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
            Account
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
                      ? "text-accent bg-accent-soft"
                      : "text-ink-2 hover:text-ink hover:bg-hover hover:translate-x-[2px]",
                  )}
                >
                  {isActive && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent" />
                  )}
                  <item.Icon
                    className={cx(
                      "h-3.5 w-3.5 shrink-0 transition-opacity",
                      isActive ? "opacity-100" : "opacity-60 group-hover:opacity-100",
                    )}
                  />
                  <span className="font-body">{item.label}</span>
                </span>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

      <div className="mt-5 border-t border-line pt-3">
        <NavLink
          to={`/app/${tenant.slug}/settings/general`}
          className="flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm text-ink-2 hover:text-ink hover:bg-hover rounded-sm"
        >
          Workspace settings →
        </NavLink>
      </div>
    </>
  );
}
