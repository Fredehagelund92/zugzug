import { useState } from "react";
import { Button } from "../../components/Button";
import { Checkbox } from "../../components/Checkbox";
import { FormField } from "../../components/FormField";
import {
  createWebhook,
  humanError,
  IntegrationsApiError,
  type WebhookEvent,
} from "../../lib/integrations-api";

interface Props {
  onClose: () => void;
  onCreated: (out: { id: string; value: string }) => void;
}

const EVENTS: { value: WebhookEvent; label: string; hint: string }[] = [
  {
    value: "table.published",
    label: "table.published",
    hint: "When records change.",
  },
  {
    value: "table.created",
    label: "table.created",
    hint: "When a new table is set up.",
  },
  {
    value: "record.deleted",
    label: "record.deleted",
    hint: "When a single record is removed.",
  },
  {
    value: "table.fields.updated",
    label: "table.fields.updated",
    hint: "When a table's fields change.",
  },
];

export function CreateWebhookModal({ onClose, onCreated }: Props) {
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["table.published"]);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const out = await createWebhook({ url, events, description: description || null });
      onCreated(out);
    } catch (e) {
      const code = e instanceof IntegrationsApiError ? e.code : "create_failed";
      setError(humanError(code));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[520px] max-w-full rounded-sm border border-line bg-surface p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="font-display text-[15px] font-semibold text-ink">New webhook</h2>

        <FormField label="Endpoint URL" hint="HTTPS required.">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.acme.com/zugzug"
            className="w-full rounded-sm border border-line bg-surface-2 px-2 py-1.5 text-[13px]"
          />
        </FormField>

        <fieldset>
          <legend className="text-[12px] text-ink-2 mb-1">Events to subscribe</legend>
          <div className="space-y-1">
            {EVENTS.map((e) => (
              <label key={e.value} className="flex items-center gap-2 text-[13px]">
                <Checkbox
                  state={events.includes(e.value) ? "on" : "off"}
                  onClick={() =>
                    setEvents((prev) =>
                      prev.includes(e.value)
                        ? prev.filter((x) => x !== e.value)
                        : [...prev, e.value],
                    )
                  }
                />
                <span className="font-mono">{e.label}</span>
                <span className="text-ink-3">{e.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <FormField label="Description (optional)">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Sync into Acme CRM"
            className="w-full rounded-sm border border-line bg-surface-2 px-2 py-1.5 text-[13px]"
          />
        </FormField>

        <p className="text-[12px] text-ink-3">
          Signing secret will be generated and shown once. Test events can be sent from the webhook
          detail page once the subscription exists.
        </p>

        {error && <p className="text-[12px] text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={submitting}
            disabled={!url || events.length === 0}
          >
            Create webhook
          </Button>
        </div>
      </div>
    </div>
  );
}
