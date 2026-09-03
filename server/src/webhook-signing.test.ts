import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { signPayload, signPayloadMulti, parseSignatureHeader } from "./webhook-signing.ts";

const SECRET = "whsec_b8K3kP9mQ2vN7L4xR8jH3sT5uW8yA1zE6cD9fG2J";

describe("signPayload", () => {
  it("emits t=…,kid=…,v1=sha256=<hex> format", () => {
    const header = signPayload("{}", SECRET, "current", 1700000000);
    expect(header).toMatch(/^t=1700000000,kid=current,v1=sha256=[0-9a-f]{64}$/);
  });

  it("HMAC matches independent computation", () => {
    const header = signPayload("hello world", SECRET, "current", 1700000000);
    const parts = parseSignatureHeader(header);
    expect(parts).not.toBeNull();
    const expected = createHmac("sha256", SECRET).update("1700000000.hello world").digest("hex");
    expect(parts!.v1.toLowerCase()).toBe(expected);
  });

  it("different timestamps produce different signatures (replay-resistant)", () => {
    const a = signPayload("body", SECRET, "current", 1700000000);
    const b = signPayload("body", SECRET, "current", 1700000001);
    expect(a).not.toBe(b);
  });

  it("kid=previous embeds correctly", () => {
    const header = signPayload("body", SECRET, "previous", 1700000000);
    expect(header).toContain("kid=previous");
  });
});

describe("parseSignatureHeader", () => {
  it("parses valid header", () => {
    const header = "t=1700000000,kid=current,v1=sha256=abc";
    const parts = parseSignatureHeader(header);
    expect(parts).toEqual({
      t: 1700000000,
      kid: "current",
      v1: "abc",
      entries: [{ kid: "current", v1: "abc" }],
    });
  });
  it("rejects malformed header", () => {
    expect(parseSignatureHeader("garbage")).toBeNull();
    expect(parseSignatureHeader("")).toBeNull();
    expect(parseSignatureHeader("t=,kid=current,v1=sha256=abc")).toBeNull();
  });
  it("keeps every signature when a rotation puts two keys in the header", () => {
    const header = signPayloadMulti(
      "body",
      [
        { kid: "current", secret: "new-secret" },
        { kid: "previous", secret: "old-secret" },
      ],
      1700000000,
    );
    const parts = parseSignatureHeader(header)!;
    expect(parts.t).toBe(1700000000);
    expect(parts.entries.map((e) => e.kid)).toEqual(["current", "previous"]);
    expect(parts.entries[0]!.v1).not.toBe(parts.entries[1]!.v1);
    // The first pair is still what the single-signature accessors report.
    expect(parts.kid).toBe("current");
    expect(parts.v1).toBe(parts.entries[0]!.v1);
    // Each digest is the plain single-key signature for its own secret.
    expect(parts.entries[1]!.v1).toBe(
      parseSignatureHeader(signPayload("body", "old-secret", "previous", 1700000000))!.v1,
    );
  });
});
