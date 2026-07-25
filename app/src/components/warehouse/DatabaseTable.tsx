import { Badge } from "../Badge";
import { Button } from "../Button";

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
  /** True while the first fetch is in flight — shows a placeholder instead of
   *  flashing the "No databases registered yet" empty state. */
  loading?: boolean;
  canAdd: boolean;
  /** Deployment engine name for the badge / empty state (e.g. "DuckDB", "MotherDuck"). */
  engineName?: string;
  onAdd: () => void;
  onRemove?: (db: DatabaseRow) => void;
}

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function ProbeBadge({ db }: { db: DatabaseRow }) {
  if (db.lastProbeError) {
    return (
      <span title={db.lastProbeError}>
        <Badge tone="warn" dot>
          unreachable{db.lastProbeAt ? ` · ${ago(db.lastProbeAt)}` : ""}
        </Badge>
      </span>
    );
  }
  if (db.lastProbeAt) {
    return (
      <Badge tone="ok" dot>
        reachable · {ago(db.lastProbeAt)}
      </Badge>
    );
  }
  return (
    <span title="Zug Zug hasn't tried connecting to this database yet">
      <Badge dot>not checked yet</Badge>
    </span>
  );
}

function schemaText(n: number | null): string {
  if (n === null) return "— schemas";
  return `${n} schema${n === 1 ? "" : "s"}`;
}

export function DatabaseTable(props: Props): JSX.Element {
  const n = props.databases.length;
  const engine = props.engineName ?? "the warehouse";
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-2 px-4 py-2.5">
        <span className="flex items-center gap-2.5 text-[12px] text-ink-2">
          <Badge tone="accent">{props.engineName ?? "Warehouse"}</Badge>
          {props.loading && n === 0 ? "" : `${n} database${n === 1 ? "" : "s"} registered`}
        </span>
        {props.canAdd && (
          <Button size="sm" onClick={props.onAdd}>
            + Add database
          </Button>
        )}
      </div>

      {props.loading && props.databases.length === 0 ? (
        <div className="px-4 py-6 text-[12.5px] text-ink-3">Loading databases…</div>
      ) : props.databases.length === 0 ? (
        <div className="px-4 py-6 text-[12.5px] text-ink-2">
          No databases registered yet — click “+ Add database” to pick one discovered in {engine}.
        </div>
      ) : (
        <table className="w-full">
          <tbody>
            {props.databases.map((d) => (
              // On phones the three cells can't share one row without clipping, so
              // the row stacks (flex-col) — name, stats, then status + actions.
              <tr
                key={d.id}
                data-row={d.id}
                className="border-b border-line transition-colors last:border-b-0 hover:bg-surface-2 max-sm:flex max-sm:flex-col max-sm:items-start max-sm:gap-1.5 max-sm:py-2"
              >
                <td className="px-4 py-3 align-middle max-sm:py-1">
                  <div className="font-mono text-[12.5px] font-medium text-ink">
                    {d.databaseName}
                  </div>
                  {d.label && (
                    <div className="mt-0.5 text-[11.5px] italic text-ink-3">{d.label}</div>
                  )}
                </td>
                <td className="px-4 py-3 align-middle text-[12px] text-ink-2 max-sm:py-0">
                  {schemaText(d.schemaCount)}
                  <span className="mx-2 text-ink-3">·</span>
                  {d.sourceCount} source value{d.sourceCount === 1 ? "" : "s"}
                </td>
                <td className="px-4 py-3 text-right align-middle max-sm:py-1 max-sm:text-left">
                  <div className="inline-flex items-center gap-2.5">
                    <ProbeBadge db={d} />
                    {props.onRemove && (
                      <Button variant="secondary" size="sm" onClick={() => props.onRemove?.(d)}>
                        Remove
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
