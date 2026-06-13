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
  cell: { row: number; col: number } | null;
  selection: { row: number; col: number; rowEnd: number; colEnd: number } | null;
  away: boolean;
}

const AWAY_AFTER_MS = 120_000; // 2 min: peer disappears from cursors
const REMOVE_AFTER_MS = 600_000; // 10 min: peer fully removed
const CURSOR_THROTTLE_MS = 33; // ~30 Hz

/** Subscribes to live presence in a given table.
 *  - `peers`: array of remote PeerState (self excluded).
 *  - `setCell(row, col)`: publish self cursor position (throttled to ~30 Hz).
 *  - `away`: true if no local input for AWAY_AFTER_MS. */
export function usePresence(
  tableId: string | null,
  me: { userId: string; displayName: string },
): { peers: PeerState[]; setCell: (row: number, col: number) => void; away: boolean } {
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [away, setAway] = useState(false);
  const awarenessRef = useRef<Awareness | null>(null);
  const lastSendRef = useRef(0);

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
          cell: isAway ? null : (s.cell ?? null),
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
      awareness.off("change", syncPeers);
      provider.destroy();
      doc.destroy();
      awarenessRef.current = null;
    };
  }, [tableId, me.userId, me.displayName]);

  const setCell = (row: number, col: number) => {
    const now = performance.now();
    if (now - lastSendRef.current < CURSOR_THROTTLE_MS) return;
    lastSendRef.current = now;
    const cur = awarenessRef.current;
    if (!cur) return;
    const s = (cur.getLocalState() ?? {}) as Record<string, unknown>;
    cur.setLocalState({ ...s, cell: { row, col }, lastActiveAt: Date.now() });
  };

  return { peers, setCell, away };
}
