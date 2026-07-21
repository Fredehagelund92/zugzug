/**
 * collapsePeers — the awareness-states → PeerState[] projection used by
 * usePresence's syncPeers.
 *
 * Yjs awareness keys peers by ephemeral clientID (one per page load). A hard
 * reload leaves the old clientID behind as a ghost until the awareness
 * timeout prunes it (~30s), so the raw states map can contain several entries
 * for the same user — including stale copies of *yourself*. collapsePeers
 * must project that map down to at most one PeerState per remote user.
 */

import { describe, test, expect } from "vitest";
import { collapsePeers } from "../src/lib/use-presence";

const NOW = 1_700_000_000_000;

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "u_mia",
    displayName: "Mia Berg",
    color: "coral",
    cell: null,
    selection: null,
    lastActiveAt: NOW,
    ...over,
  };
}

const self = { clientID: 1, userId: "u_me" };

describe("collapsePeers", () => {
  test("excludes own clientID", () => {
    const states = new Map([[1, state({ userId: "u_me", displayName: "Me" })]]);
    expect(collapsePeers(states, self, NOW)).toEqual([]);
  });

  test("excludes own userId under a different clientID (ghost of self after reload)", () => {
    const states = new Map([
      [7, state({ userId: "u_me", displayName: "Me" })],
      [8, state({ userId: "u_me", displayName: "Me" })],
    ]);
    expect(collapsePeers(states, self, NOW)).toEqual([]);
  });

  test("collapses several clientIDs with the same userId into one peer", () => {
    const states = new Map([
      [7, state({ lastActiveAt: NOW - 60_000 })],
      [8, state({ lastActiveAt: NOW - 30_000 })],
      [9, state({ lastActiveAt: NOW - 5_000 })],
    ]);
    const peers = collapsePeers(states, self, NOW);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.userId).toBe("u_mia");
  });

  test("dedupe keeps the state with the newest lastActiveAt", () => {
    const states = new Map([
      [7, state({ lastActiveAt: NOW - 60_000, cell: { rowKey: "ghost", field: "label" } })],
      [8, state({ lastActiveAt: NOW - 1_000, cell: { rowKey: "live", field: "label" } })],
    ]);
    const peers = collapsePeers(states, self, NOW);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.cell).toEqual({ rowKey: "live", field: "label" });
  });

  test("keeps distinct users as distinct peers", () => {
    const states = new Map([
      [7, state({ userId: "u_a", displayName: "Alice" })],
      [8, state({ userId: "u_b", displayName: "Bob" })],
    ]);
    const peers = collapsePeers(states, self, NOW);
    expect(peers.map((p) => p.userId).sort()).toEqual(["u_a", "u_b"]);
  });

  test("drops states older than the remove window (10 min)", () => {
    const states = new Map([[7, state({ lastActiveAt: NOW - 601_000 })]]);
    expect(collapsePeers(states, self, NOW)).toEqual([]);
  });

  test("marks states older than the away window (2 min) as away with no cell", () => {
    const states = new Map([
      [7, state({ lastActiveAt: NOW - 121_000, cell: { rowKey: "k", field: "f" } })],
    ]);
    const peers = collapsePeers(states, self, NOW);
    expect(peers).toHaveLength(1);
    expect(peers[0]!.away).toBe(true);
    expect(peers[0]!.cell).toBeNull();
  });

  test("skips malformed states (missing userId/displayName/color)", () => {
    const states = new Map<number, unknown>([
      [7, { userId: "u_x" }],
      [8, null],
    ]);
    expect(collapsePeers(states, self, NOW)).toEqual([]);
  });
});
