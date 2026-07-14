import { NavLink } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can, type Action } from "../../lib/permissions";
import { cx } from "../../lib/cx";
import {
  IconSettings,
  IconUsers,
  IconWand,
  IconDatabase,
  IconOctagonAlert,
  IconIntegrations,
} from "../Icons";
import type { SVGProps, ComponentType } from "react";

interface Item {
  label: string;
  to: string;
  action: Action;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

interface Section {
  label: string;
  items: Item[];
}

const SECTIONS: Section[] = [
  {
    label: "Workspace",
    items: [
      { label: "General", to: "general", action: "settings.general.view", Icon: IconSettings },
      { label: "Members", to: "members", action: "settings.members.view", Icon: IconUsers },
      { label: "Mapping", to: "mapping", action: "settings.matching.view", Icon: IconWand },
      {
        label: "Warehouse",
        to: "warehouse",
        action: "settings.warehouse.view",
        Icon: IconDatabase,
      },
    ],
  },
  {
    label: "Integrations",
    items: [
      {
        label: "Pull API",
        to: "pull-api",
        action: "integrations.pull_api.view",
        Icon: IconIntegrations,
      },
      {
        label: "Webhooks",
        to: "webhooks",
        action: "integrations.webhooks.view",
        Icon: IconIntegrations,
      },
      {
        label: "Service accounts",
        to: "service-accounts",
        action: "integrations.service_accounts.view",
        Icon: IconUsers,
      },
    ],
  },
  {
    label: "Danger",
    items: [
      { label: "Danger", to: "danger", action: "settings.danger.leave", Icon: IconOctagonAlert },
    ],
  },
];

function SideItem({ item }: { item: Item }) {
  return (
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
  );
}

export function SettingsSidebar() {
  const tenant = useTenant();

  return (
    <>
      <nav aria-label="Settings sections" className="space-y-5">
        {SECTIONS.map((section) => {
          const visible = section.items.filter((i) => can(tenant, i.action));
          if (visible.length === 0) return null;
          return (
            <div key={section.label}>
              <div className="flex items-center gap-3 px-3 pb-3 mb-1">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
                  {section.label}
                </span>
                <div className="flex-1 h-px bg-line" />
              </div>
              <div className="space-y-0.5">
                {visible.map((item) => (
                  <SideItem key={item.to} item={item} />
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="mt-5 border-t border-line pt-3">
        <NavLink
          to={`/app/${tenant.slug}/account/profile`}
          className="flex items-center gap-2.5 pl-3 pr-3 py-[7px] text-sm text-ink-2 hover:text-ink hover:bg-hover rounded-sm"
        >
          Your account →
        </NavLink>
      </div>
    </>
  );
}
