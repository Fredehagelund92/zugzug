import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { Button } from "../../components/Button";
import { SkeletonList } from "../../components/Skeleton";
import {
  listDimensions,
  IntegrationsApiError,
  type DimensionSummary,
} from "../../lib/integrations-api";
import { DeveloperDetails } from "../../components/integrations/DeveloperDetails";

const BASE_URL_PLACEHOLDER = "https://<host>";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

function relativeDay(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso.slice(0, 10);
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function MiniCopy({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="px-1.5 py-0.5 rounded-sm text-[11px] text-ink-2 hover:bg-surface hover:text-ink transition-colors"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function PullApi() {
  const tenant = useTenant();
  const [dims, setDims] = useState<DimensionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listDimensions();
        if (!cancelled) setDims(list);
      } catch (e) {
        if (!cancelled) setError(e instanceof IntegrationsApiError ? e.code : "load_failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const baseUrl = `${typeof window === "undefined" ? BASE_URL_PLACEHOLDER : window.location.origin}/api/t/${tenant.slug}/v1`;
  const firstSlug = dims[0]?.slug ?? "country";

  return (
    <div className="space-y-6">
      <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-2">
        <h2 className="font-display text-[15px] font-semibold text-ink">
          Your records, available as a JSON API
        </h2>
        <p className="text-[13px] text-ink-2">
          Use this to sync into dbt, Fivetran, or any ETL pipeline. Authenticate with a service
          account from this workspace.
        </p>
        <div className="flex items-center gap-2 mt-2">
          <code className="flex-1 px-2 py-1.5 rounded-sm bg-surface text-[12px] font-mono">
            {baseUrl}
          </code>
          <CopyButton text={baseUrl} />
        </div>
        <DeveloperDetails id="pull-api-banner" summary="Developer details">
          <div>
            Event store: <code>outbound_event</code> table.
          </div>
        </DeveloperDetails>
      </section>

      <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-2">
        <h3 className="font-display text-[14px] font-semibold text-ink">Authentication</h3>
        <p className="text-[13px] text-ink-2">
          Every request needs a bearer token from the{" "}
          <Link to="../service-accounts" className="text-accent underline-offset-2 hover:underline">
            Service accounts
          </Link>{" "}
          page.
        </p>
        <pre className="px-3 py-2 rounded-sm bg-surface text-[12px] font-mono overflow-x-auto">
          {`curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" \\
     ${baseUrl}/dimensions`}
        </pre>
      </section>

      <EndpointCards baseUrl={baseUrl} firstSlug={firstSlug} />

      <section className="rounded-sm border border-line bg-surface-2 p-4">
        <h3 className="font-display text-[14px] font-semibold text-ink mb-3">
          Dimensions in this workspace
        </h3>
        {loading ? (
          <SkeletonList rows={3} columns={[120, 1, 70, 90, 180]} />
        ) : error ? (
          <p className="text-[13px] text-danger">Could not load dimensions: {error}</p>
        ) : dims.length === 0 ? (
          <p className="text-[13px] text-ink-2">
            No dimensions yet. Create one in{" "}
            <Link to="../../tables" className="text-accent underline-offset-2 hover:underline">
              Tables
            </Link>{" "}
            and they’ll appear here.
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="text-ink-2 text-left">
              <tr className="text-[11px] uppercase tracking-wider">
                <th className="py-1.5 font-medium">Slug</th>
                <th className="font-medium">Label</th>
                <th className="font-medium text-right pr-4">Records</th>
                <th className="font-medium">Last publish</th>
                <th className="font-medium text-right">Copy curl</th>
              </tr>
            </thead>
            <tbody>
              {dims.map((d) => {
                const curlFor = (path: string) =>
                  `curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" ${baseUrl}/dimensions/${d.slug}/${path}`;
                return (
                  <tr
                    key={d.slug}
                    className="border-t border-line hover:bg-surface/60 transition-colors"
                  >
                    <td className="py-2 font-mono">{d.slug}</td>
                    <td>{d.label}</td>
                    <td className="text-right pr-4 tabular-nums">
                      {d.canonical_count.toLocaleString()}
                    </td>
                    <td
                      className={d.last_committed_at ? "text-ink" : "text-ink-3"}
                      title={d.last_committed_at ?? undefined}
                    >
                      {relativeDay(d.last_committed_at)}
                    </td>
                    <td className="text-right">
                      <div className="inline-flex items-center gap-1">
                        <MiniCopy text={curlFor("canonical")} label="canonical" />
                        <MiniCopy text={curlFor("schema")} label="schema" />
                        <MiniCopy text={curlFor("tombstones")} label="tombstones" />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-2">
        <h3 className="font-display text-[14px] font-semibold text-ink">
          Pagination + incremental sync
        </h3>
        <p className="text-[13px] text-ink-2">
          All paginated endpoints accept <code>?since=&lt;ISO&gt;</code> (inclusive lower bound) and
          return a HMAC-signed cursor in <code>cursor.next</code>. Resume by passing{" "}
          <code>?cursor=&lt;value&gt;</code>. Cursors invalidated by server-key rotation return{" "}
          <code>400 cursor_invalid</code>; consumers should resync from <code>?since=</code>.
        </p>
      </section>

      <section className="rounded-sm border border-line bg-surface-2 p-4 space-y-2">
        <h3 className="font-display text-[14px] font-semibold text-ink">Rate limits</h3>
        <p className="text-[13px] text-ink-2">
          600 req/min per credential by default (configurable via <code>ZUGZUG_PULL_API_RPM</code>).
          Exceeding returns <code>429</code> with <code>Retry-After</code> seconds.
        </p>
      </section>
    </div>
  );
}

function EndpointCards({ baseUrl, firstSlug }: { baseUrl: string; firstSlug: string }) {
  const ENDPOINTS: { sig: string; desc: string }[] = [
    { sig: `GET /v1/dimensions`, desc: "List this workspace's dimensions." },
    { sig: `GET /v1/dimensions/${firstSlug}/schema`, desc: "Get a dimension's field schema." },
    {
      sig: `GET /v1/dimensions/${firstSlug}/canonical`,
      desc: "Paginated records. Supports ?since= and ?cursor=.",
    },
    {
      sig: `GET /v1/dimensions/${firstSlug}/tombstones`,
      desc: "Paginated retired/merged keys. Used when a webhook reports changes_truncated.",
    },
  ];
  return (
    <section className="space-y-3">
      <h3 className="font-display text-[14px] font-semibold text-ink">Endpoints</h3>
      {ENDPOINTS.map((e) => (
        <div key={e.sig} className="rounded-sm border border-line bg-surface-2 p-4">
          <code className="text-[12px] font-mono">{e.sig}</code>
          <p className="mt-1 text-[12.5px] text-ink-2">{e.desc}</p>
          <details className="mt-2">
            <summary className="text-[12px] text-ink-3 cursor-pointer">Sample response</summary>
            <pre className="mt-2 p-2 rounded-sm bg-surface text-[11.5px] font-mono overflow-x-auto">
              {`curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" ${baseUrl}${e.sig.replace("GET ", "")}`}
            </pre>
          </details>
        </div>
      ))}
    </section>
  );
}
