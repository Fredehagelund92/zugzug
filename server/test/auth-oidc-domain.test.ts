// Domain restriction test — ALLOWED_DOMAIN must be set BEFORE any env.ts import
// so that env.allowedDomain is populated. This is why this test lives in its own file.
process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.OIDC_ISSUER_URL = "https://example-issuer.test";
process.env.OIDC_CLIENT_ID = "test-client-id";
process.env.OIDC_CLIENT_SECRET = "test-client-secret";
process.env.ALLOWED_DOMAIN = "example.com"; // ← domain restriction active for this file

import { test, expect, beforeEach } from "bun:test";
import { resetDb } from "./setup.ts";
import {
  handleOidcCallback,
  setOidcClient,
  setOidcConfigFactory,
  _resetOidcConfig,
} from "../src/auth-oidc.ts";

const fakeConfig = {} as Parameters<typeof setOidcConfigFactory>[0] extends () => Promise<infer C>
  ? C
  : never;

let mockTokenResult: {
  claims: () => { sub: string; email?: string; name?: string };
} | null = null;

const fakeClient = {
  discovery: async () => fakeConfig,
  randomState: () => "test-state",
  randomNonce: () => "test-nonce",
  buildAuthorizationUrl: (_config: unknown, params: Record<string, string>) => {
    const u = new URL("https://example-issuer.test/authorize");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u;
  },
  authorizationCodeGrant: async () => {
    if (!mockTokenResult) throw new Error("no mock token result configured");
    return mockTokenResult;
  },
} as Parameters<typeof setOidcClient>[0];

beforeEach(async () => {
  await resetDb();
  _resetOidcConfig();
  setOidcClient(fakeClient);
  setOidcConfigFactory(async () => fakeConfig);
  mockTokenResult = null;
});

test("oidc callback — domain mismatch redirects with error=domain", async () => {
  // env.allowedDomain is "example.com" (set before module load)
  // This email is from a different domain — should be rejected
  mockTokenResult = {
    claims: () => ({
      sub: "outsider-sub",
      email: "outsider@otherdomain.com",
      name: "Outsider",
    }),
  };
  const req = new Request(
    "http://localhost/api/auth/oidc/callback?code=abc&state=test-state",
    { headers: { cookie: "zz_oidc_state=test-state; zz_oidc_nonce=test-nonce" } },
  );
  const res = await handleOidcCallback(req);
  expect(res.status).toBe(302);
  expect(res.headers.get("Location")).toContain("error=domain");
});
