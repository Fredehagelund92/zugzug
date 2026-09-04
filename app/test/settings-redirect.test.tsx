import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
import { TenantProvider } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";
import { SettingsLayout } from "../src/components/settings/SettingsLayout";

vi.mock("../src/store", async (orig) => {
  const a = await orig<typeof import("../src/store")>();
  return {
    ...a,
    useWorkspaceInfo: () => ({ adapter: "duckdb", writable: false }),
    useRefTables: () => [],
    useAudit: () => [],
    useConnectionHealth: () => undefined,
    usePreferences: () => ({ scanSchedule: null }),
  };
});

function Stub({ name }: { name: string }) {
  return <div data-testid="active">{name}</div>;
}

describe("Settings redirect", () => {
  test("/settings → /settings/general for admin", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/settings"]}>
        <TenantProvider value={tenantFixture("admin")}>
          <Routes>
            <Route path="/app/:slug/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<Stub name="general" />} />
            </Route>
          </Routes>
        </TenantProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("active").textContent).toBe("general");
  });
});
