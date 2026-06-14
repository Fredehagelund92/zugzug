import { Outlet } from "react-router-dom";

export function SettingsLayout() {
  return (
    <div className="mx-auto w-full max-w-[var(--wide)] p-4 md:p-8">
      <Outlet />
    </div>
  );
}
