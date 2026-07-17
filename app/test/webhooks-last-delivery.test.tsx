import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TenantProvider, type TenantContextValue } from "../src/lib/tenant-context";
import type { Webhook } from "../src/lib/integrations-api";

vi.mock("../src/lib/integrations-api", () => ({
  listWebhooks: vi.fn(),
  humanError: (code: string) => code,
  IntegrationsApiError: class IntegrationsApiError extends Error {},
}));

vi.mock("../src/components/integrations/WebhookVerificationReference", () => ({
  WebhookVerificationReference: () => null,
}));

vi.mock("../src/routes/integrations/CreateWebhookModal", () => ({
  CreateWebhookModal: () => null,
}));

vi.mock("../src/routes/integrations/SecretRevealModal", () => ({
  SecretRevealModal: () => null,
}));

const tenant: TenantContextValue = {
  id: "t1",
  slug: "acme",
  label: "Acme",
  color: null,
  role: "admin",
  isSuperAdmin: false,
};

function makeWebhook(overrides: Partial<Webhook> = {}): Webhook {
  return {
    id: "wh-1",
    url: "https://example.com/hook",
    events: ["draft.published"],
    status: "active",
    secret_prefix: "whsec_abc",
    secret_previous_expires_at: null,
    secret_prefix_previous: null,
    description: null,
    disabled_reason: null,
    last_delivery_at: null,
    last_delivery_status: null,
    ...overrides,
  };
}

async function renderWebhooks(items: Webhook[]) {
  const { listWebhooks } = await import("../src/lib/integrations-api");
  vi.mocked(listWebhooks).mockResolvedValue(items);
  const { Webhooks } = await import("../src/routes/integrations/Webhooks");
  render(
    <MemoryRouter>
      <TenantProvider value={tenant}>
        <Webhooks />
      </TenantProvider>
    </MemoryRouter>,
  );
}

describe("Webhooks last-delivery column", () => {
  it("renders a placeholder for a webhook that has never delivered", async () => {
    await renderWebhooks([makeWebhook({ last_delivery_at: null })]);
    await waitFor(() => screen.getByRole("table"));
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("never")).not.toBeInTheDocument();
  });

  it("renders the delivery timestamp when last_delivery_at is set", async () => {
    await renderWebhooks([
      makeWebhook({ last_delivery_at: "2024-03-15T10:30:00Z", last_delivery_status: "200" }),
    ]);
    await waitFor(() => screen.getByRole("table"));
    expect(screen.getByText(/2024-03-15/)).toBeInTheDocument();
  });
});
