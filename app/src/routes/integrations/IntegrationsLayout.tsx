import { Outlet } from "react-router-dom";
import { SettingsShell } from "../../components/settings/SettingsShell";
import { IntegrationsSidebar } from "../../components/integrations/IntegrationsSidebar";

export function IntegrationsLayout() {
  return (
    <SettingsShell sidebar={<IntegrationsSidebar />}>
      <Outlet />
    </SettingsShell>
  );
}
