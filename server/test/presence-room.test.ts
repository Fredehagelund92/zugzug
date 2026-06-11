process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { InMemoryPresenceTransport } from "../src/realtime/presence-room.ts";

const T = "default";

function fakeWs(state: number = 1 /* OPEN */) {
  const sent: (Uint8Array | string)[] = [];
  return {
    sent,
    ws: {
      readyState: state,
      send: (msg: Uint8Array | string) => sent.push(msg),
    } as unknown as import("bun").ServerWebSocket,
  };
}

test("broadcastAwareness fans out to all peers except the sender", () => {
  const t = new InMemoryPresenceTransport();
  const a = fakeWs();
  const b = fakeWs();
  const c = fakeWs();
  t.join("dim_1", a.ws, T);
  t.join("dim_1", b.ws, T);
  t.join("dim_1", c.ws, T);

  const payload = new Uint8Array([1, 2, 3]);
  t.broadcastAwareness("dim_1", payload, a.ws, T);

  expect(a.sent).toHaveLength(0);
  expect(b.sent).toEqual([payload]);
  expect(c.sent).toEqual([payload]);
});

test("broadcastAwareness skips peers in non-OPEN state", () => {
  const t = new InMemoryPresenceTransport();
  const a = fakeWs(1 /* OPEN */);
  const b = fakeWs(2 /* CLOSING */);
  t.join("dim_1", a.ws, T);
  t.join("dim_1", b.ws, T);

  t.broadcastAwareness("dim_1", new Uint8Array([9]), undefined, T);

  expect(b.sent).toHaveLength(0);
});

test("leave + rejoin keeps the room alive across the GC grace", async () => {
  const t = new InMemoryPresenceTransport({ gcGraceMs: 50 });
  const a = fakeWs();
  t.join("dim_1", a.ws, T);
  t.leave("dim_1", a.ws, T);

  // Immediate rejoin — room must still exist
  const b = fakeWs();
  t.join("dim_1", b.ws, T);
  expect(t.roomCount()).toBe(1);

  await new Promise((r) => setTimeout(r, 80));
  expect(t.roomCount()).toBe(1);
});

test("room is GC'd after grace if it stays empty", async () => {
  const t = new InMemoryPresenceTransport({ gcGraceMs: 30 });
  const a = fakeWs();
  t.join("dim_1", a.ws, T);
  t.leave("dim_1", a.ws, T);

  await new Promise((r) => setTimeout(r, 60));
  expect(t.roomCount()).toBe(0);
});

test("broadcastRowTouched delivers JSON-encoded hint to all peers", () => {
  const t = new InMemoryPresenceTransport();
  const a = fakeWs();
  const b = fakeWs();
  t.join("dim_1", a.ws, T);
  t.join("dim_1", b.ws, T);

  t.broadcastRowTouched("dim_1", { type: "row_touched", rowKey: "dk", userId: "u_mia" }, T);

  expect(a.sent).toHaveLength(1);
  expect(b.sent).toHaveLength(1);
  const parsed = JSON.parse(a.sent[0] as string);
  expect(parsed).toEqual({ type: "row_touched", rowKey: "dk", userId: "u_mia" });
});
