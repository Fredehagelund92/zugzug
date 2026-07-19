import { Outlet, useOutletContext } from "react-router-dom";
import { SettingsShell } from "../../components/settings/SettingsShell";
import { AccountSidebar } from "../../components/settings/AccountSidebar";
import { PageHeader } from "../../components/PageHeader";
import { PageContainer } from "../../components/PageContainer";
import type { Membership } from "../../components/TenantLayout";

export function Account() {
  const ctx = useOutletContext<{ memberships: Membership[] }>();
  return (
    <>
      <PageContainer max="doc" className="md:pb-0">
        <PageHeader kicker="Personal" title="Account" lede="Your profile and preferences." />
      </PageContainer>
      <SettingsShell max="doc" sidebar={<AccountSidebar />}>
        <Outlet context={ctx} />
      </SettingsShell>
    </>
  );
}
