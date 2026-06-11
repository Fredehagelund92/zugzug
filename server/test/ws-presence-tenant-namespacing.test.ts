process.env.DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug_test";
process.env.ATTACH_WAREHOUSE = "false";
process.env.MOTHERDUCK_TOKEN = "test-stub";
process.env.GOOGLE_CLIENT_ID = "test-stub";
process.env.GOOGLE_CLIENT_SECRET = "test-stub";

import { test, expect } from "bun:test";
import { InMemoryPresenceTransport } from "../src/realtime/presence-room.ts";

/* Tenant-namespaced presence rooms (MT PR2b Task 12).
 * The same tableId in two workspaces MUST NOT share a room. Within one
 * workspace, the same tableId MUST still share a single room. */

function fakeWs(state: number = 1) {
  const sent: (Uint8Array | string)[] = [];
  return {
    sent,
    ws: {
      readyState: state,
      send: (msg: Uint8Array | string) => sent.push(msg),
    } as unknown as import("bun").ServerWebSocket,
  };
}

test("same tableId in two tenants does not bridge presence", () => {
  const t = new InMemoryPresenceTransport();
  const a = fakeWs();
  const b = fakeWs();
  t.join("dim_country", a.ws, "ten_a");
  t.join("dim_country", b.ws, "ten_b");

  t.broadcastAwareness("dim_country", new Uint8Array([0xaa]), a.ws, "ten_a");

  // Peer in the other tenant's room MUST NOT receive anything.
  expect(b.sent).toEqual([]);
});

test("same tableId within one tenant DOES bridge presence", () => {
  const t = new InMemoryPresenceTransport();
  const a = fakeWs();
  const b = fakeWs();
  t.join("dim_country", a.ws, "ten_a");
  t.join("dim_country", b.ws, "ten_a");

  const payload = new Uint8Array([1, 2, 3]);
  t.broadcastAwareness("dim_country", payload, a.ws, "ten_a");

  expect(b.sent).toEqual([payload]);
});

test("broadcastRowTouched is tenant-scoped", () => {
  const t = new InMemoryPresenceTransport();
  const a = fakeWs();
  const b = fakeWs();
  t.join("dim_country", a.ws, "ten_a");
  t.join("dim_country", b.ws, "ten_b");

  t.broadcastRowTouched(
    "dim_country",
    { type: "row_touched", rowKey: "DK", userId: "u_mia" },
    "ten_a",
  );

  expect(a.sent).toHaveLength(1);
  expect(b.sent).toEqual([]);
});

test("leave is tenant-scoped — leaving ten_a does not evict ten_b peer", () => {
  const t = new InMemoryPresenceTransport({ gcGraceMs: 10_000 });
  const a = fakeWs();
  const b = fakeWs();
  t.join("dim_country", a.ws, "ten_a");
  t.join("dim_country", b.ws, "ten_b");
  expect(t.roomCount()).toBe(2);

  t.leave("dim_country", a.ws, "ten_a");
  // ten_b's room should still receive a broadcast.
  t.broadcastRowTouched(
    "dim_country",
    { type: "row_touched", rowKey: "DK", userId: "u_mia" },
    "ten_b",
  );
  expect(b.sent).toHaveLength(1);
});
