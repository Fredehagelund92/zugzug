import { useEffect, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Badge } from "../../components/Badge";
import { SkeletonList } from "../../components/Skeleton";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { toast } from "../../components/Toast";
import { useTenantNavigate, useNavLinks } from "../../lib/use-tenant-navigate";
import {
  getWebhook,
  patchWebhook,
  deleteWebhook,
  reactivateWebhook,
  rotateSecret,
  sendTestEvent,
  humanError,
  IntegrationsApiError,
  type Webhook,
} from "../../lib/integrations-api";

function toastError(e: unknown, fallback: string): void {
  const code = e instanceof IntegrationsApiError ? e.code : fallback;
  toast(humanError(code), "error");
}
import { SecretRevealModal } from "./SecretRevealModal";
import { DeliveryLog } from "./DeliveryLog";

/** Kid badge is only meaningful during the 24h rotation grace window: the
 *  previous secret is still accepted until `secret_previous_expires_at`. */
export function showKidBadge(previousExpiresAt: string | null): boolean {
  if (!previousExpiresAt) return false;
  return new Date(previousExpiresAt).getTime() > Date.now();
}

export function WebhookDetail() {
  const { id = "" } = useParams();
  const tenant = useTenant();
  const canEdit = can(tenant, "integrations.webhooks.edit");
  const navigate = useTenantNavigate();
  // Relative links resolve by ROUTE hierarchy, and this route nests under
  // `settings`, so `to=".."` lands on Settings → General, not the list.
  const nav = useNavLinks();

  const [w, setW] = useState<Webhook | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // A refused or failed fetch must land on an error, not leave the skeleton up
  // forever with an unhandled rejection behind it.
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setW(await getWebhook(id));
    } catch (e) {
      setLoadError(e instanceof IntegrationsApiError ? e.code : "load_failed");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <SkeletonList rows={4} columns={[2, 3, 1]} />;

  if (loadError || !w)
    return (
      <p className="text-[13px] text-danger">
        Could not load this webhook: {humanError(loadError ?? "not_found")}
      </p>
    );

  const inGrace = showKidBadge(w.secret_previous_expires_at);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link to={nav.integrationsWebhooks} className="text-[12px] text-ink-3 hover:text-ink">
          ← Webhooks
        </Link>
        {canEdit && (
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
      </div>

      {w.status === "disabled" && (
        <div className="rounded-sm border border-danger bg-danger-soft p-3 flex items-center justify-between">
          <div className="text-[13px]">
            Auto-disabled:{" "}
            <span className="text-ink-2">{w.disabled_reason ?? "consecutive failures"}</span>
          </div>
          {canEdit && (
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await reactivateWebhook(id);
                  await refresh();
                } catch (e) {
                  toastError(e, "load_failed");
                }
              }}
            >
              Reactivate
            </Button>
          )}
        </div>
      )}

      <Panel as="section" padding="sm" className="space-y-3">
        <h3 className="font-display text-[14px] font-semibold text-ink">Overview</h3>
        <Row label="URL">
          <code className="font-mono text-[12px]">{w.url}</code>
        </Row>
        <Row label="Events">
          <div className="flex flex-wrap gap-1">
            {w.events.map((e) => (
              <Badge key={e}>{e}</Badge>
            ))}
          </div>
        </Row>
        <Row label="Status">
          <div className="flex items-center gap-2">
            <Badge tone={w.status === "active" ? "ok" : w.status === "paused" ? "warn" : "danger"}>
              {w.status[0].toUpperCase() + w.status.slice(1)}
            </Badge>
            {canEdit && w.status === "active" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    await patchWebhook(id, { status: "paused" });
                    await refresh();
                  } catch (e) {
                    toastError(e, "load_failed");
                  }
                }}
              >
                Pause
              </Button>
            )}
            {w.status !== "active" && w.queued_count > 0 && (
              <span className="text-[12px] text-ink-3">
                {w.queued_count} {w.queued_count === 1 ? "delivery" : "deliveries"} queued — sent on
                resume
              </span>
            )}
            {canEdit && w.status === "paused" && (
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await patchWebhook(id, { status: "active" });
                    await refresh();
                  } catch (e) {
                    toastError(e, "load_failed");
                  }
                }}
              >
                Resume
              </Button>
            )}
          </div>
        </Row>
        {w.description && <Row label="Description">{w.description}</Row>}
        <Row label="Signing secret">
          <div className="flex items-center gap-3 text-[12px] font-mono flex-wrap">
            <span>{w.secret_prefix}••••</span>
            {inGrace && <Badge>current key</Badge>}
            {inGrace && w.secret_prefix_previous && (
              <>
                <span className="text-ink-3">{w.secret_prefix_previous}••••</span>
                <Badge>previous key</Badge>
                <span className="text-ink-3">
                  expires {new Date(w.secret_previous_expires_at!).toLocaleString()}
                </span>
              </>
            )}
            {canEdit && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    const r = await rotateSecret(id);
                    setSecret(r.value);
                    await refresh();
                  } catch (e) {
                    toastError(e, "load_failed");
                  }
                }}
              >
                Rotate
              </Button>
            )}
          </div>
        </Row>
        <p className="text-[12px] text-ink-3 pt-1">
          Verify deliveries with the{" "}
          <Link
            to={nav.integrationsWebhooks}
            className="text-accent underline-offset-2 hover:underline"
          >
            signing recipe
          </Link>{" "}
          on the Webhooks page.
        </p>
      </Panel>

      {canEdit && (
        <Panel as="section" padding="sm" className="space-y-2">
          <h3 className="font-display text-[14px] font-semibold text-ink">Send a test event</h3>
          <p className="text-[13px] text-ink-2">
            POSTs a synthetic <code>webhook.test</code> payload to the endpoint. Marked with a TEST
            badge in the delivery log; does not count toward auto-disable. Like every delivery, it
            waits in the queue while the webhook is paused.
          </p>
          <Button
            onClick={async () => {
              try {
                await sendTestEvent(id);
                await refresh();
              } catch (e) {
                toastError(e, "load_failed");
              }
            }}
          >
            Send test event
          </Button>
        </Panel>
      )}

      <DeliveryLog webhookId={id} />

      {secret && (
        <SecretRevealModal
          value={secret}
          onClose={() => setSecret(null)}
          title="New signing secret"
        />
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete webhook?"
        body={
          <p>
            Type the URL <code className="font-mono">{w.url}</code> to confirm deletion. This cannot
            be undone; the endpoint will stop receiving events immediately.
          </p>
        }
        confirmLabel="Delete"
        confirmPhrase={w.url}
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            await deleteWebhook(id);
            navigate("/settings/webhooks");
          } catch (e) {
            toastError(e, "load_failed");
            setConfirmDelete(false);
          }
        }}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 text-[13px]">
      <div className="text-ink-3">{label}</div>
      <div>{children}</div>
    </div>
  );
}
