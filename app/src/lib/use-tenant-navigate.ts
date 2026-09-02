import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTenant } from "./tenant-context";

/** Prefixed navigate: nav("/review") → navigate("/app/:slug/review"). */
export function useTenantNavigate(): (to: string, opts?: { replace?: boolean }) => void {
  const { slug } = useTenant();
  const navigate = useNavigate();
  return useCallback(
    (to, opts) => {
      const target = to.startsWith("/") ? `/app/${slug}${to}` : to;
      navigate(target, opts);
    },
    [slug, navigate],
  );
}

/** Tenant-prefixed nav hrefs for top-level pages. */
export function useNavLinks() {
  const { slug } = useTenant();
  return useMemo(
    () => ({
      base: `/app/${slug}`,
      dashboard: `/app/${slug}`,
      review: `/app/${slug}/review`,
      sources: `/app/${slug}/sources`,
      tables: `/app/${slug}/tables`,
      audit: `/app/${slug}/audit`,
      settings: `/app/${slug}/settings`,
      integrations: `/app/${slug}/settings/webhooks`,
      integrationsPullApi: `/app/${slug}/settings/pull-api`,
      integrationsWebhooks: `/app/${slug}/settings/webhooks`,
      integrationsServiceAccounts: `/app/${slug}/settings/service-accounts`,
      table: (refTableId: string, mode?: "match" | "review") =>
        `/app/${slug}/tables?open=${refTableId}&active=${refTableId}${mode ? `&mode=${mode}` : ""}`,
      tablesFocus: (key: string) => `/app/${slug}/tables?focus=${encodeURIComponent(key)}`,
    }),
    [slug],
  );
}
