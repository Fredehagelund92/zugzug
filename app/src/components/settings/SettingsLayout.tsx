import { Outlet } from "react-router-dom";
import { SettingsShell } from "./SettingsShell";
import { SettingsSidebar } from "./SettingsSidebar";

/* Workspace settings frame. The sidebar is the only navigation to Mapping and
   Danger — without it mounted those two pages existed only as typed URLs.
   Mirrors Account (SettingsShell + its own sidebar), narrow `doc` column. */
export function SettingsLayout() {
  return (
    <SettingsShell max="doc" sidebar={<SettingsSidebar />}>
      <Outlet />
    </SettingsShell>
  );
}
