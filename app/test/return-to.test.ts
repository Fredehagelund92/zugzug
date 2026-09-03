import { describe, it, expect } from "vitest";
import { loginUrlWithReturnTo, returnToFrom } from "../src/lib/return-to";

describe("return-to", () => {
  it("carries the deep link the user asked for", () => {
    expect(
      loginUrlWithReturnTo({ pathname: "/app/acme/review", search: "?filter=mapped", hash: "" }),
    ).toBe("/login?next=%2Fapp%2Facme%2Freview%3Ffilter%3Dmapped");
    expect(
      loginUrlWithReturnTo({
        pathname: "/app/acme/settings/warehouse",
        search: "",
        hash: "#scans",
      }),
    ).toBe("/login?next=%2Fapp%2Facme%2Fsettings%2Fwarehouse%23scans");
  });

  it("adds nothing for the root path", () => {
    expect(loginUrlWithReturnTo({ pathname: "/", search: "", hash: "" })).toBe("/login");
  });

  it("never bounces back to the auth pages themselves", () => {
    expect(loginUrlWithReturnTo({ pathname: "/login", search: "?error=state", hash: "" })).toBe(
      "/login",
    );
    expect(loginUrlWithReturnTo({ pathname: "/signup", search: "", hash: "" })).toBe("/login");
  });

  it("reads the destination back out of the query string", () => {
    expect(returnToFrom("?next=%2Fapp%2Facme%2Freview")).toBe("/app/acme/review");
  });

  it("falls back when there is no destination", () => {
    expect(returnToFrom("")).toBe("/app");
    expect(returnToFrom("?error=state")).toBe("/app");
  });

  it("refuses an off-site destination", () => {
    expect(returnToFrom("?next=https%3A%2F%2Fevil.test%2Fx")).toBe("/app");
    expect(returnToFrom("?next=%2F%2Fevil.test")).toBe("/app");
    expect(returnToFrom("?next=%2F%5Cevil.test")).toBe("/app");
  });
});

/* Browsers strip tab, newline and carriage return before resolving a URL, so a
   startsWith("//") check let "/\t/evil.com" through and the sign-in form then
   redirected to //evil.com. Each payload below resolved to https://evil.com/
   against the old prefix check — verified before the fix. */
describe("does not become an open redirect", () => {
  const offsite = [
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r/evil.com",
    "//evil.com",
    "/\\evil.com",
    "https://evil.com/app",
    "http://evil.com",
    "javascript:alert(1)",
  ];

  for (const to of offsite) {
    it(`refuses ${JSON.stringify(to)}`, () => {
      expect(returnToFrom(`?next=${encodeURIComponent(to)}`)).toBe("/app");
    });
  }

  // Percent-encoded control characters are NOT stripped by the URL parser, so
  // these stay same-origin paths and are safe to honour — unlike their raw
  // counterparts above. Asserted so a future "tighten it" change stays honest
  // about which form is actually dangerous.
  it.each(["/%09/evil.com", "/%0A/evil.com"])("treats %s as a same-origin path", (to) => {
    const out = returnToFrom(`?next=${encodeURIComponent(to)}`);
    expect(new URL(out, "https://app.example").origin).toBe("https://app.example");
  });

  it("keeps an ordinary in-app deep link", () => {
    expect(returnToFrom("?next=%2Fapp%2Facme%2Fsettings%2Fwebhooks%2F7")).toBe(
      "/app/acme/settings/webhooks/7",
    );
  });

  it("returns the normalized path, not the raw input", () => {
    // Validating one string and returning another is how these fixes regress.
    const out = returnToFrom("?next=%2Fapp%2F..%2Fapp%2Fx");
    expect(out.startsWith("/")).toBe(true);
    expect(out).not.toContain("..");
  });
});
