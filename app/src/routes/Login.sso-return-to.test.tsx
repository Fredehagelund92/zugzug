import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Login } from "./Login";

vi.mock("../api", () => ({
  authFetch: () => Promise.resolve({ ok: false }),
}));

vi.mock("../store", async (orig) => ({
  ...(await orig<typeof import("../store")>()),
  useAuthConfig: () => ({ mode: "oidc", allowedDomain: null, oidcLabel: "Okta" }),
}));

afterEach(cleanup);

function renderAt(search: string): HTMLAnchorElement {
  window.history.replaceState({}, "", `/login${search}`);
  render(<Login />);
  return screen.getByRole("link", { name: /sign in with okta/i }) as HTMLAnchorElement;
}

describe("SSO sign-in link", () => {
  it("carries the deep link so the callback can return to it", () => {
    const link = renderAt("?next=%2Fapp%2Facme%2Ftables%2Fcountry");
    expect(link.getAttribute("href")).toBe(
      "/api/auth/oidc/start?next=%2Fapp%2Facme%2Ftables%2Fcountry",
    );
  });

  it("drops an off-site destination", () => {
    const link = renderAt("?next=https%3A%2F%2Fevil.example%2Fx");
    expect(link.getAttribute("href")).toBe("/api/auth/oidc/start");
  });

  it("has no next when there is nowhere to return to", () => {
    const link = renderAt("");
    expect(link.getAttribute("href")).toBe("/api/auth/oidc/start");
  });
});
