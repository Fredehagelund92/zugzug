import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../lib/cx";
import { PALETTE, defaultTintFor } from "../lib/palette";
import { IconCheck, IconSearch, IconX } from "./Icons";

interface Member {
  user_id: string;
  name: string | null;
}

/** Two-letter initials from a display name (or id), for the avatar chip. */
function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase() || "?";
}

/** Searchable, scrollable owner picker. Scales to hundreds of people — filter
 *  by name or id, scroll the list, Enter selects the top match. Selecting a
 *  person (or "No owner") fires onPick; the parent persists + closes. */
export function OwnerPicker({
  members,
  currentId,
  onPick,
}: {
  members: Member[];
  currentId: string | null;
  onPick: (id: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!needle) return members;
    return members.filter(
      (m) =>
        (m.name ?? "").toLowerCase().includes(needle) || m.user_id.toLowerCase().includes(needle),
    );
  }, [members, needle]);

  const showNoOwner = needle === "" || "no owner".includes(needle);
  const nothingMatches = filtered.length === 0 && !showNoOwner;

  return (
    <div className="w-full max-w-sm">
      <div className="flex items-center gap-2 rounded-sm border border-line-2 bg-bg px-2.5 py-1.5 transition-colors focus-within:border-accent">
        <IconSearch className="h-3.5 w-3.5 shrink-0 text-ink-3" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered.length > 0) {
              e.preventDefault();
              onPick(filtered[0].user_id);
            }
          }}
          placeholder="Filter people…"
          className="w-full min-w-0 bg-transparent font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3"
        />
        {query && (
          <button
            type="button"
            className="shrink-0 text-ink-3 transition-colors hover:text-ink"
            onClick={() => setQuery("")}
            title="Clear filter"
          >
            <IconX className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mt-1.5 max-h-64 overflow-y-auto rounded-sm border border-line bg-surface">
        {showNoOwner && (
          <button
            type="button"
            className={cx(
              "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-hover",
              !currentId && "bg-accent-wash",
            )}
            onClick={() => onPick(null)}
          >
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-pill border border-dashed border-line-2 text-[12px] text-ink-3">
              –
            </span>
            <span className="flex-1 text-[13px] text-ink-2">No owner</span>
            {!currentId && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
          </button>
        )}
        {filtered.map((m) => {
          const selected = currentId === m.user_id;
          const label = m.name ?? m.user_id;
          return (
            <button
              key={m.user_id}
              type="button"
              className={cx(
                "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors hover:bg-hover",
                selected && "bg-accent-wash",
              )}
              onClick={() => onPick(m.user_id)}
            >
              <span
                className="grid h-6 w-6 shrink-0 place-items-center rounded-pill text-[10px] font-bold text-white"
                style={{ background: PALETTE[defaultTintFor(m.user_id)].bg }}
              >
                {initials(label)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{label}</span>
                {m.name && (
                  <span className="block truncate font-mono text-[10px] text-ink-3">
                    {m.user_id}
                  </span>
                )}
              </span>
              {selected && <IconCheck className="h-4 w-4 shrink-0 text-accent" />}
            </button>
          );
        })}
        {nothingMatches && (
          <div className="px-2.5 py-4 text-center text-[12px] text-ink-3">
            No people match “{query}”.
          </div>
        )}
      </div>

      <div className="mt-1 px-0.5 font-mono text-[10px] text-ink-3">
        {members.length} {members.length === 1 ? "person" : "people"}
      </div>
    </div>
  );
}
