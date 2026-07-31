import { describe, it, expect } from "bun:test";
import { resolveOpen } from "./open.ts";
import type { DuckDbCreds } from "../credentials.ts";

const creds = (over: Partial<DuckDbCreds> = {}): DuckDbCreds =>
  ({ type: "duckdb", attached: false, writable: false, ...over }) as DuckDbCreds;

describe("resolveOpen", () => {
  it("opens a local file read-only when the adapter is not writable", () => {
    const r = resolveOpen(creds({ path: "/data/demo.duckdb" }));
    expect(r.path).toBe("/data/demo.duckdb");
    expect(r.options).toEqual({ access_mode: "READ_ONLY" });
    expect(r.isReadOnlyFile).toBe(true);
  });

  it("leaves a writable local file read-write", () => {
    const r = resolveOpen(creds({ path: "/data/demo.duckdb", writable: true }));
    expect(r.options).toEqual({});
    expect(r.isReadOnlyFile).toBe(false);
  });

  it("leaves :memory: alone", () => {
    const r = resolveOpen(creds({ path: ":memory:" }));
    expect(r.path).toBe(":memory:");
    expect(r.options).toEqual({});
    expect(r.isReadOnlyFile).toBe(false);
  });

  it("defaults to :memory: when no path is given", () => {
    const r = resolveOpen(creds());
    expect(r.path).toBe(":memory:");
    expect(r.options).toEqual({});
  });

  it("uses the MotherDuck connection string when attached with a token", () => {
    const r = resolveOpen(creds({ attached: true, token: "tok en" }));
    expect(r.path).toBe("md:?motherduck_token=tok%20en");
    expect(r.options).toEqual({});
    expect(r.isReadOnlyFile).toBe(false);
  });

  it("does not treat a token alone as MotherDuck when not attached", () => {
    const r = resolveOpen(creds({ token: "abc", path: "/data/demo.duckdb" }));
    expect(r.path).toBe("/data/demo.duckdb");
    expect(r.options).toEqual({ access_mode: "READ_ONLY" });
  });
});
