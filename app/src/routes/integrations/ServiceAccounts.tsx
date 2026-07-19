import { useEffect, useState } from "react";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { SkeletonList } from "../../components/Skeleton";
import { FormField } from "../../components/FormField";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { toast } from "../../components/Toast";
import {
  listServiceAccounts,
  createServiceAccount,
  revokeServiceAccount,
  humanError,
  type ServiceAccount,
  IntegrationsApiError,
} from "../../lib/integrations-api";
import { SecretRevealModal } from "./SecretRevealModal";
import { DeveloperDetails } from "../../components/integrations/DeveloperDetails";

const EXPIRY_OPTIONS = [
  { label: "Never", value: "never" as const, days: null as number | null },
  { label: "90 days", value: "90d" as const, days: 90 },
  { label: "1 year", value: "1y" as const, days: 365 },
];

export function ServiceAccounts() {
  const tenant = useTenant();
  const canView = can(tenant, "integrations.service_accounts.view");
  const canEdit = can(tenant, "integrations.service_accounts.edit");

  const [items, setItems] = useState<ServiceAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<(typeof EXPIRY_OPTIONS)[number]>(EXPIRY_OPTIONS[1]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<{ id: string; name: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setItems(await listServiceAccounts());
    setLoading(false);
  };
  useEffect(() => {
    if (canView) void refresh();
  }, [canView]);

  if (!canView) {
    return <p className="text-[13px] text-ink-3">Service accounts are admin-only.</p>;
  }

  if (loading) return <SkeletonList rows={3} columns={[100, 80, 120, 100, 100, 50]} />;

  const submit = async () => {
    setCreateError(null);
    try {
      const exp =
        expiry.days == null ? null : new Date(Date.now() + expiry.days * 86_400_000).toISOString();
      const out = await createServiceAccount({ name: name.trim(), expires_at: exp });
      setSecret(out.value);
      setName("");
      setShowForm(false);
      await refresh();
    } catch (e) {
      const code = e instanceof IntegrationsApiError ? e.code : "create_failed";
      const msg = humanError(code);
      setCreateError(msg);
      toast(msg, "error");
    }
  };

  const doRevoke = async () => {
    if (!revoke) return;
    try {
      await revokeServiceAccount(revoke.id);
      setRevoke(null);
      await refresh();
    } catch (e) {
      const code = e instanceof IntegrationsApiError ? e.code : "revoke_failed";
      toast(humanError(code), "error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[15px] font-semibold text-ink">Service accounts</h2>
        {canEdit && !showForm && (
          <Button onClick={() => setShowForm(true)}>+ New service account</Button>
        )}
      </div>

      {showForm && (
        <Panel padding="sm" className="space-y-3">
          <FormField label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="dbt prod"
              className="w-full rounded-sm border border-line bg-surface-2 px-2 py-1.5 text-[13px]"
            />
          </FormField>
          <FormField label="Expires">
            <div className="flex gap-2">
              {EXPIRY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  onClick={() => setExpiry(o)}
                  className={`px-2 py-1 rounded-sm text-[12px] border ${expiry.value === o.value ? "border-accent text-accent" : "border-line text-ink-2"}`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </FormField>
          <FormField label="Scopes">
            <div className="flex items-center gap-2 text-[12px] text-ink-2">
              <Badge>read</Badge>
              <span>(v1 ships read-only; more scopes coming.)</span>
            </div>
          </FormField>
          {createError && <p className="text-[12px] text-danger">{createError}</p>}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setShowForm(false);
                setName("");
                setCreateError(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={!name.trim()}>
              Create
            </Button>
          </div>
        </Panel>
      )}

      {items.length === 0 && !showForm ? (
        <EmptyState
          title="No service accounts yet"
          body="Workspace-scoped credentials. Persist when team members leave."
          action={
            canEdit ? <Button onClick={() => setShowForm(true)}>Create one</Button> : undefined
          }
        />
      ) : (
        <Panel padding="sm">
          <table className="w-full text-[13px]">
            <thead className="text-ink-3 text-left">
              <tr>
                <th className="py-2">Name</th>
                <th>Prefix</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>Expires</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((sa) => (
                <tr key={sa.id} className="border-t border-line">
                  <td className="py-2">{sa.name}</td>
                  <td className="font-mono text-[12px]">{sa.token_prefix}•••</td>
                  <td>
                    {sa.scopes.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </td>
                  <td>{sa.last_used_at?.slice(0, 10) ?? "never"}</td>
                  <td>{sa.expires_at?.slice(0, 10) ?? "never"}</td>
                  <td className="text-right">
                    {canEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger hover:text-danger"
                        onClick={() => setRevoke({ id: sa.id, name: sa.name })}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <DeveloperDetails id="sa-list" summary="Developer details">
        <div>
          Token format: <code>zzsa_*</code>; argon2id-hashed at rest; prefix-indexed lookup for the
          auth fast path.
        </div>
      </DeveloperDetails>

      {secret && (
        <SecretRevealModal
          value={secret}
          onClose={() => setSecret(null)}
          title="Copy your service account token"
        />
      )}
      {revoke && (
        <ConfirmDialog
          open
          title={`Revoke ${revoke.name}?`}
          body={
            <p>
              This will immediately invalidate the token. Any integration using it will start
              receiving 401 errors.
            </p>
          }
          confirmLabel="Revoke"
          danger
          onCancel={() => setRevoke(null)}
          onConfirm={() => void doRevoke()}
        />
      )}
    </div>
  );
}
