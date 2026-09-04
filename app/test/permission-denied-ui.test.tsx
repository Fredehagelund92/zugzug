import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TenantProvider } from "../src/lib/tenant-context";
import { tenantFixture } from "./tenant-fixture";

/* A denied mutation must land somewhere the user can see: an error line or a
 * toast. Before the capability split these calls were fire-and-forget — the
 * integrations pages left `loading` true forever (a permanent skeleton plus an
 * unhandled rejection) and the mapping thresholds looked as if they had saved. */

vi.mock("../src/lib/integrations-api", () => ({
  listWebhooks: vi.fn(),
  getWebhook: vi.fn(),
  listServiceAccounts: vi.fn(),
  createServiceAccount: vi.fn(),
  revokeServiceAccount: vi.fn(),
  patchWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  reactivateWebhook: vi.fn(),
  rotateSecret: vi.fn(),
  sendTestEvent: vi.fn(),
  humanError: (code: string) => `human:${code}`,
  IntegrationsApiError: class IntegrationsApiError extends Error {
    constructor(
      public code: string,
      public status: number,
    ) {
      super(code);
    }
  },
}));

vi.mock("../src/components/integrations/WebhookVerificationReference", () => ({
  WebhookVerificationReference: () => null,
}));
vi.mock("../src/routes/integrations/CreateWebhookModal", () => ({
  CreateWebhookModal: () => null,
}));
vi.mock("../src/routes/integrations/SecretRevealModal", () => ({ SecretRevealModal: () => null }));
vi.mock("../src/routes/integrations/DeliveryLog", () => ({ DeliveryLog: () => null }));

import {
  listWebhooks,
  getWebhook,
  listServiceAccounts,
  IntegrationsApiError as ApiError,
} from "../src/lib/integrations-api";
import { Webhooks } from "../src/routes/integrations/Webhooks";
import { WebhookDetail } from "../src/routes/integrations/WebhookDetail";
import { ServiceAccounts } from "../src/routes/integrations/ServiceAccounts";

function wrap(ui: React.ReactNode, route = "/") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <TenantProvider value={tenantFixture("admin")}>{ui}</TenantProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("integrations pages on a refused fetch", () => {
  it("Webhooks shows the error and drops the skeleton", async () => {
    vi.mocked(listWebhooks).mockRejectedValue(new ApiError("editor_required", 403));
    const { container } = wrap(<Webhooks />);
    expect(await screen.findByText(/human:editor_required/)).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("WebhookDetail shows the error and drops the skeleton", async () => {
    vi.mocked(getWebhook).mockRejectedValue(new ApiError("admin_required", 403));
    const { container } = wrap(
      <Routes>
        <Route path="/wh_1" element={<WebhookDetail />} />
      </Routes>,
      "/wh_1",
    );
    expect(await screen.findByText(/human:admin_required/)).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("ServiceAccounts shows the error and drops the skeleton", async () => {
    vi.mocked(listServiceAccounts).mockRejectedValue(new ApiError("admin_required", 403));
    const { container } = wrap(<ServiceAccounts />);
    expect(await screen.findByText(/human:admin_required/)).toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

/* ---- mapping thresholds: a refused PUT /api/preferences must be visible ---- */

const setPreferences = vi.fn();
const toast = vi.fn();

vi.mock("../src/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store")>();
  return {
    ...actual,
    usePreferences: () => ({
      scanSchedule: null,
      requireSecondPublisher: false,
      autoPublishEnabled: false,
    }),
    setPreferences: (...args: unknown[]) => setPreferences(...args),
    invalidate: { ...actual.invalidate, tenant: vi.fn() },
  };
});
vi.mock("../src/components/Toast", () => ({ toast: (...args: unknown[]) => toast(...args) }));

import { Matching } from "../src/routes/settings/Matching";

describe("mapping settings on a refused save", () => {
  it("surfaces the failure instead of swallowing it", async () => {
    const user = userEvent.setup();
    setPreferences.mockRejectedValue(new Error("forbidden"));
    render(
      <TenantProvider value={tenantFixture("admin")}>
        <Matching />
      </TenantProvider>,
    );
    await user.click(screen.getByLabelText("Require a second publisher"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Couldn't save: forbidden", "error"));
  });

  it("leaves every control read-only for an editor — preferences are admin-only", () => {
    render(
      <TenantProvider value={tenantFixture("editor")}>
        <Matching />
      </TenantProvider>,
    );
    // Asserted on the controls themselves rather than a wrapper: the page used
    // to carry a confidence-band slider inside a disabled <fieldset>, but that
    // control fed nothing on the server and was removed.
    expect(screen.getByLabelText("Require a second publisher")).toBeDisabled();
    expect(screen.getByLabelText("Publish exact matches on its own")).toBeDisabled();
  });

  it("lets an admin change them", () => {
    render(
      <TenantProvider value={tenantFixture("admin")}>
        <Matching />
      </TenantProvider>,
    );
    expect(screen.getByLabelText("Require a second publisher")).toBeEnabled();
    expect(screen.getByLabelText("Publish exact matches on its own")).toBeEnabled();
  });
});
