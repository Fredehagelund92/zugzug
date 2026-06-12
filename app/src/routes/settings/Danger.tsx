import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { RoleGate } from "../../components/settings/RoleGate";
import { useTenant } from "../../lib/tenant-context";
import { apiFetch } from "../../api";
import { toast } from "../../components/Toast";

export function Danger() {
  const tenant = useTenant();
  const navigate = useNavigate();

  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteSlug, setDeleteSlug] = useState("");
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
        toast("Failed to leave workspace.", "error");
        return;
      }
      navigate("/app");
    } finally {
      setBusy(false);
    }
  }

  async function deleteWorkspace() {
    if (deleteSlug !== tenant.slug) return;
    setBusy(true);
    try {
      const res = await apiFetch("", { method: "DELETE" });
      if (!res.ok) {
        toast("Failed to delete workspace.", "error");
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

      {/* Delete confirm — custom inline modal with slug input */}
      {deleteOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-ink/50 p-4 backdrop-blur-sm"
          onClick={() => {
            setDeleteOpen(false);
            setDeleteSlug("");
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            className="w-full max-w-sm rounded-lg border border-line bg-surface-elevated p-5 shadow-pop"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="delete-dialog-title"
              className="font-display text-base font-bold text-ink"
            >
              Delete {tenant.label}?
            </h2>
            <p className="mt-2 text-[13px] text-ink-2">
              This will permanently delete the workspace and all its data. Type{" "}
              <strong className="font-semibold text-ink">{tenant.slug}</strong> to confirm.
            </p>
            <input
              type="text"
              className="mt-3 w-full rounded-sm border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none focus:ring-2 focus:ring-accent"
              placeholder={tenant.slug}
              value={deleteSlug}
              onChange={(e) => setDeleteSlug(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDeleteOpen(false);
                  setDeleteSlug("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={deleteSlug !== tenant.slug || busy}
                loading={busy}
                onClick={() => void deleteWorkspace()}
              >
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
