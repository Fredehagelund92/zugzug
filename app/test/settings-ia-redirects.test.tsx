import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Navigate } from "react-router-dom";
import { TenantProvider } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";
import { SettingsLayout } from "../src/components/settings/SettingsLayout";
import { WebhookDetailRedirect } from "../src/routes/integrations/WebhookDetailRedirect";

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

vi.mock("../src/lib/integrations-api", () => ({
  listRefTables: vi.fn().mockResolvedValue([]),
  listWebhooks: vi.fn().mockResolvedValue([]),
  listServiceAccounts: vi.fn().mockResolvedValue([]),
  getWebhook: vi.fn().mockResolvedValue({
    id: "wh-1",
    url: "https://example.com/hook",
    events: ["draft.published"],
    status: "active",
    secret_prefix: "whsec_abc",
    secret_previous_expires_at: null,
    secret_prefix_previous: null,
    description: null,
    disabled_reason: null,
  }),
  humanError: (code: string) => code,
  IntegrationsApiError: class IntegrationsApiError extends Error {},
}));

const tenant = tenantFixture("admin");

function Stub({ name }: { name: string }) {
  return <div data-testid="page">{name}</div>;
}

describe("Settings IA redirects", () => {
  it("integrations/pull-api redirects to settings/pull-api", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/integrations/pull-api"]}>
        <TenantProvider value={tenant}>
          <Routes>
            <Route path="/app/:slug">
              <Route path="settings" element={<SettingsLayout />}>
                <Route index element={<Navigate to="general" replace />} />
                <Route path="pull-api" element={<Stub name="pull-api" />} />
              </Route>
              <Route path="integrations">
                <Route
                  path="pull-api"
                  element={<Navigate to="../../settings/pull-api" replace />}
                />
              </Route>
            </Route>
          </Routes>
        </TenantProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("page").textContent).toBe("pull-api");
  });

  it("integrations/webhooks redirects to settings/webhooks", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/integrations/webhooks"]}>
        <TenantProvider value={tenant}>
          <Routes>
            <Route path="/app/:slug">
              <Route path="settings" element={<SettingsLayout />}>
                <Route index element={<Navigate to="general" replace />} />
                <Route path="webhooks" element={<Stub name="webhooks" />} />
              </Route>
              <Route path="integrations">
                <Route
                  path="webhooks"
                  element={<Navigate to="../../settings/webhooks" replace />}
                />
              </Route>
            </Route>
          </Routes>
        </TenantProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("page").textContent).toBe("webhooks");
  });

  it("integrations/webhooks/:id redirects preserving the id", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/integrations/webhooks/wh-1"]}>
        <TenantProvider value={tenant}>
          <Routes>
            <Route path="/app/:slug">
              <Route path="settings" element={<SettingsLayout />}>
                <Route index element={<Navigate to="general" replace />} />
                <Route path="webhooks/:id" element={<Stub name="webhook-detail" />} />
              </Route>
              <Route path="integrations">
                <Route path="webhooks/:id" element={<WebhookDetailRedirect />} />
              </Route>
            </Route>
          </Routes>
        </TenantProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("page").textContent).toBe("webhook-detail");
  });

  it("integrations/service-accounts redirects to settings/service-accounts", () => {
    render(
      <MemoryRouter initialEntries={["/app/acme/integrations/service-accounts"]}>
        <TenantProvider value={tenant}>
          <Routes>
            <Route path="/app/:slug">
              <Route path="settings" element={<SettingsLayout />}>
                <Route index element={<Navigate to="general" replace />} />
                <Route path="service-accounts" element={<Stub name="service-accounts" />} />
              </Route>
              <Route path="integrations">
                <Route
                  path="service-accounts"
                  element={<Navigate to="../../settings/service-accounts" replace />}
                />
              </Route>
            </Route>
          </Routes>
        </TenantProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("page").textContent).toBe("service-accounts");
  });
});
