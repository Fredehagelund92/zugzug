import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { RoleGate } from "../../components/settings/RoleGate";
import { useTenant } from "../../lib/tenant-context";
import { apiFetch } from "../../api";
import { toast } from "../../components/Toast";
import { readServerError } from "../../lib/api-errors";

export function Danger() {
  const tenant = useTenant();
  const navigate = useNavigate();

  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function leave() {
    setBusy(true);
    try {
      const res = await apiFetch("/leave", { method: "POST" });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        const code = (body as { code?: string }).code;
        if (code === "last_admin") {
          toast(
            "You are the last admin of this workspace. Transfer ownership before leaving.",
            "error",
          );
          setLeaveOpen(false);
          return;
        }
      }
      if (!res.ok) {
        const msg = await readServerError(res);
        toast(`Couldn't leave workspace — ${msg}.`, "error");
        return;
      }
      navigate("/app");
    } finally {
      setBusy(false);
    }
  }

  async function deleteWorkspace() {
    setBusy(true);
    try {
      const res = await apiFetch("", { method: "DELETE" });
      if (!res.ok) {
        const msg = await readServerError(res);
        toast(`Couldn't delete workspace — ${msg}.`, "error");
        return;
      }
      navigate("/app");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <SettingsSection
        title="Danger zone"
        hint="Irreversible actions affecting your workspace membership or the workspace itself."
      >
        {/* Leave workspace — always visible */}
        <div className="flex items-center justify-between rounded-md border border-line p-4">
          <div>
            <p className="text-sm font-semibold text-ink">Leave workspace</p>
            <p className="mt-0.5 text-xs text-ink-2">
              You will immediately lose access to this workspace.
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={() => setLeaveOpen(true)}>
            Leave workspace
          </Button>
        </div>

        {/* Delete workspace — admin only */}
        <RoleGate action="settings.danger.delete">
          <div className="flex items-center justify-between rounded-md border border-danger/40 p-4">
            <div>
              <p className="text-sm font-semibold text-ink">Delete workspace</p>
              <p className="mt-0.5 text-xs text-ink-2">
                Permanently deletes this workspace and all its data. This cannot be undone.
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setDeleteOpen(true)}>
              Delete workspace
            </Button>
          </div>
        </RoleGate>
      </SettingsSection>

      {/* Leave confirm dialog */}
      <ConfirmDialog
        open={leaveOpen}
        title={`Leave ${tenant.label}?`}
        body="You will immediately lose access to this workspace."
        confirmLabel="Leave"
        danger
        onConfirm={leave}
        onCancel={() => setLeaveOpen(false)}
      />

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
