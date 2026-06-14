export interface ConnectionProjection {
  id: string;
  adapter: string;
  label: string;
  credentialsVersion: number;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
}

interface Props {
  connection: ConnectionProjection | null;
  onVerify: () => void;
  onEditCredentials: () => void;
  onDelete: () => void;
  canEditCredentials: boolean;
}

function pill(state: "not configured" | "unverified" | "error" | "reachable", error?: string | null): JSX.Element {
  const cls =
    state === "reachable"
      ? "bg-ok-soft text-ok"
      : state === "error"
        ? "bg-danger-soft text-danger"
        : "bg-surface-2 text-ink-2";
  return (
    <span className={`rounded-pill px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${cls}`}>
      {state === "error" ? `error · ${error?.slice(0, 80)}` : state}
    </span>
  );
}

export function WarehouseCard(props: Props): JSX.Element {
  if (!props.connection) {
    return (
      <div className="rounded-sm border border-line bg-surface p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="font-display text-[14px] font-semibold text-ink">Warehouse</span>
          {pill("not configured")}
        </div>
        <div className="mt-2 text-[12.5px] text-ink-2">
          No warehouse connected — admins can add one to start scanning.
        </div>
      </div>
    );
  }
  const c = props.connection;
  const state =
    c.lastVerifyError
      ? "error"
      : c.lastVerifiedAt
        ? "reachable"
        : "unverified";
  return (
    <div className="rounded-sm border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-display text-[14px] font-semibold text-ink">{c.label}</span>
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-ink-3">{c.adapter}</span>
        </div>
        {pill(state, c.lastVerifyError)}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={props.onVerify}
          className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2"
        >
          Verify connection
        </button>
        <button
          data-action="edit-credentials"
          onClick={props.onEditCredentials}
          disabled={!props.canEditCredentials}
          className="rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-ink hover:bg-bg-2 disabled:opacity-50"
        >
          Edit credentials…
        </button>
        <button
          onClick={props.onDelete}
          disabled={!props.canEditCredentials}
          className="ml-auto rounded-sm border border-line-2 px-3 py-1 font-mono text-[11px] text-danger hover:bg-danger-soft disabled:opacity-50"
        >
          Delete connection
        </button>
      </div>
    </div>
  );
}
