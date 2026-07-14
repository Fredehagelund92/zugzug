import { Outlet } from "react-router-dom";
import { PageContainer } from "../PageContainer";

export function SettingsLayout() {
  return (
    <PageContainer>
      <Outlet />
    </PageContainer>
  );
}
