import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeliveryLog } from "./DeliveryLog";
import { TenantProvider, type TenantContextValue } from "../../lib/tenant-context";
import { listDeliveries, type WebhookDelivery } from "../../lib/integrations-api";

vi.mock("../../lib/integrations-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/integrations-api")>()),
  listDeliveries: vi.fn(),
  replayDelivery: vi.fn(),
}));

const ROW: WebhookDelivery = {
  id: "whd_1",
  webhook_id: "wh_1",
  event_id: "ev_1",
  event_type: "table.published",
  delivery_url: "https://example.test/wh",
  signing_kid: "current",
  is_test: false,
  status: "success",
  attempts: 1,
  max_attempts: 5,
  next_attempt_at: null,
  last_attempt_at: "2026-07-26T10:00:00",
  last_response_code: 200,
  last_response_body: "ok",
  last_error: null,
  payload: { hello: "world" },
  signature: "t=1,kid=current,v1=sha256=deadbeef",
  created_at: "2026-07-26T10:00:00",
  completed_at: "2026-07-26T10:00:01",
};

const ADMIN: TenantContextValue = {
  id: "t",
  slug: "t",
  label: "T",
  color: null,
  role: "admin",
  isSuperAdmin: false,
};

function renderLog(rows: WebhookDelivery[]) {
  vi.mocked(listDeliveries).mockResolvedValue(rows);
  return render(
    <TenantProvider value={ADMIN}>
      <DeliveryLog webhookId="wh_1" />
    </TenantProvider>,
  );
}

describe("DeliveryLog", () => {
  it("renders a delivery row with its created timestamp", async () => {
    renderLog([ROW]);
    expect(await screen.findByText("2026-07-26 10:00:00")).toBeInTheDocument();
    expect(screen.getByText("table.published")).toBeInTheDocument();
  });

  it("renders a placeholder instead of throwing when created_at is missing", async () => {
    renderLog([{ ...ROW, created_at: undefined as unknown as string }]);
    expect(await screen.findByText("table.published")).toBeInTheDocument();
  });
});
