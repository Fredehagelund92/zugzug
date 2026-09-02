import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "../../api";

interface Discovered {
  databaseName: string;
  registered: boolean;
}

interface Props {
  /** Deployment engine name for the "Discovered in …" label (e.g. "DuckDB"). */
  engineName?: string;
  onCancel: () => void;
  onAdded: () => void;
}

export function AddDatabaseDialog(props: Props): JSX.Element {
  const [discovered, setDiscovered] = useState<Discovered[]>([]);
  const [discoverFailed, setDiscoverFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authFetch("/warehouse/databases/available")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<Discovered[]>)
          : Promise.reject(new Error(`status ${r.status}`)),
      )
      .then(setDiscovered)
      .catch(() => setDiscoverFailed(true));
  }, []);

  const onSubmit = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    const r = await authFetch("/warehouse/databases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ databaseName: selected, label: label || undefined }),
    });
    setBusy(false);
    if (r.ok) {
      props.onAdded();
    } else {
      const body = (await r.json().catch(() => ({}))) as { reason?: string; kind?: string };
      setError(body.reason ?? body.kind ?? "Add failed");
    }
  };

  const addable = discovered.filter((d) => !d.registered);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add database"
        className="w-[480px] max-w-full rounded-sm border border-line-2 bg-surface-elevated shadow-pop"
      >
        <div className="border-b border-line p-3 font-display text-[14px] font-semibold text-ink">
          Add database
        </div>
        <div className="space-y-4 p-4">
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
              Discovered in {props.engineName ?? "the warehouse"}
            </div>
            {discoverFailed ? (
              <div className="text-[12.5px] text-danger">
                Could not enumerate databases — check server logs.
              </div>
            ) : discovered.length === 0 ? (
              <div className="text-[12.5px] text-ink-2">Loading…</div>
            ) : addable.length === 0 ? (
              <div className="text-[12.5px] text-ink-2">
                All discovered databases are already registered.
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {discovered.map((d) => (
                  <button
                    key={d.databaseName}
                    data-chip={d.databaseName}
                    onClick={() => !d.registered && setSelected(d.databaseName)}
                    disabled={d.registered}
                    title={d.registered ? "Already registered" : undefined}
                    className={`rounded-pill border px-3 py-1 font-mono text-[11px] ${
                      selected === d.databaseName
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-line-2 text-ink hover:bg-bg-2"
                    } disabled:opacity-50`}
                  >
                    {d.databaseName}
                  </button>
                ))}
              </div>
            )}
          </div>
          {selected && (
            <div>
              <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
                Label (optional)
              </div>
              <input
                name="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Production warehouse"
                className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
              />
            </div>
          )}
          {error && (
            <div className="rounded-sm border border-danger bg-danger-soft p-2 font-mono text-[11px] text-danger">
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line p-3">
          <button
            onClick={props.onCancel}
            className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2"
          >
            Cancel
          </button>
          <button
            onClick={() => void onSubmit()}
            disabled={!selected || busy}
            className="rounded-sm border border-accent bg-accent px-3 py-1 font-mono text-[11px] text-bg hover:opacity-90 disabled:opacity-50"
          >
            Add database
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
