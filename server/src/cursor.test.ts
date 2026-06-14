import { describe, it, expect } from "bun:test";
import { signCursor, verifyCursor } from "./cursor.ts";

const KEY = Buffer.alloc(32, 0x42).toString("base64");

describe("cursor signing", () => {
  it("round-trips a payload", () => {
    const cursor = signCursor(
      { t: "acme", u: "2026-06-14T11:32:04Z", k: "DE", v: 1 },
      KEY,
    );
    const verified = verifyCursor(cursor, KEY);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.payload.t).toBe("acme");
      expect(verified.payload.u).toBe("2026-06-14T11:32:04Z");
      expect(verified.payload.k).toBe("DE");
      expect(verified.payload.v).toBe(1);
    }
  });

  it("rejects a tampered signature", () => {
    const cursor = signCursor(
      { t: "acme", u: "2026-06-14T11:32:04Z", k: "DE", v: 1 },
      KEY,
    );
    const [body, sig] = cursor.split(".");
    const tamperedSig = sig!.slice(0, -1) + (sig!.slice(-1) === "a" ? "b" : "a");
    const verified = verifyCursor(`${body}.${tamperedSig}`, KEY);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe("cursor_invalid");
  });

  it("rejects a cursor signed with a different key", () => {
    const cursor = signCursor(
      { t: "acme", u: "2026-06-14T11:32:04Z", k: "DE", v: 1 },
      KEY,
    );
    const otherKey = Buffer.alloc(32, 0x99).toString("base64");
    expect(verifyCursor(cursor, otherKey).ok).toBe(false);
  });

  it("rejects malformed cursor strings without throwing", () => {
    expect(verifyCursor("not.a.real.cursor", KEY).ok).toBe(false);
    expect(verifyCursor("", KEY).ok).toBe(false);
    expect(verifyCursor("nodot", KEY).ok).toBe(false);
  });

  it("verifies with a tenant whitelist if one is provided", () => {
    const cursor = signCursor(
      { t: "acme", u: "2026-06-14T11:32:04Z", k: "DE", v: 1 },
      KEY,
    );
    const v1 = verifyCursor(cursor, KEY, "acme");
    expect(v1.ok).toBe(true);
    const v2 = verifyCursor(cursor, KEY, "bigcorp");
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.reason).toBe("cursor_mismatch");
  });
});
