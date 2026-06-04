import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { OptionBuilder } from "./OptionBuilder";
import type { OptionDef } from "../data";

export interface AddFieldInput {
  label: string;
  type: "text" | "number" | "boolean" | "date" | "select";
  options?: OptionDef[];
}

interface AddFieldPopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (input: AddFieldInput) => Promise<void>;
}

type FieldType = AddFieldInput["type"];

interface TypeTile {
  type: FieldType;
  icon: string;
  label: string;
}

const TYPE_TILES: TypeTile[] = [
  { type: "text",    icon: "A",  label: "Text"    },
  { type: "number",  icon: "#",  label: "Number"  },
  { type: "boolean", icon: "☑", label: "Boolean" },
  { type: "date",    icon: "⊞",  label: "Date"    },
  { type: "select",  icon: "◉", label: "Select"  },
];

export function AddFieldPopover({ anchorRef, onClose, onSubmit }: AddFieldPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [options, setOptions] = useState<OptionDef[]>([]);
  const [createAnother, setCreateAnother] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Position the popover below the anchor's bottom-right corner
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const rect = anchor.getBoundingClientRect();
    const POPOVER_WIDTH = 320;
    const GAP = 6;

    let left = rect.right - POPOVER_WIDTH;
    let top = rect.bottom + GAP + window.scrollY;

    // Prevent going off the left edge
    if (left < 8) left = 8;
    // Prevent going off the right edge
    if (left + POPOVER_WIDTH > window.innerWidth - 8) {
      left = window.innerWidth - POPOVER_WIDTH - 8;
    }

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }, [anchorRef]);

  // Focus name input on mount
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void handleSubmit();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, type, options, createAnother, busy]);

  // Close on click-outside
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (popoverRef.current && !popoverRef.current.contains(target)) {
        // Don't close if clicking the anchor button itself (host toggles)
        if (anchorRef.current && anchorRef.current.contains(target)) return;
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [anchorRef, onClose]);

  const resetForm = () => {
    setLabel("");
    setType("text");
    setOptions([]);
    setError(null);
    nameInputRef.current?.focus();
  };

  const handleSubmit = async () => {
    const trimmed = label.trim();
    if (!trimmed || busy) return;
    setError(null);
    setBusy(true);
    try {
      await onSubmit({
        label: trimmed,
        type,
        options: type === "select" ? options : undefined,
      });
      if (createAnother) {
        resetForm();
      } else {
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = label.trim().length > 0 && !busy;

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 w-80 rounded-sm border border-line-2 bg-surface shadow-lg"
      style={{ width: 320 }}
    >
      {/* Accent top edge */}
      <div className="h-px w-full rounded-t-sm bg-gradient-to-r from-transparent via-accent/70 to-transparent" />

      <div className="p-4 space-y-4">
        {/* Eyebrow */}
        <div className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-ink-3">
          Add field
        </div>

        {/* Name input */}
        <input
          ref={nameInputRef}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && type !== "select") void handleSubmit();
          }}
          placeholder="Field name…"
          className="w-full rounded-sm border border-line-2 bg-bg px-3 py-2 font-display text-[16px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />

        {/* Type grid — 2 columns, 3 rows */}
        <div className="grid grid-cols-2 gap-1.5">
          {TYPE_TILES.map(({ type: t, icon, label: typeLabel }) => {
            const active = type === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={cx(
                  "flex items-center gap-2 rounded-sm border p-2 text-left transition-colors",
                  active
                    ? "border-accent bg-accent-wash"
                    : "border-line hover:border-line-2 hover:bg-hover",
                )}
              >
                <span
                  className={cx(
                    "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm font-mono text-[11px]",
                    active ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink-2",
                  )}
                  aria-hidden
                >
                  {icon}
                </span>
                <span className="font-mono text-[11px] text-ink">{typeLabel}</span>
              </button>
            );
          })}

          {/* Linked record — disabled/coming-soon tile */}
          <div
            className="relative flex items-center gap-2 rounded-sm border border-line p-2 opacity-40 cursor-not-allowed"
            aria-disabled="true"
          >
            <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-sm bg-surface-2 font-mono text-[11px] text-ink-2" aria-hidden>
              ↗
            </span>
            <span className="font-mono text-[11px] text-ink">Linked record</span>
            <span className="absolute top-1 right-1 rounded-sm bg-surface-2 px-1 py-px font-mono text-[8px] uppercase tracking-widest text-ink-3">
              soon
            </span>
          </div>
        </div>

        {/* Type-specific config */}
        {type === "select" && (
          <>
            <div className="border-t border-line" />
            <OptionBuilder options={options} onChange={setOptions} />
          </>
        )}

        {/* Error banner */}
        {error && (
          <div className="rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-[11px] text-danger">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 pt-1">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={createAnother}
              onChange={(e) => setCreateAnother(e.target.checked)}
              className="rounded-sm"
              style={{ accentColor: "var(--accent)" }}
            />
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
              create another
            </span>
          </label>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
            >
              Create field
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
