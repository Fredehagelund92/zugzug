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

function makeWebhook(id: string, url: string): Webhook {
  return {
    id,
    url,
    events: ["draft.published"],
    status: "active",
    secret_prefix: "whsec_abc",
    secret_previous_expires_at: null,
    secret_prefix_previous: null,
    description: null,
    disabled_reason: null,
    last_delivery_at: null,
    last_delivery_status: null,
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

describe("Webhooks duplicate-URL banner", () => {
  it("renders a warn-tone banner above the table when two webhooks share a URL", async () => {
    await renderWebhooks([
      makeWebhook("wh-1", "https://example.com/hook"),
      makeWebhook("wh-2", "https://example.com/hook"),
    ]);

    const banner = await screen.findByRole("alert");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/2 webhooks share a url/i);
    expect(banner).toHaveTextContent(/deliveries may be duplicated/i);

    // Banner must appear before the table
    const table = screen.getByRole("table");
    expect(banner.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders no banner when all URLs are unique", async () => {
    await renderWebhooks([
      makeWebhook("wh-1", "https://example.com/hook-a"),
      makeWebhook("wh-2", "https://example.com/hook-b"),
    ]);

    await waitFor(() => screen.getByRole("table"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses singular 'webhook' copy when exactly one duplicate pair exists (dupSet.size=2)", async () => {
    // dupSet.size counts affected webhook IDs, so 2 IDs → "2 webhooks"
    await renderWebhooks([
      makeWebhook("wh-1", "https://example.com/hook"),
      makeWebhook("wh-2", "https://example.com/hook"),
    ]);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("2 webhooks share a URL");
  });
});
