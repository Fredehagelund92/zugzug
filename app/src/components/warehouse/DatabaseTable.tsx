export interface DatabaseRow {
  id: string;
  databaseName: string;
  label: string | null;
  addedAt: string;
  sourceCount: number;
  schemaCount: number | null;
  lastProbeAt: string | null;
  lastProbeError: string | null;
}

interface Props {
  databases: DatabaseRow[];
  canAdd: boolean;
  onAdd: () => void;
  onRemove?: (db: DatabaseRow) => void;
}

export function DatabaseTable(props: Props): JSX.Element {
  return (
    <div className="rounded-sm border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line p-3">
        <span className="font-display text-[14px] font-semibold text-ink">Databases</span>
        {props.canAdd && (
          <button
            onClick={props.onAdd}
            className="rounded-sm border border-accent bg-accent px-3 py-1 font-mono text-[11px] text-bg hover:opacity-90"
          >
            + Add database
          </button>
        )}
      </div>
      {props.databases.length === 0 ? (
        <div className="p-4 text-[12.5px] text-ink-2">
          No databases registered yet — click "+ Add database" to pick one discovered in MotherDuck.
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.18em] text-ink-3">
              <th className="p-3">Name</th>
              <th className="p-3">Label</th>
              <th className="p-3">Schemas</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {props.databases.map((d) => (
              <tr key={d.id} data-row={d.id} className="border-b border-line last:border-b-0">
                <td className="p-3 font-mono text-[12px] text-ink">{d.databaseName}</td>
                <td className="p-3 italic text-ink-2">{d.label ?? "—"}</td>
                <td className="p-3 text-ink-2">
                  {d.schemaCount === null
                    ? "—"
                    : `${d.schemaCount} schema${d.schemaCount === 1 ? "" : "s"}`}
                </td>
                <td className="p-3 text-right">
                  {d.lastProbeError && (
                    <span className="mr-2 rounded-pill bg-danger-soft px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-danger">
                      unreachable
                    </span>
                  )}
                  {props.onRemove && (
                    <button
                      onClick={() => props.onRemove?.(d)}
                      className="rounded-sm border border-line-2 px-2 py-0.5 font-mono text-[11px] text-ink hover:bg-bg-2"
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
