/* use-presence.ts — y-websocket + standalone Awareness for live presence
 * (cursors + selection + idle/away). The Y.Doc is a throwaway carrier — E1
 * does not sync document content, only the awareness envelope. E2 promotes
 * the doc to content-bearing for CRDT cell merging. */

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";
import { presenceColorFor } from "./use-presence-color";
import type { PaletteName } from "./palette";

export interface PeerState {
  userId: string;
  displayName: string;
  color: PaletteName;
  cell: { rowKey: string; field: string } | null;
  selection: { row: number; col: number; rowEnd: number; colEnd: number } | null;
  away: boolean;
}

/** Awareness payloads cross client versions during a deploy: accept only the
 *  keyed cursor shape; older {row, col} index payloads render no cursor. */
export function sanitizePeerCell(raw: unknown): PeerState["cell"] {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.rowKey === "string" && typeof c.field === "string") {
    return { rowKey: c.rowKey, field: c.field };
  }
  return null;
}

/** A row-scoped write broadcasts this JSON *string* to the presence room over
 *  the same socket that carries (binary) yjs awareness. It's a push hint that a
 *  row changed — the client refetches row-activity instead of polling. */
export interface RowTouchedHint {
  type: "row_touched";
  rowKey: string;
  userId: string;
}

/** Shape-guard mirroring sanitizePeerCell: accept only well-formed hints so a
 *  malformed or cross-version text frame can never trigger a refetch. */
export function isRowTouchedHint(raw: unknown): raw is RowTouchedHint {
  if (typeof raw !== "object" || raw === null) return false;
  const c = raw as Record<string, unknown>;
  return c.type === "row_touched" && typeof c.rowKey === "string" && typeof c.userId === "string";
}

const AWAY_AFTER_MS = 120_000; // 2 min: peer disappears from cursors
const REMOVE_AFTER_MS = 600_000; // 10 min: peer fully removed
const CURSOR_THROTTLE_MS = 33; // ~30 Hz

/** Subscribes to live presence in a given table.
 *  - `peers`: array of remote PeerState (self excluded).
 *  - `setCell(rowKey, field)`: publish self cursor position (throttled to ~30 Hz).
 *  - `away`: true if no local input for AWAY_AFTER_MS. */
export function usePresence(
  tableId: string | null,
  me: {
    userId: string;
    displayName: string;
    /** Called when a peer's row-scoped write pushes a `row_touched` text frame. */
    onRowTouched?: (hint: RowTouchedHint) => void;
  },
): { peers: PeerState[]; setCell: (rowKey: string, field: string) => void; away: boolean } {
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [away, setAway] = useState(false);
  const awarenessRef = useRef<Awareness | null>(null);
  const lastSendRef = useRef(0);

  // Keep the latest callback in a ref so the socket listener doesn't need to be
  // torn down/re-attached when only the callback identity changes.
  const onRowTouchedRef = useRef(me.onRowTouched);
  onRowTouchedRef.current = me.onRowTouched;

  useEffect(() => {
    if (!tableId) return;

    const doc = new Y.Doc();
    const wsProto = location.protocol === "https:" ? "wss" : "ws";
    // Extract tenant slug from pathname (same pattern as apiFetch)
    const m = /^\/app\/([^/]+)\//.exec(location.pathname + "/");
    const slug = m?.[1] ?? "default";
    const wsUrl = `${wsProto}://${location.host}/ws/t/${slug}/presence/${encodeURIComponent(tableId)}`;
    const provider = new WebsocketProvider(wsUrl, tableId, doc, { connect: true });
    const awareness = provider.awareness as Awareness;
    awarenessRef.current = awareness;

    // Row-activity push: y-websocket delivers awareness/sync frames as BINARY
    // (ArrayBuffer) and hands them to its own socket.onmessage. Our server sends
    // a JSON *string* `row_touched` hint on the same socket. We attach a second
    // "message" listener via addEventListener (y-websocket assigns socket.onmessage
    // directly, so the two coexist) and act ONLY on string frames — binary stays
    // entirely with y-websocket. The provider recreates its socket on every
    // reconnect (setupWS sets provider.ws to a fresh WebSocket), so we re-attach
    // on each `status: connected` event and detach from the previous socket.
    let attachedWs: WebSocket | null = null;
    const onSocketMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return; // binary → y-websocket
      try {
        const parsed = JSON.parse(event.data);
        if (isRowTouchedHint(parsed)) onRowTouchedRef.current?.(parsed);
      } catch {
        /* non-JSON text — ignore */
      }
    };
    const attachSocketListener = () => {
      const ws = provider.ws as WebSocket | null;
      if (ws === attachedWs) return; // already bound to this socket
      if (attachedWs) attachedWs.removeEventListener("message", onSocketMessage);
      attachedWs = ws;
      if (ws) ws.addEventListener("message", onSocketMessage);
    };
    // Re-bind whenever the provider (re)connects — provider.ws is the live socket
    // by the time `status: connected` fires from inside socket.onopen.
    const onStatus = (e: { status: "connected" | "disconnected" | "connecting" }) => {
      if (e.status === "connected") attachSocketListener();
    };
    provider.on("status", onStatus);
    attachSocketListener(); // in case the socket already exists synchronously

    awareness.setLocalState({
      userId: me.userId,
      displayName: me.displayName,
      color: presenceColorFor(me.userId),
      cell: null,
      selection: null,
      lastActiveAt: Date.now(),
    });

    const syncPeers = () => {
      const states = Array.from(awareness.getStates().entries());
      const now = Date.now();
      const next: PeerState[] = [];
      for (const [clientId, raw] of states) {
        if (clientId === awareness.clientID) continue;
        const s = raw as Partial<PeerState> & { lastActiveAt?: number };
        if (!s.userId || !s.displayName || !s.color) continue;
        const last = s.lastActiveAt ?? now;
        const ageMs = now - last;
        if (ageMs > REMOVE_AFTER_MS) continue;
        const isAway = ageMs > AWAY_AFTER_MS;
        next.push({
          userId: s.userId,
          displayName: s.displayName,
          color: s.color,
          cell: isAway ? null : sanitizePeerCell(s.cell),
          selection: isAway ? null : (s.selection ?? null),
          away: isAway,
        });
      }
      setPeers(next);
    };
    awareness.on("change", syncPeers);
    const peerTick = window.setInterval(syncPeers, 5_000);

    // Self idle/away tracking.
    let lastActive = Date.now();
    const bump = () => {
      lastActive = Date.now();
      const cur = awarenessRef.current;
      if (cur) {
        const s = (cur.getLocalState() ?? {}) as Record<string, unknown>;
        cur.setLocalState({ ...s, lastActiveAt: lastActive });
      }
      setAway((prev) => (prev ? false : prev));
    };
    const checkIdle = () => {
      if (Date.now() - lastActive > AWAY_AFTER_MS) {
        setAway((prev) => (prev ? prev : true));
      }
    };
    const idleTimer = window.setInterval(checkIdle, 5_000);
    window.addEventListener("mousemove", bump);
    window.addEventListener("keydown", bump);

    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("keydown", bump);
      window.clearInterval(idleTimer);
      window.clearInterval(peerTick);
      provider.off("status", onStatus);
      if (attachedWs) attachedWs.removeEventListener("message", onSocketMessage);
      awareness.off("change", syncPeers);
      provider.destroy();
      doc.destroy();
      awarenessRef.current = null;
    };
  }, [tableId, me.userId, me.displayName]);

  const setCell = (rowKey: string, field: string) => {
    const now = performance.now();
    if (now - lastSendRef.current < CURSOR_THROTTLE_MS) return;
    lastSendRef.current = now;
    const cur = awarenessRef.current;
    if (!cur) return;
    const s = (cur.getLocalState() ?? {}) as Record<string, unknown>;
    cur.setLocalState({ ...s, cell: { rowKey, field }, lastActiveAt: Date.now() });
  };

  return { peers, setCell, away };
}
