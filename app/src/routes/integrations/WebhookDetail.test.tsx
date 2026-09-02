import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, Outlet, Navigate } from "react-router-dom";
import { showKidBadge, WebhookDetail } from "./WebhookDetail";
import { can } from "../../lib/permissions";
import { TenantProvider } from "../../lib/tenant-context";
import { tenantFixture } from "../../../test/tenant-fixture";
import { getWebhook, listDeliveries, type Webhook } from "../../lib/integrations-api";

vi.mock("../../lib/integrations-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/integrations-api")>()),
  getWebhook: vi.fn(),
  listDeliveries: vi.fn(),
}));

const WEBHOOK: Webhook = {
  id: "wh_1",
  url: "https://example.test/wh",
  events: ["table.published"],
  status: "active",
  description: null,
  secret_prefix: "whsec_abc123",
  secret_prefix_previous: null,
  secret_previous_expires_at: null,
  created_at: "2026-09-01T10:00:00",
  created_by: "u_1",
  paused_at: null,
  disabled_at: null,
  disabled_reason: null,
  last_delivery_at: null,
  last_delivery_status: null,
  queued_count: 0,
};

describe("viewer payload masking", () => {
  it("viewer cannot view delivery payload", () => {
    expect(can(tenantFixture("viewer"), "integrations.webhooks.delivery_payload_view")).toBe(false);
  });
  it("editor can view delivery payload", () => {
    expect(can(tenantFixture("editor"), "integrations.webhooks.delivery_payload_view")).toBe(true);
  });
});

describe("kid badge visibility", () => {
  it("hides badge in steady state (no previous secret)", () => {
    expect(showKidBadge(null)).toBe(false);
  });
  it("shows badge during 24h grace window", () => {
    const future = new Date(Date.now() + 60 * 1000).toISOString();
    expect(showKidBadge(future)).toBe(true);
  });
  it("hides badge after grace expiry", () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(showKidBadge(past)).toBe(false);
  });
});

/* Relative links resolve by ROUTE hierarchy, not URL: the route is
   `settings > webhooks/:id`, so `to=".."` landed on `settings`, whose index
   redirects to General. Both back-links promise the webhooks list, so they must
   point at it explicitly. */
describe("back-links", () => {
  function renderDetail() {
    vi.mocked(getWebhook).mockResolvedValue(WEBHOOK);
    vi.mocked(listDeliveries).mockResolvedValue([]);
    return render(
      <TenantProvider value={tenantFixture("admin")}>
        <MemoryRouter initialEntries={["/app/acme/settings/webhooks/wh_1"]}>
          <Routes>
            <Route path="/app/:tenantSlug/*" element={<Outlet />}>
              <Route path="settings" element={<Outlet />}>
                <Route index element={<Navigate to="general" replace />} />
                <Route path="general" element={<div>SETTINGS GENERAL</div>} />
                <Route path="webhooks" element={<div>WEBHOOKS LIST</div>} />
                <Route path="webhooks/:id" element={<WebhookDetail />} />
              </Route>
            </Route>
          </Routes>
        </MemoryRouter>
      </TenantProvider>,
    );
  }

  it("the header link goes to the webhooks list, not Settings → General", async () => {
    renderDetail();
    const back = await screen.findByRole("link", { name: /Webhooks/ });
    expect(back).toHaveAttribute("href", "/app/acme/settings/webhooks");
    await userEvent.click(back);
    expect(await screen.findByText("WEBHOOKS LIST")).toBeInTheDocument();
  });

  it("the signing-recipe link goes to the webhooks list too", async () => {
    renderDetail();
    const recipe = await screen.findByRole("link", { name: "signing recipe" });
    expect(recipe).toHaveAttribute("href", "/app/acme/settings/webhooks");
  });
});

describe("queued deliveries", () => {
  it("tells the admin what a pause has queued up", async () => {
    vi.mocked(getWebhook).mockResolvedValue({
      ...WEBHOOK,
      status: "paused",
      paused_at: "2026-09-01T10:00:00",
      queued_count: 3,
    });
    vi.mocked(listDeliveries).mockResolvedValue([]);
    render(
      <TenantProvider value={tenantFixture("admin")}>
        <MemoryRouter>
          <WebhookDetail />
        </MemoryRouter>
      </TenantProvider>,
    );
    expect(await screen.findByText(/3 deliveries queued/)).toBeInTheDocument();
  });

  it("says nothing while the webhook is active", async () => {
    vi.mocked(getWebhook).mockResolvedValue(WEBHOOK);
    vi.mocked(listDeliveries).mockResolvedValue([]);
    render(
      <TenantProvider value={tenantFixture("admin")}>
        <MemoryRouter>
          <WebhookDetail />
        </MemoryRouter>
      </TenantProvider>,
    );
    await screen.findByText("Overview");
    expect(screen.queryByText(/queued/)).not.toBeInTheDocument();
  });
});
