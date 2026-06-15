import { describe, it, expect } from "vitest";
import { showKidBadge } from "./WebhookDetail";
import { can } from "../../lib/permissions";

describe("viewer payload masking", () => {
  it("viewer cannot view delivery payload", () => {
    const viewerCtx = {
      id: "t",
      slug: "t",
      label: "T",
      color: null,
      role: "viewer" as const,
      isSuperAdmin: false,
    };
    expect(can(viewerCtx, "integrations.webhooks.delivery_payload_view")).toBe(false);
  });
  it("editor can view delivery payload", () => {
    const editorCtx = {
      id: "t",
      slug: "t",
      label: "T",
      color: null,
      role: "editor" as const,
      isSuperAdmin: false,
    };
    expect(can(editorCtx, "integrations.webhooks.delivery_payload_view")).toBe(true);
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
