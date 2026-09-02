import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTenant } from "../../lib/tenant-context";
import { Panel } from "../../components/Panel";
import { SkeletonList } from "../../components/Skeleton";
import {
  listRefTables,
  IntegrationsApiError,
  type RefTableSummary,
} from "../../lib/integrations-api";
import { DeveloperDetails } from "../../components/integrations/DeveloperDetails";
import { CopyButton } from "../../components/CopyButton";

const BASE_URL_PLACEHOLDER = "https://<host>";

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
      className="px-1.5 py-0.5 rounded-sm text-[11px] text-ink-2 hover:bg-hover hover:text-ink transition-colors"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function PullApi() {
  const tenant = useTenant();
  const [refTables, setDims] = useState<RefTableSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listRefTables();
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
  const firstSlug = refTables[0]?.slug ?? "country";

  return (
    <div className="space-y-6">
      <Panel as="section" padding="sm" className="space-y-2">
        <h2 className="font-display text-[15px] font-semibold text-ink">
          Your records, available as a JSON API
        </h2>
        <p className="text-[13px] text-ink-2">
          Use this to load records into dbt, Fivetran, or any ETL pipeline. Authenticate with a
          service account from this workspace.
        </p>
        <div className="flex items-center gap-2 mt-2">
          <code className="flex-1 px-2 py-1.5 rounded-sm bg-surface-2 text-[12px] font-mono">
            {baseUrl}
          </code>
          <CopyButton text={baseUrl} />
        </div>
        <DeveloperDetails id="pull-api-banner" summary="Developer details">
          <div>
            Event store: <code>outbound_event</code> table.
          </div>
        </DeveloperDetails>
      </Panel>

      <Panel as="section" padding="sm" className="space-y-2">
        <h3 className="font-display text-[14px] font-semibold text-ink">Authentication</h3>
        <p className="text-[13px] text-ink-2">
          Every request needs a bearer token from the{" "}
          <Link to="../service-accounts" className="text-accent underline-offset-2 hover:underline">
            Service accounts
          </Link>{" "}
          page.
        </p>
        <pre className="px-3 py-2 rounded-sm bg-surface-2 text-[12px] font-mono overflow-x-auto">
          {`curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" \\
     ${baseUrl}/tables`}
        </pre>
      </Panel>

      <EndpointCards baseUrl={baseUrl} firstSlug={firstSlug} />

      <Panel as="section" padding="sm">
        <h3 className="font-display text-[14px] font-semibold text-ink mb-3">
          Tables in this workspace
        </h3>
        {loading ? (
          <SkeletonList rows={3} columns={[120, 1, 70, 90, 180]} />
        ) : error ? (
          <p className="text-[13px] text-danger">Could not load tables: {error}</p>
        ) : refTables.length === 0 ? (
          <p className="text-[13px] text-ink-2">
            No tables yet. Create one in{" "}
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
              {refTables.map((d) => {
                const curlFor = (path: string) =>
                  `curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" ${baseUrl}/tables/${d.slug}/${path}`;
                return (
                  <tr
                    key={d.slug}
                    className="border-t border-line hover:bg-hover transition-colors"
                  >
                    <td className="py-2 font-mono">{d.slug}</td>
                    <td>{d.label}</td>
                    <td className="text-right pr-4 tabular-nums">
                      {d.record_count.toLocaleString()}
                    </td>
                    <td
                      className={d.last_published_at ? "text-ink" : "text-ink-3"}
                      title={d.last_published_at ?? undefined}
                    >
                      {relativeDay(d.last_published_at)}
                    </td>
                    <td className="text-right">
                      <div className="inline-flex items-center gap-1">
                        <MiniCopy text={curlFor("records")} label="records" />
                        <MiniCopy text={curlFor("fields")} label="fields" />
                        <MiniCopy text={curlFor("removed")} label="removed" />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel as="section" padding="sm" className="space-y-2">
        <h3 className="font-display text-[14px] font-semibold text-ink">
          Pagination + incremental reads
        </h3>
        <p className="text-[13px] text-ink-2">
          All paginated endpoints accept <code>?since=&lt;ISO&gt;</code> (inclusive lower bound) and
          return a HMAC-signed cursor in <code>cursor.next</code>. Resume by passing{" "}
          <code>?cursor=&lt;value&gt;</code>. Cursors invalidated by server-key rotation return{" "}
          <code>400 cursor_invalid</code>; consumers should start again from <code>?since=</code>.
        </p>
      </Panel>

      <Panel as="section" padding="sm" className="space-y-2">
        <h3 className="font-display text-[14px] font-semibold text-ink">Rate limits</h3>
        <p className="text-[13px] text-ink-2">
          600 req/min per credential by default (configurable via <code>ZUGZUG_PULL_API_RPM</code>).
          Exceeding returns <code>429</code> with <code>Retry-After</code> seconds.
        </p>
      </Panel>
    </div>
  );
}

/** baseUrl already ends in `/v1` and every signature starts with `GET /v1/`,
 *  so the version segment has to come off one of them or the curl 404s on
 *  `/v1/v1/...`. */
export function curlForEndpoint(baseUrl: string, sig: string): string {
  const path = sig.replace(/^GET\s+/, "").replace(/^\/v1/, "");
  return `curl -H "Authorization: Bearer zzsa_YOUR_TOKEN" ${baseUrl}${path}`;
}

function EndpointCards({ baseUrl, firstSlug }: { baseUrl: string; firstSlug: string }) {
  const ENDPOINTS: { sig: string; desc: string }[] = [
    { sig: `GET /v1/tables`, desc: "List this workspace's tables." },
    { sig: `GET /v1/tables/${firstSlug}/fields`, desc: "Get a table's fields." },
    {
      sig: `GET /v1/tables/${firstSlug}/records`,
      desc: "Paginated records. Supports ?since= and ?cursor=.",
    },
    {
      sig: `GET /v1/tables/${firstSlug}/removed`,
      desc: "Paginated removed records. Used when a webhook reports changes_truncated.",
    },
  ];
  return (
    <section className="space-y-3">
      <h3 className="font-display text-[14px] font-semibold text-ink">Endpoints</h3>
      {ENDPOINTS.map((e) => (
        <Panel key={e.sig} padding="sm">
          <code className="text-[12px] font-mono">{e.sig}</code>
          <p className="mt-1 text-[12.5px] text-ink-2">{e.desc}</p>
          <details className="mt-2">
            <summary className="text-[12px] text-ink-3 cursor-pointer">Try it with curl</summary>
            <pre className="mt-2 p-2 rounded-sm bg-surface-2 text-[11.5px] font-mono overflow-x-auto">
              {curlForEndpoint(baseUrl, e.sig)}
            </pre>
          </details>
        </Panel>
      ))}
    </section>
  );
}
