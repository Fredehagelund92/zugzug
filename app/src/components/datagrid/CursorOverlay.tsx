import { useEffect, useRef } from "react";
import type { PeerState } from "../../lib/use-presence";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface CursorOverlayProps {
  peers: PeerState[];
  /** Translates a peer's (row, col) into a pixel rect inside the grid container.
   *  Return null if the cell is virtualized out of view or otherwise un-paintable. */
  cellRect: (row: number, col: number) => Rect | null;
}

/** Renders peer cursors absolutely positioned over the grid surface. Container
 *  must be `relative` for the absolute children to anchor correctly. */
export function CursorOverlay({ peers, cellRect }: CursorOverlayProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {peers.map((p) => {
        if (!p.cell) return null;
        const r = cellRect(p.cell.row, p.cell.col);
        if (!r) return null;
        return <PeerCursor key={p.userId} peer={p} rect={r} />;
      })}
    </div>
  );
}

function PeerCursor({ peer, rect }: { peer: PeerState; rect: Rect }) {
  const labelRef = useRef<HTMLDivElement | null>(null);

  // Reset the fade-out timer every time the peer's cell coords change.
  useEffect(() => {
    const el = labelRef.current;
    if (!el) return;
    el.dataset.stale = "false";
    const t = window.setTimeout(() => {
      if (el) el.dataset.stale = "true";
    }, 1800);
    return () => window.clearTimeout(t);
  }, [peer.cell?.row, peer.cell?.col]);

  return (
    <div
      className="zz-peer-cell group/peer absolute"
      style={{
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      }}
    >
      <div
        className="absolute inset-0 border-l-2"
        style={{
          borderColor: `var(--tint-${peer.color})`,
          backgroundColor: `var(--tint-${peer.color})`,
          opacity: 0.18,
        }}
      />
      <div
        ref={labelRef}
        data-stale="false"
        className="zz-peer-label absolute -top-5 left-0 rounded px-1.5 py-0.5 font-mono text-[10px]"
        style={{
          backgroundColor: `var(--tint-${peer.color})`,
          color: "#fff",
        }}
      >
        {peer.displayName}
      </div>
    </div>
  );
}
