import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch } from "../../api";

interface Discovered {
  databaseName: string;
  registered: boolean;
}

interface Props {
  onCancel: () => void;
  onAdded: () => void;
}

export function AddDatabaseDialog(props: Props): JSX.Element {
  const [discovered, setDiscovered] = useState<Discovered[]>([]);
  const [discoverFailed, setDiscoverFailed] = useState(false);
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [probeOk, setProbeOk] = useState<boolean | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch("/warehouse/databases/available")
      .then((r) =>
        r.ok ? (r.json() as Promise<Discovered[]>) : Promise.reject(new Error(`status ${r.status}`)),
      )
      .then(setDiscovered)
      .catch(() => setDiscoverFailed(true));
  }, []);

  const canAdd =
    (selectedChip !== null &&
      !discovered.find((d) => d.databaseName === selectedChip)?.registered) ||
    (name.length > 0 && probeOk === true);

  const onPickChip = (n: string): void => {
    if (discovered.find((d) => d.databaseName === n)?.registered) return;
    setSelectedChip(n);
    setName(n);
    setProbeOk(true);
    setProbeError(null);
  };

  const onChangeName = (v: string): void => {
    setName(v);
    setSelectedChip(null);
    setProbeOk(null);
    setProbeError(null);
  };

  const onSubmit = async (): Promise<void> => {
    setBusy(true);
    const r = await apiFetch("/warehouse/databases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ databaseName: name, label: label || undefined }),
    });
    setBusy(false);
    if (r.ok) {
      props.onAdded();
    } else {
      const body = await r
        .json()
        .catch(() => ({}) as { reason?: string; kind?: string });
      setProbeError(
        (body as { reason?: string; kind?: string }).reason ??
          (body as { kind?: string }).kind ??
          "Add failed",
      );
      setProbeOk(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add database"
        className="w-[480px] rounded-sm border border-line-2 bg-surface-elevated shadow-pop"
      >
        <div className="border-b border-line p-3 font-display text-[14px] font-semibold text-ink">
          Add database
        </div>
        <div className="space-y-4 p-4">
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
              Discovered
            </div>
            {discoverFailed ? (
              <div className="text-[12.5px] text-ink-2">
                Could not enumerate — enter manually.
              </div>
            ) : discovered.length === 0 ? (
              <div className="text-[12.5px] text-ink-2">Loading…</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {discovered.map((d) => (
                  <button
                    key={d.databaseName}
                    data-chip={d.databaseName}
                    onClick={() => onPickChip(d.databaseName)}
                    disabled={d.registered}
                    title={d.registered ? "Already registered" : undefined}
                    className={`rounded-pill border px-3 py-1 font-mono text-[11px] ${
                      selectedChip === d.databaseName
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
          <div>
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
              Manual entry
            </div>
            <input
              name="databaseName"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="database name"
              className="w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
            />
            <input
              name="label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="label (optional)"
              className="mt-2 w-full rounded-sm border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
            />
            {probeOk === false && probeError && (
              <div className="mt-2 rounded-sm border border-danger bg-danger-soft p-2 font-mono text-[11px] text-danger">
                {probeError}
              </div>
            )}
          </div>
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
            disabled={!canAdd || busy}
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
