process.env.WAREHOUSE_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd=";

import { test, expect } from "bun:test";
import { encryptCredentials, decryptCredentials } from "../src/warehouse/crypto.ts";

const PLAINTEXT = JSON.stringify({ type: "duckdb", token: "md_token_abc", writable: false });
const AAD = "acme:wc_a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("round-trips plaintext when AAD matches", () => {
  const blob = encryptCredentials(PLAINTEXT, AAD);
  expect(decryptCredentials(blob, AAD)).toBe(PLAINTEXT);
});

test("ciphertext is base64", () => {
  const blob = encryptCredentials(PLAINTEXT, AAD);
  expect(blob).toMatch(/^[A-Za-z0-9+/=]+$/);
});

test("ciphertext is at least 28 bytes (nonce 12 + tag 16) longer than nothing", () => {
  const blob = encryptCredentials("", AAD);
  const raw = Buffer.from(blob, "base64");
  expect(raw.length).toBeGreaterThanOrEqual(28);
});

test("two encryptions of the same plaintext produce different blobs (random nonce)", () => {
  expect(encryptCredentials(PLAINTEXT, AAD)).not.toBe(encryptCredentials(PLAINTEXT, AAD));
});

test("wrong AAD on decrypt throws", () => {
  const blob = encryptCredentials(PLAINTEXT, AAD);
  expect(() => decryptCredentials(blob, "acme:wc_other")).toThrow();
});

test("tampered ciphertext throws", () => {
  const blob = encryptCredentials(PLAINTEXT, AAD);
  const raw = Buffer.from(blob, "base64");
  raw[20] ^= 0x01;
  const tampered = raw.toString("base64");
  expect(() => decryptCredentials(tampered, AAD)).toThrow();
});

test("decrypt rejects too-short blob", () => {
  expect(() => decryptCredentials(Buffer.from([1, 2, 3]).toString("base64"), AAD)).toThrow();
});
