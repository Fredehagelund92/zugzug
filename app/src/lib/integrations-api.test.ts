import { describe, it, expect, beforeEach, vi } from "vitest";
import * as api from "./integrations-api";

const FETCH = vi.fn();

beforeEach(() => {
  FETCH.mockReset();
  // apiFetch reads window.location.pathname; stub a tenant URL.
  Object.defineProperty(window, "location", {
    writable: true,
    value: { pathname: "/app/acme/integrations/webhooks" },
  });
  globalThis.fetch = FETCH as unknown as typeof fetch;
});

describe("listWebhooks", () => {
  it("GETs /api/t/<slug>/v1/webhooks and returns the array", async () => {
    FETCH.mockResolvedValueOnce(new Response(JSON.stringify({ webhooks: [{ id: "wh_1" }] }), { status: 200 }));
    const out = await api.listWebhooks();
    expect(FETCH).toHaveBeenCalledWith(
      "/api/t/acme/v1/webhooks",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(out).toEqual([{ id: "wh_1" }]);
  });
});

describe("createWebhook", () => {
  it("POSTs JSON body and returns { id, value }", async () => {
    FETCH.mockResolvedValueOnce(new Response(JSON.stringify({ id: "wh_1", value: "whsec_xxx" }), { status: 201 }));
    const out = await api.createWebhook({ url: "https://x", events: ["dimension.committed"], description: null });
    expect(out).toEqual({ id: "wh_1", value: "whsec_xxx" });
    const init = FETCH.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      url: "https://x",
      events: ["dimension.committed"],
      description: null,
    });
  });

  it("throws IntegrationsApiError on 400 with the server error code", async () => {
    FETCH.mockResolvedValueOnce(new Response(JSON.stringify({ error: "https_required" }), { status: 400 }));
    await expect(api.createWebhook({ url: "http://x", events: ["dimension.committed"], description: null }))
      .rejects.toMatchObject({ code: "https_required", status: 400 });
  });
});
