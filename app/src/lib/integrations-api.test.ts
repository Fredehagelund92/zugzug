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
    FETCH.mockResolvedValueOnce(
      new Response(JSON.stringify({ webhooks: [{ id: "wh_1" }] }), { status: 200 }),
    );
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
    FETCH.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "wh_1", value: "whsec_xxx" }), { status: 201 }),
    );
    const out = await api.createWebhook({
      url: "https://x",
      events: ["dimension.committed"],
      description: null,
    });
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
    FETCH.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "https_required" }), { status: 400 }),
    );
    await expect(
      api.createWebhook({ url: "http://x", events: ["dimension.committed"], description: null }),
    ).rejects.toMatchObject({ code: "https_required", status: 400 });
  });
});

describe("deleteWebhook", () => {
  it("returns undefined for a 204 response", async () => {
    FETCH.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api.deleteWebhook("wh_1")).resolves.toBeUndefined();
  });
});

describe("listDeliveries", () => {
  it("encodes query params and unwraps deliveries", async () => {
    FETCH.mockResolvedValueOnce(
      new Response(JSON.stringify({ deliveries: [{ id: "whd_1" }] }), { status: 200 }),
    );
    const out = await api.listDeliveries("wh_1", { status: "dlq", limit: 25 });
    expect(FETCH).toHaveBeenCalledWith(
      "/api/t/acme/v1/webhooks/wh_1/deliveries?status=dlq&limit=25",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(out).toEqual([{ id: "whd_1" }]);
  });
});

describe("network errors", () => {
  it("propagates fetch rejection", async () => {
    FETCH.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api.listWebhooks()).rejects.toThrow("Failed to fetch");
  });
});

describe("listServiceAccounts", () => {
  it("unwraps the service_accounts envelope", async () => {
    FETCH.mockResolvedValueOnce(
      new Response(JSON.stringify({ service_accounts: [{ id: "sa_1" }] }), { status: 200 }),
    );
    const out = await api.listServiceAccounts();
    expect(out).toEqual([{ id: "sa_1" }]);
  });
});

describe("listDimensions", () => {
  it("unwraps the dimensions envelope", async () => {
    FETCH.mockResolvedValueOnce(
      new Response(JSON.stringify({ dimensions: [{ id: "d1", slug: "country" }] }), {
        status: 200,
      }),
    );
    const out = await api.listDimensions();
    expect(out).toEqual([{ id: "d1", slug: "country" }]);
  });
});
