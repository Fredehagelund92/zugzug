// Env must be set before ANY module imports — env.ts reads DATABASE_URL via
// required() at module load time, so setting it afterward is too late.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";

import { test, expect } from "bun:test";
import { buildAuthConfig, handleAuthConfig } from "../src/auth.ts";

test("buildAuthConfig — password mode default (no OIDC_ISSUER_URL)", () => {
  const cfg = buildAuthConfig({
    authMode: "password",
    allowedDomain: "",
    oidcLabel: "",
  });
  expect(cfg.mode).toBe("password");
  expect(cfg.signupOpen).toBe(false);
  expect(cfg.allowedDomain).toBeNull();
  expect(cfg.oidcLabel).toBeUndefined();
});

test("buildAuthConfig — OIDC mode with label", () => {
  const cfg = buildAuthConfig({
    authMode: "oidc",
    allowedDomain: "example.com",
    oidcLabel: "Google",
  });
  expect(cfg.mode).toBe("oidc");
  expect(cfg.allowedDomain).toBe("example.com");
  expect(cfg.oidcLabel).toBe("Google");
});

test("buildAuthConfig — OIDC mode without label omits the field", () => {
  const cfg = buildAuthConfig({
    authMode: "oidc",
    allowedDomain: "",
    oidcLabel: "",
  });
  expect(cfg.mode).toBe("oidc");
  expect(cfg.allowedDomain).toBeNull();
  expect(cfg.oidcLabel).toBeUndefined();
});

test("buildAuthConfig — password mode never includes oidcLabel (even if set)", () => {
  const cfg = buildAuthConfig({
    authMode: "password",
    allowedDomain: "",
    oidcLabel: "Should be ignored",
  });
  expect(cfg.mode).toBe("password");
  expect(cfg.oidcLabel).toBeUndefined();
});

test("handleAuthConfig — wires env values into JSON response", async () => {
  const res = handleAuthConfig();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    mode: "password" | "oidc";
    signupOpen: boolean;
    allowedDomain: string | null;
  };
  // Just smoke-check the shape; the buildAuthConfig tests cover the logic.
  expect(["password", "oidc"]).toContain(body.mode);
  expect(typeof body.signupOpen).toBe("boolean");
  expect(body.allowedDomain === null || typeof body.allowedDomain === "string").toBe(true);
});
