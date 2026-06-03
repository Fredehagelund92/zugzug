import type { CellCtx, EditCtx } from "../types";

function Renderer<Row>({ value }: CellCtx<Row>) {
  if (value === true)  return <span className="font-mono text-[12px] text-ok">true</span>;
  if (value === false) return <span className="font-mono text-[12px] text-ink-2">false</span>;
  return <span className="font-mono text-[12px] text-ink-3">—</span>;
}

function Editor<Row>({ value, commit }: EditCtx<Row>) {
  const v = value === true ? "true" : value === false ? "false" : "";
  return (
    <select
      autoFocus value={v}
      onChange={(e) => commit(e.target.value === "" ? null : e.target.value === "true")}
      className="w-full cursor-pointer rounded-sm border border-accent bg-bg px-1.5 py-0.5 font-mono text-[12px] text-ink outline-none"
    >
      <option value="">—</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  );
}

export const BooleanCell = { Renderer, Editor };
