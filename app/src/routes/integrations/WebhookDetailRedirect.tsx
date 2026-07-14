import { Navigate, useParams } from "react-router-dom";

/** integrations/webhooks/:id → settings/webhooks/:id — <Navigate> alone
 *  cannot carry a path param, so this tiny component reads it. */
export function WebhookDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`../../settings/webhooks/${id}`} replace />;
}
