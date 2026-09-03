import { describe, it, expect } from "vitest";
import { curlForEndpoint } from "./PullApi";

/* The copy-paste curls used to be built as `${baseUrl}${sig.replace("GET ", "")}`
   where baseUrl already ends in /v1 and every signature starts with /v1/ — every
   documented example 404'd on /v1/v1/…. */
describe("curlForEndpoint", () => {
  const BASE = "https://zugzug.example/api/t/acme/v1";

  it("does not double the /v1 segment", () => {
    const cmd = curlForEndpoint(BASE, "GET /v1/tables");
    expect(cmd).toContain(`${BASE}/tables`);
    expect(cmd).not.toContain("/v1/v1/");
  });

  it("keeps nested paths intact", () => {
    expect(curlForEndpoint(BASE, "GET /v1/tables/country/records")).toBe(
      `curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" ${BASE}/tables/country/records`,
    );
  });
});
