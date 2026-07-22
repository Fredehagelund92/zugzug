import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTenant } from "./tenant-context";

/** Prefixed navigate: nav("/triage") → navigate("/app/:slug/triage"). */
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
      triage: `/app/${slug}/triage`,
      sources: `/app/${slug}/sources`,
      catalog: `/app/${slug}/catalog`,
      tables: `/app/${slug}/tables`,
      audit: `/app/${slug}/audit`,
      settings: `/app/${slug}/settings`,
      integrations: `/app/${slug}/settings/webhooks`,
      integrationsPullApi: `/app/${slug}/settings/pull-api`,
      integrationsWebhooks: `/app/${slug}/settings/webhooks`,
      integrationsServiceAccounts: `/app/${slug}/settings/service-accounts`,
      table: (dimId: string, mode?: "match" | "review") =>
        `/app/${slug}/tables?open=${dimId}&active=${dimId}${mode ? `&mode=${mode}` : ""}`,
      tablesFocus: (key: string) => `/app/${slug}/tables?focus=${encodeURIComponent(key)}`,
    }),
    [slug],
  );
}
