import { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { can } from "../../lib/permissions";
import { Button } from "../../components/Button";
import { Badge } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { SkeletonList } from "../../components/Skeleton";
import { listWebhooks, type Webhook, type WebhookStatus } from "../../lib/integrations-api";
import { CreateWebhookModal } from "./CreateWebhookModal";
import { SecretRevealModal } from "./SecretRevealModal";

export function computeDuplicateUrlSet(rows: Array<{ id: string; url: string }>): Set<string> {
  const counts = new Map<string, string[]>();
  for (const r of rows) {
    const norm = normaliseUrl(r.url);
    const bucket = counts.get(norm) ?? [];
    bucket.push(r.id);
    counts.set(norm, bucket);
  }
  const dup = new Set<string>();
  for (const ids of counts.values()) if (ids.length > 1) for (const id of ids) dup.add(id);
  return dup;
}

function normaliseUrl(input: string): string {
  try {
    const u = new URL(input);
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return input;
  }
}

function StatusBadge({ status }: { status: WebhookStatus }) {
  if (status === "active") return <Badge tone="ok">Active</Badge>;
  if (status === "paused") return <Badge>Paused</Badge>;
  return <Badge tone="danger">Disabled</Badge>;
}

export function Webhooks() {
  const tenant = useTenant();
  const canEdit = can(tenant, "integrations.webhooks.edit");
  const [items, setItems] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [secret, setSecret] = useState<{ value: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setItems(await listWebhooks());
    setLoading(false);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const dupSet = useMemo(() => computeDuplicateUrlSet(items), [items]);

  if (loading) return <SkeletonList rows={3} columns={[1, 1, 100, 140, 80]} />;

  if (items.length === 0) {
    return (
      <>
        <EmptyState
          title="No webhooks yet"
          body="Subscribe an endpoint to receive a signed POST when canonical records change."
          action={
            canEdit ? (
              <Button onClick={() => setShowCreate(true)}>Create your first webhook</Button>
            ) : undefined
          }
        />
        {showCreate && (
          <CreateWebhookModal
            onClose={() => setShowCreate(false)}
            onCreated={(out) => {
              setShowCreate(false);
              setSecret({ value: out.value });
              void refresh();
            }}
          />
        )}
        {secret && <SecretRevealModal value={secret.value} onClose={() => setSecret(null)} />}
      </>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[15px] font-semibold text-ink">Webhooks</h2>
        {canEdit && <Button onClick={() => setShowCreate(true)}>+ New webhook</Button>}
      </div>

      <table className="w-full text-[13px]">
        <thead className="text-ink-3 text-left">
          <tr>
            <th className="py-2">URL</th>
            <th>Events</th>
            <th>Status</th>
            <th>Last delivery</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((w) => {
            const dup = dupSet.has(w.id);
            const eventChips =
              w.events.length === 1 ? w.events[0] : `${w.events[0]} (+${w.events.length - 1})`;
            return (
              <tr key={w.id} className="border-t border-line">
                <td className="py-2 font-mono text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="truncate max-w-[28ch]">{w.url}</span>
                    {dup && (
                      <span title="Also subscribed by another webhook">
                        <Badge tone="warn">⚠ duplicate URL</Badge>
                      </span>
                    )}
                  </div>
                </td>
                <td>{eventChips}</td>
                <td>
                  <StatusBadge status={w.status} />
                </td>
                <td>
                  {w.last_delivery_at
                    ? `${w.last_delivery_at.slice(0, 16)} · ${w.last_delivery_status ?? "—"}`
                    : "never"}
                </td>
                <td className="text-right">
                  <Link to={w.id} className="text-accent hover:underline">
                    View →
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {dupSet.size > 0 && <p className="text-[12px] text-ink-3">{dupSet.size} duplicate URLs</p>}

      {showCreate && (
        <CreateWebhookModal
          onClose={() => setShowCreate(false)}
          onCreated={(out) => {
            setShowCreate(false);
            setSecret({ value: out.value });
            void refresh();
          }}
        />
      )}
      {secret && <SecretRevealModal value={secret.value} onClose={() => setSecret(null)} />}
    </div>
  );
}
