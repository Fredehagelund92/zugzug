import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/cx";
import {
  IconEdit,
  IconType,
  IconSortAsc,
  IconSortDesc,
  IconX,
  IconEyeOff,
  IconTrash,
  IconChevronLeft,
  IconFilter,
  IconArrowRight,
  IconCheck,
} from "../Icons";
import type { CellType, ColumnConfig, ColumnDef, NumberFormat } from "./types";
import { ValidationFields } from "./ValidationFields";

const IconRules = ({ className }: { className?: string }) => (
  <span className={className} style={{ fontSize: "10px" }}>
    ◈
  </span>
);

interface Props<Row> {
  column: ColumnDef<Row>;
  anchorRef: React.RefObject<HTMLElement | null>;
  anchorRect?: DOMRect | null;
  sortDir: "asc" | "desc" | null;
  filterValue: string | null;
  onClose: () => void;
  onRename: (newLabel: string) => void;
  onSort: (dir: "asc" | "desc" | null) => void;
  onChangeType: (newConfig: ColumnConfig) => void;
  onHide: () => void;
  onDelete: () => void;
  onFilter: (value: string | null) => void;
  onOpenRules?: () => void;
  onSaveValidation?: (next: {
    required?: boolean;
    validation?: { unique?: boolean; min?: number | string | null; max?: number | string | null };
  }) => void;
  onEditDescription?: () => void;
  // Linked-column (fk / lookup) actions. Present the kind-appropriate subset
  // depending on `column.columnKind`.
  onShowLinkedFields?: () => void;
  onOpenTargetDimension?: () => void;
  onChangeDisplayedField?: () => void;
  onManageLinkedFields?: () => void;
  onJumpToSourceColumn?: () => void;
  onRemoveLookup?: () => void;
}

const TYPES: CellType[] = ["text", "number", "boolean", "date", "select", "url", "email", "rating"];
const MENU_WIDTH = 192; // matches w-48
const GAP = 4;

export function ColumnHeaderMenu<Row>({
  column,
  anchorRef,
  anchorRect,
  sortDir,
  filterValue,
  onClose,
  onRename,
  onSort,
  onChangeType,
  onHide,
  onDelete,
  onFilter,
  onOpenRules,
  onSaveValidation,
  onEditDescription,
  onShowLinkedFields,
  onOpenTargetDimension,
  onChangeDisplayedField,
  onManageLinkedFields,
  onJumpToSourceColumn,
  onRemoveLookup,
}: Props<Row>) {
  const [mode, setMode] = useState<
    | "menu"
    | "rename"
    | "type"
    | "number-format"
    | "rating-max"
    | "filter"
    | "confirm-delete"
    | "validation"
  >("menu");

  // Seed validation panel from current column config
  const [valRequired, setValRequired] = useState(column.config.required ?? false);
  const [valUnique, setValUnique] = useState(column.config.validation?.unique ?? false);
  const [valMin, setValMin] = useState(String(column.config.validation?.min ?? ""));
  const [valMax, setValMax] = useState(String(column.config.validation?.max ?? ""));
  const [draft, setDraft] = useState(column.label);
  const [filterDraft, setFilterDraft] = useState(filterValue ?? "");
  const existingFmt = column.config.type === "number" ? column.config.numberFormat : undefined;
  const [numFmt, setNumFmt] = useState<
    "integer" | "decimal" | "percent" | "currency" | "compact" | "duration"
  >(existingFmt?.format ?? "integer");
  const [numPrecision, setNumPrecision] = useState<number>(
    existingFmt && "precision" in existingFmt ? existingFmt.precision : 0,
  );
  const [durationDisplay, setDurationDisplay] = useState<"hm" | "hms">(
    existingFmt?.format === "duration" ? existingFmt.display : "hm",
  );
  const [currSymbol, setCurrSymbol] = useState(
    existingFmt?.format === "currency" ? existingFmt.symbol : "$",
  );
  const [currPosition, setCurrPosition] = useState<"prefix" | "suffix">(
    existingFmt?.format === "currency" ? existingFmt.position : "prefix",
  );
  const [ratingMax, setRatingMax] = useState<number>(
    column.config.type === "rating" ? column.config.ratingMax : 5,
  );
  const [ratingMaxCustom, setRatingMaxCustom] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "rename") {
      renameInputRef.current?.select();
    }
  }, [mode]);

  // Position relative to the anchor (the ⋯ button) using fixed coords. Rendered
  // in a portal on document.body so the menu escapes the grid's stacking
  // context entirely — sticky bars and other contexts can no longer cover it.
  // On mobile (<768px) the menu is centered horizontally in the viewport.
  useLayoutEffect(() => {
    const popover = ref.current;
    if (!popover) return;
    const place = (): void => {
      const a = anchorRect ?? anchorRef.current?.getBoundingClientRect() ?? null;
      if (!a) return;
      const popH = popover.offsetHeight;

      if (window.innerWidth < 768) {
        const left = Math.max(8, (window.innerWidth - MENU_WIDTH) / 2);
        let top = a.bottom + GAP;
        if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - GAP - popH);
        popover.style.top = `${top}px`;
        popover.style.left = `${left}px`;
        return;
      }

      // Point-anchored (zero-size rect from a click): open at the cursor, expanding right + down.
      // Element-anchored (⋯ button): align right edges and drop below the button.
      const pointAnchored = a.width === 0 && a.height === 0;
      let left = pointAnchored ? a.left : a.right - MENU_WIDTH;
      if (left < 8) left = 8;
      if (left + MENU_WIDTH > window.innerWidth - 8) left = window.innerWidth - MENU_WIDTH - 8;
      let top = a.bottom + GAP;
      if (top + popH > window.innerHeight - 8) top = Math.max(8, a.top - GAP - popH);
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef, anchorRect, mode]);

  // Close on outside click. Skip clicks on the anchor button itself so the
  // user can toggle the menu off via the same ⋯ button.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const popover = ref.current;
      const anchor = anchorRef.current;
      const target = e.target as Node;
      if (popover && popover.contains(target)) return;
      if (anchor && anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose, anchorRef]);

  const item =
    "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[11.5px] text-ink hover:bg-hover";
  const iconCls = "h-3.5 w-3.5 shrink-0 text-ink-3";
  const isLookup = column.columnKind === "lookup";
  const isFk = column.columnKind === "fk";

  return createPortal(
    <div
      ref={ref}
      style={{ position: "fixed", top: 0, left: 0, width: MENU_WIDTH }}
      className="zz-pop-in z-40 rounded-sm border border-line-2 bg-surface-elevated p-1 shadow-pop"
    >
      {mode === "menu" && isLookup && (
        <>
          <button
            type="button"
            className={item}
            onClick={() => {
              onSort("asc");
              onClose();
            }}
          >
            <IconSortAsc className={iconCls} /> Sort A→Z
          </button>
          <button
            type="button"
            className={item}
            onClick={() => {
              onSort("desc");
              onClose();
            }}
          >
            <IconSortDesc className={iconCls} /> Sort Z→A
          </button>
          {sortDir != null && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onSort(null);
                onClose();
              }}
            >
              <IconX className={iconCls} /> Clear sort
            </button>
          )}
          {onOpenRules && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onOpenRules();
                onClose();
              }}
            >
              <IconRules className={iconCls} /> Conditional formatting…
            </button>
          )}
          <div className="my-1 h-px bg-line" />
          {onChangeDisplayedField && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onChangeDisplayedField();
                onClose();
              }}
            >
              <IconType className={iconCls} /> Change displayed field…
            </button>
          )}
          {onManageLinkedFields && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onManageLinkedFields();
                onClose();
              }}
            >
              <IconEdit className={iconCls} /> Manage linked fields…
            </button>
          )}
          {onJumpToSourceColumn && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onJumpToSourceColumn();
                onClose();
              }}
            >
              <IconArrowRight className={iconCls} /> Jump to source column →
            </button>
          )}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            className={item}
            onClick={() => {
              onHide();
              onClose();
            }}
          >
            <IconEyeOff className={iconCls} /> Hide column
          </button>
          {onRemoveLookup && (
            <button
              type="button"
              className={cx(item, "text-danger")}
              onClick={() => {
                onRemoveLookup();
                onClose();
              }}
            >
              <IconTrash className="h-3.5 w-3.5 shrink-0" /> Remove this lookup
            </button>
          )}
        </>
      )}
      {mode === "menu" && !isLookup && (
        <>
          <button type="button" className={item} onClick={() => setMode("rename")}>
            <IconEdit className={iconCls} /> Rename column
          </button>
          <button type="button" className={item} onClick={() => setMode("type")}>
            <IconType className={iconCls} /> Change type
          </button>
          <button type="button" className={item} onClick={() => setMode("filter")}>
            <IconFilter className={iconCls} /> Filter…
            {filterValue && (
              <span className="ml-auto rounded-pill bg-accent-wash px-1.5 font-mono text-[9px] text-accent">
                on
              </span>
            )}
          </button>
          {onOpenRules && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onOpenRules();
                onClose();
              }}
            >
              <IconRules className={iconCls} /> Conditional formatting…
            </button>
          )}
          {onSaveValidation && (
            <button type="button" className={item} onClick={() => setMode("validation")}>
              <IconCheck className={iconCls} /> Validation…
            </button>
          )}
          {onEditDescription && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onEditDescription();
                onClose();
              }}
            >
              <IconEdit className={iconCls} /> Edit description…
            </button>
          )}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            className={item}
            onClick={() => {
              onSort("asc");
              onClose();
            }}
          >
            <IconSortAsc className={iconCls} /> Sort A→Z
          </button>
          <button
            type="button"
            className={item}
            onClick={() => {
              onSort("desc");
              onClose();
            }}
          >
            <IconSortDesc className={iconCls} /> Sort Z→A
          </button>
          {sortDir != null && (
            <button
              type="button"
              className={item}
              onClick={() => {
                onSort(null);
                onClose();
              }}
            >
              <IconX className={iconCls} /> Clear sort
            </button>
          )}
          {isFk && (onShowLinkedFields || onOpenTargetDimension) && (
            <>
              <div className="my-1 h-px bg-line" />
              {onShowLinkedFields && (
                <button
                  type="button"
                  className={item}
                  onClick={() => {
                    onShowLinkedFields();
                    onClose();
                  }}
                >
                  <IconEdit className={iconCls} /> Show linked fields…
                </button>
              )}
              {onOpenTargetDimension && (
                <button
                  type="button"
                  className={item}
                  onClick={() => {
                    onOpenTargetDimension();
                    onClose();
                  }}
                >
                  <IconArrowRight className={iconCls} /> Open target dimension →
                </button>
              )}
            </>
          )}
          <div className="my-1 h-px bg-line" />
          <button
            type="button"
            className={item}
            onClick={() => {
              onHide();
              onClose();
            }}
          >
            <IconEyeOff className={iconCls} /> Hide column
          </button>
          <button
            type="button"
            className={cx(item, "text-danger")}
            onClick={() => setMode("confirm-delete")}
          >
            <IconTrash className="h-3.5 w-3.5 shrink-0" /> Delete column
          </button>
        </>
      )}
      {mode === "rename" && (
        <div className="p-1">
          <input
            ref={renameInputRef}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onRename(draft.trim());
                onClose();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none"
          />
          <div className="mt-1.5 flex gap-1">
            <button
              type="button"
              className={cx(item, "justify-center bg-accent text-accent-ink hover:brightness-110")}
              onClick={() => {
                onRename(draft.trim());
                onClose();
              }}
            >
              Save
            </button>
            <button type="button" className={item + " justify-center"} onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {mode === "type" && (
        <div>
          <div className="max-h-[240px] overflow-y-auto">
            {TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={cx(item, column.config.type === t && "bg-accent-wash text-accent")}
                onClick={() => {
                  if (t === "number") {
                    setMode("number-format");
                  } else if (t === "rating") {
                    setMode("rating-max");
                  } else if (t === "select") {
                    onChangeType({ type: "select", options: [] });
                    onClose();
                  } else if (t !== column.config.type) {
                    onChangeType({ type: t } as ColumnConfig);
                    onClose();
                  } else {
                    onClose();
                  }
                }}
              >
                {t}
                {column.config.type === t ? " · current" : ""}
              </button>
            ))}
          </div>
          <div className="my-1 h-px bg-line" />
          <button type="button" className={item} onClick={() => setMode("menu")}>
            <IconChevronLeft className={iconCls} /> Back
          </button>
        </div>
      )}
      {mode === "number-format" && (
        <div className="p-2 space-y-2">
          {/* Back button */}
          <button
            type="button"
            onClick={() => setMode("type")}
            className="flex items-center gap-1 font-mono text-[11px] text-ink-3 hover:text-ink"
          >
            <IconChevronLeft className="h-3 w-3" />
            Back
          </button>

          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3 px-1">
            Number format
          </div>

          {/* Format tiles */}
          {(["integer", "decimal", "percent", "currency", "compact", "duration"] as const).map(
            (f) => (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setNumFmt(f);
                  setNumPrecision(f === "decimal" ? 2 : 0);
                }}
                className={cx(
                  "w-full flex items-center gap-2 rounded-sm border px-2 py-1.5 text-left text-[11px] font-mono transition-colors",
                  numFmt === f
                    ? "border-accent bg-accent-wash text-ink"
                    : "border-line hover:border-line-2 hover:bg-hover text-ink",
                )}
              >
                {
                  {
                    integer: "#",
                    decimal: "#.0",
                    percent: "%",
                    currency: "$",
                    compact: "1.2M",
                    duration: "⏱",
                  }[f]
                }
                <span className="ml-1 capitalize">{f}</span>
              </button>
            ),
          )}

          {/* Precision (decimal / percent / currency) */}
          {(numFmt === "decimal" || numFmt === "percent" || numFmt === "currency") && (
            <div className="flex items-center gap-1.5 px-1">
              <span className="font-mono text-[10px] text-ink-3 w-14">Precision</span>
              {(numFmt === "decimal" ? [1, 2, 3, 4] : [0, 1, 2]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setNumPrecision(p)}
                  className={cx(
                    "h-6 w-6 rounded-sm border font-mono text-[11px] transition-colors",
                    numPrecision === p
                      ? "border-accent bg-accent-wash text-ink"
                      : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {/* Symbol + position (currency only) */}
          {numFmt === "currency" && (
            <div className="space-y-1.5 px-1">
              <div className="flex flex-wrap gap-1">
                {["$", "€", "£", "¥", "kr", "USD", "EUR", "GBP"].map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setCurrSymbol(s)}
                    className={cx(
                      "rounded-sm border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                      currSymbol === s
                        ? "border-accent bg-accent-wash text-ink"
                        : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                    )}
                  >
                    {s}
                  </button>
                ))}
                <input
                  value={currSymbol}
                  onChange={(e) => setCurrSymbol(e.target.value.slice(0, 6))}
                  placeholder="…"
                  className="w-12 rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink outline-none focus:border-accent"
                />
              </div>
              <div className="flex gap-1">
                {(["prefix", "suffix"] as const).map((pos) => (
                  <button
                    key={pos}
                    type="button"
                    onClick={() => setCurrPosition(pos)}
                    className={cx(
                      "flex-1 rounded-sm border px-2 py-1 font-mono text-[10px] capitalize transition-colors",
                      currPosition === pos
                        ? "border-accent bg-accent-wash text-ink"
                        : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                    )}
                  >
                    {pos}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Duration display-mode toggle */}
          {numFmt === "duration" && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-ink-3 w-16 shrink-0">Display</span>
              <div className="flex gap-1">
                {(["hm", "hms"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDurationDisplay(d)}
                    className={cx(
                      "rounded-sm border px-2 py-0.5 font-mono text-[10px] transition-colors",
                      durationDisplay === d
                        ? "border-accent bg-accent-wash text-ink"
                        : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                    )}
                  >
                    {d === "hm" ? "h m" : "h:mm:ss"}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Compact precision picker */}
          {numFmt === "compact" && (
            <div className="flex items-center gap-1.5 px-1">
              <span className="font-mono text-[10px] text-ink-3 w-14">Precision</span>
              {([0, 1, 2] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setNumPrecision(p)}
                  className={cx(
                    "h-6 w-6 rounded-sm border font-mono text-[11px] transition-colors",
                    numPrecision === p
                      ? "border-accent bg-accent-wash text-ink"
                      : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                  )}
                >
                  {p}
                </button>
              ))}
            </div>
          )}

          {/* Confirm button */}
          <button
            type="button"
            onClick={() => {
              let fmt: NumberFormat;
              if (numFmt === "integer") {
                fmt = { format: "integer" };
              } else if (numFmt === "decimal") {
                fmt = { format: "decimal", precision: numPrecision as 1 | 2 | 3 | 4 };
              } else if (numFmt === "percent") {
                fmt = { format: "percent", precision: numPrecision as 0 | 1 | 2 };
              } else if (numFmt === "compact") {
                fmt = { format: "compact", precision: numPrecision as 0 | 1 | 2 };
              } else if (numFmt === "duration") {
                fmt = { format: "duration", display: durationDisplay };
              } else {
                fmt = {
                  format: "currency",
                  symbol: currSymbol || "$",
                  position: currPosition,
                  precision: numPrecision as 0 | 1 | 2,
                };
              }
              onChangeType({ type: "number", numberFormat: fmt });
              onClose();
            }}
            className="w-full rounded-sm border border-accent bg-accent px-3 py-1.5 font-mono text-[11px] text-accent-ink hover:opacity-90"
          >
            Apply
          </button>
        </div>
      )}
      {mode === "rating-max" && (
        <div className="p-2 space-y-2">
          <button
            type="button"
            onClick={() => setMode("type")}
            className="flex items-center gap-1 font-mono text-[11px] text-ink-3 hover:text-ink"
          >
            <IconChevronLeft className="h-3 w-3" /> Back
          </button>
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3 px-1">
            Max stars
          </div>
          <div className="flex gap-1 px-1">
            {[3, 5, 10].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setRatingMax(n);
                  setRatingMaxCustom("");
                }}
                className={cx(
                  "h-7 w-8 rounded-sm border font-mono text-[11px] transition-colors",
                  ratingMax === n && !ratingMaxCustom
                    ? "border-accent bg-accent-wash text-ink"
                    : "border-line hover:border-line-2 hover:bg-hover text-ink-2",
                )}
              >
                {n}
              </button>
            ))}
            <input
              value={ratingMaxCustom}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") {
                  setRatingMaxCustom("");
                  return;
                }
                const n = parseInt(raw, 10);
                if (Number.isInteger(n) && n >= 1 && n <= 20) {
                  setRatingMaxCustom(raw);
                  setRatingMax(n);
                }
              }}
              placeholder="…"
              className="w-10 rounded-sm border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[10px] text-ink outline-none focus:border-accent"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              onChangeType({ type: "rating", ratingMax });
              onClose();
            }}
            className="w-full rounded-sm border border-accent bg-accent px-3 py-1.5 font-mono text-[11px] text-accent-ink hover:opacity-90"
          >
            Apply
          </button>
        </div>
      )}
      {mode === "filter" && (
        <div className="p-1">
          <input
            autoFocus
            value={filterDraft}
            onChange={(e) => setFilterDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onFilter(filterDraft.trim() || null);
                onClose();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="contains…"
            className="w-full rounded-sm border border-accent bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3"
          />
          <div className="mt-1.5 flex gap-1">
            <button
              type="button"
              className={cx(item, "justify-center bg-accent text-accent-ink hover:brightness-110")}
              onClick={() => {
                onFilter(filterDraft.trim() || null);
                onClose();
              }}
            >
              Apply
            </button>
            {filterValue && (
              <button
                type="button"
                className={item + " justify-center"}
                onClick={() => {
                  setFilterDraft("");
                  onFilter(null);
                  onClose();
                }}
              >
                Clear
              </button>
            )}
            <button
              type="button"
              className={item + " justify-center"}
              onClick={() => setMode("menu")}
            >
              <IconChevronLeft className={iconCls} />
            </button>
          </div>
        </div>
      )}
      {mode === "confirm-delete" && (
        <div className="p-2 text-[11.5px] text-ink-2">
          <div className="font-mono">
            Delete <span className="text-ink">{column.label}</span>? This drops the column on every
            row.
          </div>
          <div className="mt-2 flex gap-1">
            <button
              type="button"
              className={cx(item, "justify-center bg-danger text-accent-ink hover:brightness-110")}
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              Delete
            </button>
            <button type="button" className={item + " justify-center"} onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {mode === "validation" && (
        <div className="p-2 space-y-3">
          <button
            type="button"
            onClick={() => setMode("menu")}
            className="flex items-center gap-1 font-mono text-[11px] text-ink-3 hover:text-ink"
          >
            <IconChevronLeft className="h-3 w-3" /> Back
          </button>
          <ValidationFields
            type={column.config.type}
            required={valRequired}
            onRequiredChange={setValRequired}
            unique={valUnique}
            onUniqueChange={setValUnique}
            min={valMin}
            onMinChange={setValMin}
            max={valMax}
            onMaxChange={setValMax}
          />
          <div className="flex gap-1 pt-1">
            <button
              type="button"
              className={cx(item, "justify-center bg-accent text-accent-ink hover:brightness-110")}
              onClick={() => {
                const num = (s: string) =>
                  s.trim() === ""
                    ? undefined
                    : column.config.type === "date"
                      ? s.trim()
                      : Number(s);
                const validationObj: {
                  unique?: boolean;
                  min?: number | string | null;
                  max?: number | string | null;
                } = {};
                if (valUnique) validationObj.unique = true;
                const minV = num(valMin);
                const maxV = num(valMax);
                if (minV !== undefined) validationObj.min = minV;
                if (maxV !== undefined) validationObj.max = maxV;
                onSaveValidation?.({
                  required: valRequired,
                  validation: validationObj,
                });
                onClose();
              }}
            >
              Save
            </button>
            <button
              type="button"
              className={item + " justify-center"}
              onClick={() => setMode("menu")}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
