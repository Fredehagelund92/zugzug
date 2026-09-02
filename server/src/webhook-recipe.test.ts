/* The verification recipe published in the app is developer-facing
   documentation: if it does not actually verify a real delivery, every
   integrator's first webhook fails. The Node snippet shipped to users is
   executed here against a signature produced by webhook-signing.ts, and the
   header names the reference documents are checked against the header set the
   dispatcher really sends. Both sides import the same module, so the docs and
   the implementation cannot drift apart silently. */

import { describe, it, expect } from "bun:test";
import { signPayload, signPayloadMulti, deliveryHeaders } from "./webhook-signing.ts";
import {
  NODE_RECIPE,
  EXAMPLE_REQUEST,
  EXAMPLE_ROTATION_SIGNATURE,
} from "../../app/src/components/integrations/webhook-recipes.ts";

/** Compile the published snippet and hand back its exported verify(). */
async function loadVerify(): Promise<(rawBody: string, header: string, secret: string) => boolean> {
  const mod = (await import(
    `data:text/typescript;base64,${Buffer.from(NODE_RECIPE).toString("base64")}`
  )) as { verify: (rawBody: string, header: string, secret: string) => boolean };
  return mod.verify;
}

const BODY = JSON.stringify({ table_slug: "country", version: 12, kind: "publish" });
const SECRET = "whsec_recipe_test_secret_value";
const OTHER = "whsec_some_other_secret_value";
const now = () => Math.floor(Date.now() / 1000);

describe("the published Node verification recipe", () => {
  it("verifies a signature produced by webhook-signing.ts", async () => {
    const verify = await loadVerify();
    expect(verify(BODY, signPayload(BODY, SECRET, "current", now()), SECRET)).toBe(true);
  });

  it("rejects the wrong secret", async () => {
    const verify = await loadVerify();
    expect(verify(BODY, signPayload(BODY, SECRET, "current", now()), OTHER)).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const verify = await loadVerify();
    const header = signPayload(BODY, SECRET, "current", now());
    expect(verify(`${BODY} `, header, SECRET)).toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const verify = await loadVerify();
    expect(verify(BODY, signPayload(BODY, SECRET, "current", now() - 400), SECRET)).toBe(false);
  });

  it("accepts either key while a rotation grace is open", async () => {
    const verify = await loadVerify();
    const header = signPayloadMulti(
      BODY,
      [
        { kid: "current", secret: OTHER },
        { kid: "previous", secret: SECRET },
      ],
      now(),
    );
    // A consumer that has already cut over, and one that has not, both pass.
    expect(verify(BODY, header, OTHER)).toBe(true);
    expect(verify(BODY, header, SECRET)).toBe(true);
    expect(verify(BODY, header, "whsec_neither_of_the_two_keys")).toBe(false);
  });
});

function documentedHeaderNames(sample: string): string[] {
  return sample
    .split("\n")
    .map((line) => line.slice(0, line.indexOf(":")).trim().toLowerCase())
    .filter((name) => name.startsWith("x-zugzug-"));
}

describe("the documented request headers", () => {
  const real = Object.keys(
    deliveryHeaders({
      eventType: "table.published",
      eventId: "evt_1",
      deliveryId: "whd_1",
      signature: "t=1,kid=current,v1=sha256=ab",
      isTest: false,
    }),
  );

  it("names exactly the x-zugzug-* headers the dispatcher sends", () => {
    const documented = documentedHeaderNames(EXAMPLE_REQUEST);
    expect(documented.length).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual(real.filter((h) => h.startsWith("x-zugzug-")).sort());
  });

  it("shows the rotation example on the real signature header", () => {
    expect(documentedHeaderNames(EXAMPLE_ROTATION_SIGNATURE)).toEqual(["x-zugzug-signature"]);
  });
});
