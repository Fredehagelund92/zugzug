import { Outlet } from "react-router-dom";
import { SettingsShell } from "./SettingsShell";
import { SettingsSidebar } from "./SettingsSidebar";
import { PageHeader } from "../PageHeader";

export function SettingsLayout() {
  return (
    <>
      <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8 md:pb-0">
        <PageHeader
          kicker="Workspace"
          title="Settings"
          lede="Changes are saved as you make them."
        />
      </div>
      <SettingsShell sidebar={<SettingsSidebar />}>
        <Outlet />
      </SettingsShell>
    </>
  );
}
