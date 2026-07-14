import { Fragment, useCallback, useEffect, useState } from "react";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";
import { Button } from "../../components/Button";
import { Panel } from "../../components/Panel";
import { Badge } from "../../components/Badge";
import { SkeletonList } from "../../components/Skeleton";
import { toast } from "../../components/Toast";
import {
  listDeliveries,
  replayDelivery,
  humanError,
  IntegrationsApiError,
  type WebhookDelivery,
} from "../../lib/integrations-api";
import { DeveloperDetails } from "../../components/integrations/DeveloperDetails";

/** Map delivery status → Badge tone. Tones are constrained to those actually
 *  defined in Badge.tsx (`ok` | `warn` | `danger`); transient states fall
 *  back to the neutral default. */
const STATUS_TONE: Record<WebhookDelivery["status"], "ok" | "danger" | undefined> = {
  success: "ok",
  dlq: "danger",
  retry: undefined,
  pending: undefined,
  in_flight: undefined,
};

export function DeliveryLog({ webhookId }: { webhookId: string }) {
  const tenant = useTenant();
  const canSeePayload = can(tenant, "integrations.webhooks.delivery_payload_view");
  const canReplay = can(tenant, "integrations.webhooks.edit");
  const [rows, setRows] = useState<WebhookDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listDeliveries(webhookId, { limit: 50 }));
    } catch (e) {
      toast(humanError(e instanceof IntegrationsApiError ? e.code : "load_failed"), "error");
    } finally {
      setLoading(false);
    }
  }, [webhookId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) return <SkeletonList rows={3} columns={[1, 2, 1, 1, 2]} />;

  const colCount = canSeePayload ? 7 : 6;

  return (
    <Panel as="section" padding="sm" className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-[14px] font-semibold text-ink">Delivery log</h3>
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      <table className="w-full text-[13px]">
        <thead className="text-ink-3 text-left">
          <tr>
            <th className="py-2"></th>
            <th>Status</th>
            <th>Event</th>
            <th>Attempts</th>
            <th>Code</th>
            <th>Created</th>
            {canSeePayload && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const open = expanded === r.id;
            return (
              <Fragment key={r.id}>
                <tr className="border-t border-line">
                  <td className="py-2">
                    {canSeePayload ? (
                      <button
                        className="text-ink-3 hover:text-ink"
                        onClick={() => setExpanded(open ? null : r.id)}
                        aria-label={open ? "Collapse" : "Expand"}
                      >
                        {open ? "▾" : "▸"}
                      </button>
                    ) : (
                      <span
                        title="Editor or higher required to view payload"
                        className="text-ink-3 opacity-50 cursor-not-allowed"
                        aria-label="Editor or higher required to view payload"
                      >
                        ▸
                      </span>
                    )}
                  </td>
                  <td>
                    <div className="flex items-center gap-1.5">
                      <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                      {r.is_test && <Badge>TEST</Badge>}
                    </div>
                  </td>
                  <td className="font-mono text-[12px]">{r.event_type}</td>
                  <td>
                    {r.attempts}/{r.max_attempts}
                  </td>
                  <td>{r.last_response_code ?? "—"}</td>
                  <td className="text-ink-2">{r.created_at.slice(0, 19).replace("T", " ")}</td>
                  {canSeePayload && (
                    <td className="text-right">
                      {canReplay && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            try {
                              await replayDelivery(r.id);
                              await refresh();
                            } catch (e) {
                              toast(
                                humanError(
                                  e instanceof IntegrationsApiError ? e.code : "load_failed",
                                ),
                                "error",
                              );
                            }
                          }}
                          title={
                            r.signing_kid === "previous"
                              ? "Original signing key expired — replay will re-sign with current secret"
                              : undefined
                          }
                        >
                          Replay
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
                {open && canSeePayload && (
                  <tr className="bg-surface-2/40">
                    <td colSpan={colCount} className="p-3">
                      <div className="space-y-2 text-[12px] font-mono">
                        <DetailField label="Signature" value={r.signature ?? "—"} />
                        <DetailField
                          label="Payload"
                          value={r.payload ? JSON.stringify(r.payload, null, 2) : "—"}
                        />
                        <DetailField
                          label="Response body"
                          value={r.last_response_body ?? r.last_error ?? "—"}
                        />
                        <DeveloperDetails id={`delivery-${r.id}`} summary="Developer details">
                          <div>id: {r.id}</div>
                          <div>signing_kid: {r.signing_kid}</div>
                          <div>next_attempt_at: {r.next_attempt_at ?? "—"}</div>
                        </DeveloperDetails>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <p className="text-[12px] text-ink-3">No deliveries yet.</p>}
    </Panel>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <details open className="rounded-sm bg-surface-2 p-2">
      <summary className="cursor-pointer text-ink-2">{label}</summary>
      <pre className="mt-1 whitespace-pre-wrap break-all text-[11.5px]">{value}</pre>
    </details>
  );
}
