import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../api";
import { cx } from "../lib/cx";

/* WarehousePicker — dropdown that loads available MotherDuck databases from
   GET /api/admin/warehouses and lets the admin pick one. Falls through to a
   plain text input when the warehouse is not attached, the fetch fails, or
   the database list is empty. */

interface WarehouseDb {
  name: string;
  tableCount: number;
  connected: boolean;
}

interface WarehouseResponse {
  databases: WarehouseDb[];
  attached: boolean;
}

export interface WarehousePickerProps {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}

type LoadState = "loading" | "ready" | "fallback";

const inputCls =
  "w-full bg-surface border border-line-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent transition-colors";

const DROPDOWN_W = 280;

export function WarehousePicker({ value, onChange, className }: WarehousePickerProps) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [databases, setDatabases] = useState<WarehouseDb[]>([]);
  const [open, setOpen] = useState(false);
  const [manualMode, setManualMode] = useState(false);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch databases on mount
  useEffect(() => {
    let cancelled = false;
    apiFetch("/admin/warehouses")
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setLoadState("fallback");
          return;
        }
        const data = (await r.json()) as WarehouseResponse;
        if (!data.attached || data.databases.length === 0) {
          setLoadState("fallback");
          return;
        }
        setDatabases(data.databases);
        setLoadState("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadState("fallback");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Position the floating panel below the trigger
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const dropdown = dropdownRef.current;
      const trigger = triggerRef.current;
      if (!dropdown || !trigger) return;
      const rect = trigger.getBoundingClientRect();
      const dropH = dropdown.offsetHeight;

      let left = rect.left;
      if (left + DROPDOWN_W > window.innerWidth - 8) left = window.innerWidth - DROPDOWN_W - 8;
      if (left < 8) left = 8;

      let top = rect.bottom + 4;
      if (top + dropH > window.innerHeight - 8) top = Math.max(8, rect.top - 4 - dropH);

      dropdown.style.width = `${Math.max(DROPDOWN_W, rect.width)}px`;
      dropdown.style.left = `${left}px`;
      dropdown.style.top = `${top}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapperRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  const choose = (name: string) => {
    onChange(name);
    close();
  };

  // --- Fallback: plain text input ---
  if (loadState === "fallback" || manualMode) {
    return (
      <div className={cx("space-y-1", className)}>
        <input
          className={cx(inputCls, "font-mono")}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="default"
        />
        {loadState === "fallback" && (
          <p className="font-mono text-[10px] text-ink-3">
            Warehouse not connected — enter ID manually
          </p>
        )}
      </div>
    );
  }

  // --- Loading skeleton ---
  if (loadState === "loading") {
    return (
      <div
        className={cx(inputCls, "font-mono text-xs text-ink-3 flex items-center gap-2", className)}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-ink-3 animate-pulse" />
        Connecting…
      </div>
    );
  }

  // --- Ready: dropdown picker ---
  const selectedDb = databases.find((db) => db.name === value);
  const displayLabel = selectedDb ? selectedDb.name : value || null;

  return (
    <div ref={wrapperRef} className={cx("relative", className)}>
      {/* Trigger button — styled identically to the other form inputs */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          inputCls,
          "flex items-center gap-2 text-left font-mono cursor-pointer",
          open && "border-accent",
        )}
      >
        <span className={cx("flex-1 truncate", displayLabel ? "text-ink" : "text-ink-3")}>
          {displayLabel ?? "Select database…"}
        </span>
        {/* Chevron */}
        <svg
          className={cx(
            "h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform",
            open && "rotate-180",
          )}
          viewBox="0 0 16 16"
          fill="none"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* Floating panel */}
      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{ position: "fixed", top: 0, left: 0 }}
            className="zz-rise z-50 min-w-[260px] overflow-hidden border border-line bg-surface shadow-lg"
          >
            <ul className="max-h-60 overflow-y-auto py-1">
              {databases.map((db) => {
                const isSelected = db.name === value;
                return (
                  <li key={db.name}>
                    <button
                      type="button"
                      onClick={() => choose(db.name)}
                      className={cx(
                        "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                        isSelected ? "bg-accent-soft" : "hover:bg-hover",
                      )}
                    >
                      {/* Live indicator */}
                      <span
                        className={cx(
                          "shrink-0 text-[10px] leading-none",
                          db.connected ? "text-green-500 animate-pulse" : "text-ink-3",
                        )}
                        title={db.connected ? "Connected" : "Disconnected"}
                      >
                        ●
                      </span>

                      {/* Database name */}
                      <span
                        className={cx(
                          "flex-1 truncate font-mono text-sm",
                          isSelected ? "text-accent" : "text-ink",
                        )}
                      >
                        {db.name}
                      </span>

                      {/* Table count */}
                      <span className="shrink-0 font-mono text-xs text-ink-3 tabular-nums">
                        {db.tableCount} tables
                      </span>

                      {/* Selected checkmark */}
                      {isSelected && (
                        <svg
                          className="h-3.5 w-3.5 shrink-0 text-accent"
                          viewBox="0 0 16 16"
                          fill="none"
                        >
                          <path
                            d="M3 8l4 4 6-7"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Manual entry escape hatch */}
            <div className="border-t border-line">
              <button
                type="button"
                onClick={() => {
                  close();
                  setManualMode(true);
                }}
                className="flex w-full items-center gap-2 px-3 py-2.5 font-mono text-[11px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
              >
                <svg className="h-3 w-3 shrink-0" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M2 8h12M8 2v12"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                Enter manually
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
