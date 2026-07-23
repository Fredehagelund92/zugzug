import type { CellType } from "./types";

export interface ValidationFieldsProps {
  type: CellType;
  required: boolean;
  onRequiredChange: (v: boolean) => void;
  unique: boolean;
  onUniqueChange: (v: boolean) => void;
  min: string;
  onMinChange: (v: string) => void;
  max: string;
  onMaxChange: (v: string) => void;
}

const UNIQUEABLE: CellType[] = ["text", "number", "date", "url", "email"];
const RANGEABLE: CellType[] = ["number", "date", "text"];

export function ValidationFields({
  type,
  required,
  onRequiredChange,
  unique,
  onUniqueChange,
  min,
  onMinChange,
  max,
  onMaxChange,
}: ValidationFieldsProps) {
  const uniqueable = UNIQUEABLE.includes(type);
  const rangeable = RANGEABLE.includes(type);
  const isText = type === "text";

  return (
    <>
      {/* Required toggle */}
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => onRequiredChange(e.target.checked)}
          className="mt-0.5 rounded-sm"
          style={{ accentColor: "var(--accent)" }}
        />
        <span className="leading-tight">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-2">
            Required
          </span>
          <span className="mt-0.5 block font-body text-[11px] text-ink-3">
            Every record must have a value before the table can be published.
          </span>
        </span>
      </label>

      {/* Unique toggle */}
      {uniqueable && (
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={unique}
            onChange={(e) => onUniqueChange(e.target.checked)}
            className="mt-0.5 rounded-sm"
            style={{ accentColor: "var(--accent)" }}
          />
          <span className="leading-tight">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-2">
              Unique
            </span>
            <span className="mt-0.5 block font-body text-[11px] text-ink-3">
              No two records share a value.
            </span>
          </span>
        </label>
      )}

      {/* Range inputs */}
      {rangeable && (
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
              {isText ? "Min length" : "Min"}
            </span>
            <input
              value={min}
              onChange={(e) => onMinChange(e.target.value)}
              placeholder="—"
              aria-label={isText ? "Min length" : "Min"}
              className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
              {isText ? "Max length" : "Max"}
            </span>
            <input
              value={max}
              onChange={(e) => onMaxChange(e.target.value)}
              placeholder="—"
              aria-label={isText ? "Max length" : "Max"}
              className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-accent"
            />
          </label>
        </div>
      )}
    </>
  );
}
