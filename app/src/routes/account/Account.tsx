import { Outlet } from "react-router-dom";
import { SettingsShell } from "../../components/settings/SettingsShell";
import { AccountSidebar } from "../../components/settings/AccountSidebar";
import { PageHeader } from "../../components/PageHeader";

export function Account() {
  return (
    <>
      <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8 md:pb-0">
        <PageHeader kicker="Personal" title="Account" lede="Your profile and preferences." />
      </div>
      <SettingsShell sidebar={<AccountSidebar />}>
        <Outlet />
      </SettingsShell>
    </>
  );
}
