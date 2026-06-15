import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "../../api";
import type { DatabaseRow } from "./DatabaseTable";

/* RemoveDatabaseConfirm — first DELETE probes for in-use dependencies (409
   surfaces dimensions + source counts). The admin checks "I understand" and
   re-issues the request with ?force=true, which unbinds the sources but
   preserves canonical values. Successful (204) deletes resolve immediately
   without a confirmation step. */

interface Props {
  database: DatabaseRow;
  onCancel: () => void;
  onRemoved: () => void;
}

interface Dependents {
  sourceCount: number;
  dimensions: Array<{ dimId: string; sources: string[] }>;
}

export function RemoveDatabaseConfirm({ database, onCancel, onRemoved }: Props): JSX.Element {
  const [deps, setDeps] = useState<Dependents | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    authFetch(`/warehouse/databases/${database.id}`, { method: "DELETE" })
      .then(async (r) => {
        if (cancelled) return;
        if (r.ok || r.status === 204) {
          onRemoved();
          return;
        }
        if (r.status === 409) {
          const body = (await r.json()) as {
            sourceCount?: number;
            dimensions?: Dependents["dimensions"];
          };
          setDeps({
            sourceCount: body.sourceCount ?? 0,
            dimensions: body.dimensions ?? [],
          });
        } else {
          setError(`Unexpected response: ${r.status}`);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [database.id, onRemoved]);

  const force = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await authFetch(`/warehouse/databases/${database.id}?force=true`, {
        method: "DELETE",
      });
      if (r.ok || r.status === 204) {
        onRemoved();
        return;
      }
      const body = (await r.json().catch(() => ({}))) as { error?: string; reason?: string };
      setError(`Force delete failed: ${body.error ?? body.reason ?? r.status}`);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Remove database"
        className="w-[520px] rounded-sm border border-line-2 bg-surface-elevated shadow-pop"
      >
        <div className="border-b border-line p-3 font-display text-[14px] font-semibold text-ink">
          Remove database {database.databaseName}?
        </div>
        <div className="space-y-2 p-4 text-[12.5px] text-ink-2">
          {error ? (
            <div className="rounded-sm border border-danger bg-danger-soft p-2 font-mono text-[11px] text-danger">
              {error}
            </div>
          ) : !deps ? (
            <div>Checking dependencies…</div>
          ) : (
            <>
              <div>
                This database powers {deps.sourceCount} source
                {deps.sourceCount === 1 ? "" : "s"} across {deps.dimensions.length} dimension
                {deps.dimensions.length === 1 ? "" : "s"}:
              </div>
              <ul className="ml-4 list-disc">
                {deps.dimensions.map((d) => (
                  <li key={d.dimId}>
                    <span className="font-mono">{d.dimId}</span> ({d.sources.length} source
                    {d.sources.length === 1 ? "" : "s"})
                    <ul className="ml-4">
                      {d.sources.map((s) => (
                        <li key={s} className="font-mono text-[11px]">
                          {s}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <div className="rounded-sm border border-line bg-bg-2 p-2 text-ink-2">
                Removing the database also removes these sources from the dimensions. Canonical
                values stay; only the source binding goes away.
              </div>
              <label className="mt-2 flex items-center gap-2">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I understand the sources will be unbound.</span>
              </label>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line p-3">
          <button
            onClick={onCancel}
            className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2"
          >
            Cancel
          </button>
          <button
            disabled={!deps || !ack || busy}
            onClick={() => void force()}
            className="rounded-sm border border-danger bg-danger px-3 py-1 font-mono text-[11px] text-bg hover:opacity-90 disabled:opacity-50"
          >
            Remove and unbind sources
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
