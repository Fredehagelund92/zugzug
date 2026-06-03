import { useEffect, useMemo, useRef, useState } from "react";
import { Chip } from "../Chip";
import type { CellCtx, EditCtx } from "../types";

/* SelectCell — single-select chip. Renderer shows the chip; Editor opens a
   picker (search + filtered options + "create new" affordance). Options live
   on the column definition (FieldDef.options). Creating a new option fires
   onCreate (host wires this to addColumnOption). */

function Renderer<Row>({ value }: CellCtx<Row>) {
  if (value == null || value === "") return <span className="font-mono text-[12px] text-ink-3">—</span>;
  return <Chip label={String(value)} />;
}

interface SelectEditorProps<Row> extends EditCtx<Row> {
  options: string[];
  onCreate: (label: string) => Promise<string[]>; // returns the new options list
}

function Editor<Row>(props: SelectEditorProps<Row>) {
  const { value, commit, cancel, options, onCreate } = props;
  const [opts, setOpts] = useState(options);
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return opts;
    return opts.filter((o) => o.toLowerCase().includes(needle));
  }, [opts, q]);
  const exact = filtered.some((o) => o.toLowerCase() === q.trim().toLowerCase());
  const canCreate = q.trim().length > 0 && !exact;

  const choose = (label: string) => commit(label);
  const create = async () => {
    const label = q.trim();
    if (!label) return;
    const next = await onCreate(label);
    setOpts(next);
    commit(label);
  };

  return (
    <div className="absolute left-0 top-0 z-30 w-[220px] rounded-sm border border-line-2 bg-surface p-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef} value={q}
        placeholder="search or create…"
        onChange={(e) => { setQ(e.target.value); setHl(0); }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); cancel(); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setHl((h) => Math.min(filtered.length, h + 1)); return; }
          if (e.key === "ArrowUp")   { e.preventDefault(); setHl((h) => Math.max(0, h - 1)); return; }
          if (e.key === "Enter") {
            e.preventDefault();
            if (hl < filtered.length) choose(filtered[hl]);
            else if (canCreate) void create();
            return;
          }
        }}
        className="mb-1 w-full rounded-sm border border-line-2 bg-bg px-2 py-1 font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
      />
      <div className="max-h-48 overflow-y-auto">
        {filtered.map((o, i) => (
          <button
            key={o} type="button"
            onMouseEnter={() => setHl(i)}
            onMouseDown={(e) => { e.preventDefault(); choose(o); }}
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left ${i === hl ? "bg-accent-wash" : "hover:bg-hover"}`}
          >
            <Chip label={o} />
          </button>
        ))}
        {value != null && value !== "" && !filtered.includes(String(value)) && (
          <div className="px-2 py-1 font-mono text-[10.5px] text-ink-3">current: {String(value)}</div>
        )}
        {canCreate && (
          <button
            type="button"
            onMouseEnter={() => setHl(filtered.length)}
            onMouseDown={(e) => { e.preventDefault(); void create(); }}
            className={`mt-1 flex w-full items-center gap-1.5 border-t border-line px-2 py-1.5 text-left font-mono text-[11px] text-accent ${hl === filtered.length ? "bg-accent-wash" : ""}`}
          >
            + create option “{q.trim()}”
          </button>
        )}
      </div>
    </div>
  );
}

export const SelectCell = { Renderer, Editor };
