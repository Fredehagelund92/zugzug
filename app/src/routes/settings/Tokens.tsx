import { useState, useEffect, useCallback } from "react";
import { Button } from "../../components/Button";
import {
  listApiTokens,
  createApiToken,
  revokeApiToken,
  type ApiToken,
  type CreatedApiToken,
} from "../../store";
import { SettingsSection } from "../../components/settings/SettingsSection";
import { ReadOnly } from "../../components/settings/ReadOnly";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";

function formatDate(iso: string): string {
  return iso.slice(0, 10); // "2026-06-09"
}

export function Tokens() {
  const tenant = useTenant();
  const canEdit = can(tenant, "settings.tokens.edit");

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await listApiTokens();
      setTokens(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tokens.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const tok = await createApiToken(newName.trim());
      setCreatedToken(tok);
      setShowForm(false);
      setNewName("");
      void load();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create token.");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeApiToken(id);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke token.");
    }
  };

  const handleCopy = () => {
    if (!createdToken) return;
    void navigator.clipboard.writeText(createdToken.value);
    setCopied(true);
  };

  return (
    <SettingsSection
      title="API tokens"
      hint="Personal access tokens for headless access (dbt, CI). Each token authenticates as you. Revoke to invalidate."
    >
      <ReadOnly enabled={!canEdit}>
        {error && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border border-danger/40 bg-danger-soft px-4 py-2.5 font-mono text-[11.5px] text-danger">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => setError(null)}>
              Dismiss
            </Button>
          </div>
        )}

        {createdToken && (
          <div className="rounded-sm border border-warn/40 bg-warn-soft px-4 py-3">
            <p className="mb-2 text-[13px] font-semibold text-warn">
              Copy this token now — it won&rsquo;t be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all rounded-sm border border-warn/30 bg-bg px-3 py-1.5 font-mono text-[12px] text-ink">
                {createdToken.value}
              </code>
              <Button size="sm" onClick={handleCopy}>
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setCreatedToken(null);
                  setCopied(false);
                }}
              >
                Done
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="font-mono text-[11px] text-ink-3">Loading tokens…</p>
        ) : (
          <ul className="divide-y divide-line rounded-sm border border-line">
            {tokens.length === 0 && !showForm && (
              <li className="px-4 py-3 text-[13px] text-ink-3">No tokens yet.</li>
            )}
            {tokens.map((tok) => (
              <li key={tok.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                  {tok.name}
                </span>
                <span className="hidden shrink-0 text-[11px] text-ink-3 sm:inline">
                  created {formatDate(tok.created_at)}
                </span>
                <span className="shrink-0 text-[11px] text-ink-3">
                  {tok.last_used_at ? `used ${formatDate(tok.last_used_at)}` : "never used"}
                </span>
                <button
                  type="button"
                  onClick={() => setRevokeTarget({ id: tok.id, name: tok.name })}
                  className="shrink-0 rounded-sm text-[11px] text-ink-3 transition-colors hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}

        {showForm && (
          <div className="flex items-center gap-2">
            <input
              className="flex-1 rounded-sm border border-line-2 bg-bg px-3 py-1.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/40"
              placeholder="Token name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate();
                if (e.key === "Escape") {
                  setShowForm(false);
                  setNewName("");
                }
              }}
              autoFocus
              disabled={creating}
            />
            <Button onClick={() => void handleCreate()} loading={creating} disabled={!newName.trim()}>
              Generate
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setShowForm(false);
                setNewName("");
                setCreateError(null);
              }}
              disabled={creating}
            >
              Cancel
            </Button>
          </div>
        )}

        {createError && (
          <div className="rounded-sm border border-danger/40 bg-danger-soft px-4 py-2.5 font-mono text-[11.5px] text-danger">
            {createError}
          </div>
        )}

        {!showForm && (
          <div className="flex justify-end">
            <Button onClick={() => setShowForm(true)}>Create token</Button>
          </div>
        )}

        <ConfirmDialog
          open={revokeTarget !== null}
          title="Revoke this token?"
          body={
            revokeTarget && (
              <>
                Token{" "}
                <code className="rounded-sm bg-surface-2 px-1 font-mono text-[12px]">
                  {revokeTarget.name}
                </code>{" "}
                will stop working immediately. Anything using it (dbt, CI, scripts) will break until
                you generate a new one.
              </>
            )
          }
          confirmLabel="Revoke"
          danger
          onConfirm={async () => {
            if (!revokeTarget) return;
            await handleRevoke(revokeTarget.id);
            setRevokeTarget(null);
          }}
          onCancel={() => setRevokeTarget(null)}
        />
      </ReadOnly>
    </SettingsSection>
  );
}
