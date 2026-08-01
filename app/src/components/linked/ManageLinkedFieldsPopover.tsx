import { useMemo, useState } from "react";
import { AnchoredPopover, type AnchorBox } from "../AnchoredPopover";

export interface TargetFieldOption {
  field: string;
  label: string;
  type: string;
}

interface Props {
  fkLabel: string;
  targetFields: TargetFieldOption[];
  current: string[];
  /** Trigger box, or null when the trigger could not be resolved (centers). */
  anchorRect: AnchorBox | null;
  onCancel: () => void;
  onApply: (next: string[]) => void;
}

/**
 * Pure-UI picker for which target refTable fields to surface as lookup
 * columns alongside an FK. The parent owns visibility (conditionally render),
 * positioning (passes `anchorRect`), and persistence (wires `onApply` to the
 * store action `updateFieldDisplayFields`). No store access here.
 *
 * Invariants enforced visually + in the apply payload:
 * - `label` is always included and never togglable.
 * - Target fields whose type is `linked` cannot be selected (no chained
 *   lookups). They render disabled with an explanatory tooltip.
 * - Apply payload is ordered: `label` first, then selected non-label fields
 *   in `targetFields` order (stable across renders).
 */
export function ManageLinkedFieldsPopover(props: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set(props.current));

  // Order rows so the checked ones bubble up under `label`, then unchecked
  // sorted alphabetically. `label` is always pinned first regardless of order.
  const sortedFields = useMemo(() => {
    const label = props.targetFields.find((f) => f.field === "label");
    const others = props.targetFields.filter((f) => f.field !== "label");
    const checked = others.filter((f) => selected.has(f.field));
    const unchecked = others.filter((f) => !selected.has(f.field));
    unchecked.sort((a, b) => a.label.localeCompare(b.label));
    return [label, ...checked, ...unchecked].filter(Boolean) as TargetFieldOption[];
  }, [props.targetFields, selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return sortedFields;
    return sortedFields.filter((f) => f.field === "label" || f.label.toLowerCase().includes(q));
  }, [sortedFields, query]);

  const toggle = (field: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const apply = (): void => {
    // `label` is always first and always present — the checkbox is disabled
    // so users can't opt out, and the lookup column for it doesn't actually
    // render (the FK cell already shows the label).
    const order: string[] = ["label"];
    for (const f of props.targetFields) {
      if (f.field === "label") continue;
      if (selected.has(f.field)) order.push(f.field);
    }
    props.onApply(order);
  };

  // AnchoredPopover portals to document.body — escaping the grid's transformed
  // scroll containers — and clamps to the viewport. It also treats an unresolved
  // (all-zero) anchor rect as "no anchor" and centers instead, rather than
  // pinning the popover to the top-left corner (#203).
  return (
    <AnchoredPopover
      anchor={props.anchorRect}
      onDismiss={props.onCancel}
      role="dialog"
      aria-label="Manage linked fields"
      className="w-[320px] rounded-sm border border-line-2 bg-surface-elevated shadow-pop"
    >
      <div className="border-b border-line p-2">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
          Show linked fields — {props.fkLabel}
        </div>
        <input
          type="search"
          placeholder="Search fields…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1 font-mono text-[11px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />
      </div>
      <div className="max-h-[260px] overflow-y-auto p-2">
        {filtered.map((f) => {
          const disabled = f.field === "label" || f.type === "linked";
          const checked = selected.has(f.field) || f.field === "label";
          return (
            <label
              key={f.field}
              data-field={f.field}
              className={`flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1 font-mono text-[11px] hover:bg-hover ${
                disabled ? "opacity-60" : ""
              }`}
              title={
                f.type === "linked" ? "Lookups through another link are not supported" : undefined
              }
            >
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggle(f.field)}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span className="text-ink">{f.label}</span>
              </span>
              <span className="text-ink-3">{f.type}</span>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-line p-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={apply}
          className="rounded-sm border border-accent bg-accent px-3 py-1 font-mono text-[11px] text-accent-ink hover:opacity-90"
        >
          Apply
        </button>
      </div>
    </AnchoredPopover>
  );
}
