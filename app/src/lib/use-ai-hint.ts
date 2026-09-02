import { useEffect, useState } from "react";
import { apiFetch } from "../api";

/** One on-demand mapping hint from GET /api/triage/ai-hint. */
export interface AiHint {
  suggestion: string | null;
  confidence: number;
  reasoning: string;
  cached?: boolean;
}

// Asked once per session — whether AI is set up doesn't change under the user,
// and every Review row would otherwise ask again.
let configuredCache: boolean | null = null;
let configuredPromise: Promise<boolean> | null = null;

/** Whether this deployment has an AI provider set up. Null while unknown.
 *  Review hides "Suggest with AI" when this is false: without a provider the
 *  request can only ever fail, and the old error state offered "Try AI again"
 *  forever. */
export function useAiConfigured(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(configuredCache);
  useEffect(() => {
    if (configuredCache !== null) return;
    configuredPromise ??= apiFetch("/ai/status")
      .then(async (r) => (r.ok ? (((await r.json()) as { configured?: boolean }).configured ?? false) : false))
      .catch(() => false)
      .then((v) => (configuredCache = v));
    let live = true;
    void configuredPromise.then((v) => live && setConfigured(v));
    return () => {
      live = false;
    };
  }, []);
  return configured;
}
