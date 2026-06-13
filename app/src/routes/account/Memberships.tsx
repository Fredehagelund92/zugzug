import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { authFetch } from "../../api";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { EmptyState } from "../../components/EmptyState";
import { toast } from "../../components/Toast";
import { readServerError } from "../../lib/api-errors";
import type { Membership } from "../../components/TenantLayout";

const ROLE_LABEL: Record<Membership["role"], string> = {
  admin: "admin",
  editor: "editor",
  viewer: "viewer",
};

export function Memberships() {
  const { memberships } = useOutletContext<{ memberships: Membership[] }>();
  const [leaving, setLeaving] = useState<Membership | null>(null);
  const [busy, setBusy] = useState(false);

  const leave = async () => {
    if (!leaving) return;
    setBusy(true);
    try {
      const res = await authFetch(`/t/${leaving.slug}/leave`, { method: "POST" });
      if (res.status === 409) {
        toast(`Can't leave ${leaving.label} — you're the last admin.`, "error");
        setLeaving(null);
        return;
      }
      if (!res.ok) {
        const msg = await readServerError(res);
        toast(`Couldn't leave ${leaving.label} — ${msg}.`, "error");
        return;
      }
      toast(`Left ${leaving.label}.`, "success");
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Workspaces"
      hint="Every workspace you belong to. Leave any to remove yourself."
    >
      {memberships.length === 0 ? (
        <EmptyState
          title="No memberships yet"
          body="You haven't joined any workspaces yet."
        />
      ) : (
        <ul className="divide-y divide-line border border-line">
          {memberships.map((m) => (
            <li key={m.slug} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink truncate">{m.label}</div>
                <div className="font-mono text-[10.5px] text-ink-3">
                  /{m.slug} · {ROLE_LABEL[m.role]}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setLeaving(m)}>
                Leave
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={leaving !== null}
        title={leaving ? `Leave ${leaving.label}?` : ""}
        body="You'll lose access immediately."
        confirmLabel="Leave"
        danger
        loading={busy}
        onConfirm={leave}
        onCancel={() => setLeaving(null)}
      />
    </SettingsSection>
  );
}
