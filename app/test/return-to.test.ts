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
