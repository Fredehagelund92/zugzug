import type { PeerState } from "../../lib/use-presence";

const MAX_VISIBLE = 8;

/** Toolbar avatar strip showing presence at-a-glance. Active peers carry a
 *  colored ring; away peers fade to grayscale. Overflow past 8 collapses
 *  into a "+N" counter. */
export function PresenceStrip({ peers }: { peers: PeerState[] }) {
  if (peers.length === 0) {
    return <div className="flex items-center gap-1" />;
  }
  const visible = peers.slice(0, MAX_VISIBLE);
  const overflow = peers.length - visible.length;
  return (
    <div className="flex items-center gap-1">
      {visible.map((p) => (
        <span
          key={p.userId}
          data-presence-avatar
          title={p.away ? `${p.displayName} (away)` : p.displayName}
          className={
            p.away
              ? "inline-flex h-5 w-5 items-center justify-center rounded-full font-mono text-[9px] font-medium opacity-40 grayscale transition-all"
              : "inline-flex h-5 w-5 items-center justify-center rounded-full font-mono text-[9px] font-medium text-white transition-all"
          }
          style={
            p.away
              ? undefined
              : {
                  backgroundColor: `var(--tint-${p.color})`,
                  // Surface-colored ring: a ring in the fill color is invisible.
                  boxShadow: `0 0 0 1.5px var(--surface)`,
                }
          }
        >
          {initials(p.displayName)}
        </span>
      ))}
      {overflow > 0 && <span className="font-mono text-[10px] text-ink-3">+{overflow}</span>}
    </div>
  );
}

function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]![0] ?? "?").toUpperCase();
  return (parts[0]![0] ?? "").toUpperCase() + (parts[1]![0] ?? "").toUpperCase();
}
