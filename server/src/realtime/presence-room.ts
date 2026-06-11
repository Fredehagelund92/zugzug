/* presence-room.ts — in-memory awareness fan-out for /ws/t/:slug/presence/:tableId
 * (legacy: /ws/presence/:tableId, treated as the "default" tenant).
 *
 * Rooms are keyed by `${tenantId}\0${tableId}` so the same tableId across two
 * workspaces does NOT share a room. The PresenceTransport interface exists so
 * we can swap to a Redis-pubsub implementation without touching the route
 * handler. */

import type { ServerWebSocket } from "bun";

export interface RowTouchedHint {
  type: "row_touched";
  rowKey: string;
  userId: string;
  txnId?: string;
}

export interface PresenceTransport {
  join(tableId: string, ws: ServerWebSocket, tenantId: string): void;
  leave(tableId: string, ws: ServerWebSocket, tenantId: string): void;
  /** Broadcast a yjs awareness update to all peers in the room.
   *  `except` is the originating socket (excluded from the fan-out). */
  broadcastAwareness(
    tableId: string,
    payload: Uint8Array,
    except: ServerWebSocket | undefined,
    tenantId: string,
  ): void;
  /** Broadcast a commit-time "row touched" hint to all peers (incl. sender). */
  broadcastRowTouched(tableId: string, hint: RowTouchedHint, tenantId: string): void;
  /** Test/inspection helper: number of active rooms. */
  roomCount(): number;
}

interface Room {
  peers: Set<ServerWebSocket>;
  gcTimer: ReturnType<typeof setTimeout> | null;
}

/** NUL separator avoids collisions if tenantId or tableId contain `/` or `:`. */
function roomKey(tenantId: string, tableId: string): string {
  return `${tenantId}\0${tableId}`;
}

export class InMemoryPresenceTransport implements PresenceTransport {
  private rooms = new Map<string, Room>();
  private gcGraceMs: number;

  constructor(opts: { gcGraceMs?: number } = {}) {
    this.gcGraceMs = opts.gcGraceMs ?? 2000;
  }

  join(tableId: string, ws: ServerWebSocket, tenantId: string): void {
    const key = roomKey(tenantId, tableId);
    let room = this.rooms.get(key);
    if (!room) {
      room = { peers: new Set(), gcTimer: null };
      this.rooms.set(key, room);
    }
    if (room.gcTimer) {
      clearTimeout(room.gcTimer);
      room.gcTimer = null;
    }
    room.peers.add(ws);
  }

  leave(tableId: string, ws: ServerWebSocket, tenantId: string): void {
    const key = roomKey(tenantId, tableId);
    const room = this.rooms.get(key);
    if (!room) return;
    room.peers.delete(ws);
    if (room.peers.size === 0) {
      room.gcTimer = setTimeout(() => {
        const current = this.rooms.get(key);
        if (current && current.peers.size === 0) this.rooms.delete(key);
      }, this.gcGraceMs);
    }
  }

  broadcastAwareness(
    tableId: string,
    payload: Uint8Array,
    except: ServerWebSocket | undefined,
    tenantId: string,
  ): void {
    const room = this.rooms.get(roomKey(tenantId, tableId));
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

  broadcastRowTouched(tableId: string, hint: RowTouchedHint, tenantId: string): void {
    const room = this.rooms.get(roomKey(tenantId, tableId));
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
