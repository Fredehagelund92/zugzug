import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { RoleGate } from "../../components/settings/RoleGate";
import { DangerZone } from "../../components/settings/DangerZone";
import { useTenant } from "../../lib/tenant-context";
import { apiFetch } from "../../api";
import { toast } from "../../components/Toast";
import { readServerError } from "../../lib/api-errors";
import { invalidate, getMemberships } from "../../store";

export function Danger() {
  const tenant = useTenant();
  const navigate = useNavigate();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function deleteWorkspace() {
    setBusy(true);
    try {
      const res = await apiFetch("", { method: "DELETE" });
      if (!res.ok) {
        const msg = await readServerError(res);
        toast(`Couldn't delete workspace — ${msg}.`, "error");
        return;
      }
      // Refresh memberships + admin tenant list so the switcher and
      // Admin → Workspaces table drop the deleted row immediately.
      await invalidate.memberships();
      invalidate.tenantList();
      const next = getMemberships().find((m) => m.slug !== tenant.slug)?.slug;
      navigate(next ? `/app/${next}` : "/app");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSection
        title="Danger zone"
        hint="Irreversible actions affecting the workspace itself."
      >
        {/* Delete workspace — admin only */}
        <RoleGate action="settings.danger.delete">
          <DangerZone className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-ink">Delete workspace</p>
              <p className="mt-0.5 text-xs text-ink-2">
                {tenant.slug === "default"
                  ? "The default workspace cannot be deleted — it's the fallback every user lands in."
                  : "Permanently deletes this workspace and all its data. This cannot be undone."}
              </p>
            </div>
            {tenant.slug === "default" ? (
              <Button
                variant="danger"
                size="sm"
                disabled
                title="The default workspace cannot be deleted."
              >
                Delete workspace
              </Button>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
                Delete workspace
              </Button>
            )}
          </DangerZone>
        </RoleGate>
      </SettingsSection>

      <ConfirmDialog
        open={deleteOpen}
        title={`Delete ${tenant.label}?`}
        body={
          <>
            This will permanently delete the workspace and all its data. Type{" "}
            <strong className="font-semibold text-ink">{tenant.slug}</strong> to confirm.
          </>
        }
        confirmPhrase={tenant.slug}
        confirmLabel="Delete"
        danger
        loading={busy}
        onConfirm={() => void deleteWorkspace()}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}
