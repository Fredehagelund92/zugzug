/* presence-room.ts — in-memory awareness fan-out for /ws/presence/:tableId.
 * The PresenceTransport interface exists so we can swap to a Redis-pubsub
 * implementation without touching the route handler. */

import type { ServerWebSocket } from "bun";

export interface RowTouchedHint {
  type: "row_touched";
  rowKey: string;
  userId: string;
  txnId?: string;
}

export interface PresenceTransport {
  join(tableId: string, ws: ServerWebSocket): void;
  leave(tableId: string, ws: ServerWebSocket): void;
  /** Broadcast a yjs awareness update to all peers in the room.
   *  `except` is the originating socket (excluded from the fan-out). */
  broadcastAwareness(tableId: string, payload: Uint8Array, except?: ServerWebSocket): void;
  /** Broadcast a commit-time "row touched" hint to all peers (incl. sender). */
  broadcastRowTouched(tableId: string, hint: RowTouchedHint): void;
  /** Test/inspection helper: number of active rooms. */
  roomCount(): number;
}

interface Room {
  peers: Set<ServerWebSocket>;
  gcTimer: ReturnType<typeof setTimeout> | null;
}

export class InMemoryPresenceTransport implements PresenceTransport {
  private rooms = new Map<string, Room>();
  private gcGraceMs: number;

  constructor(opts: { gcGraceMs?: number } = {}) {
    this.gcGraceMs = opts.gcGraceMs ?? 2000;
  }

  join(tableId: string, ws: ServerWebSocket): void {
    let room = this.rooms.get(tableId);
    if (!room) {
      room = { peers: new Set(), gcTimer: null };
      this.rooms.set(tableId, room);
    }
    if (room.gcTimer) {
      clearTimeout(room.gcTimer);
      room.gcTimer = null;
    }
    room.peers.add(ws);
  }

  leave(tableId: string, ws: ServerWebSocket): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    room.peers.delete(ws);
    if (room.peers.size === 0) {
      room.gcTimer = setTimeout(() => {
        const current = this.rooms.get(tableId);
        if (current && current.peers.size === 0) this.rooms.delete(tableId);
      }, this.gcGraceMs);
    }
  }

  broadcastAwareness(tableId: string, payload: Uint8Array, except?: ServerWebSocket): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    for (const peer of room.peers) {
      if (peer === except) continue;
      if (peer.readyState !== 1) continue;
      try {
        peer.send(payload);
      } catch {
        /* peer raced into CLOSING — silently skip */
      }
    }
  }

  broadcastRowTouched(tableId: string, hint: RowTouchedHint): void {
    const room = this.rooms.get(tableId);
    if (!room) return;
    const msg = JSON.stringify(hint);
    for (const peer of room.peers) {
      if (peer.readyState !== 1) continue;
      try {
        peer.send(msg);
      } catch {
        /* skip */
      }
    }
  }

  roomCount(): number {
    return this.rooms.size;
  }
}

/** Shared singleton used by the WS route in `server.ts`. */
export const presence: PresenceTransport = new InMemoryPresenceTransport();
