/* repo-ai-hint.ts — the Review page's on-demand mapping hint.
 *
 * A thin read over suggestion.ts: that module owns the cache, the AI config
 * resolution and the provider call for the whole server. All this adds is the
 * Review contract — a suggestion is only offered when it names a record that
 * actually exists in the table, because an offer the user cannot accept is
 * worse than no offer at all. */

import { AINotEnabledError, confidenceToScore, generateSuggestion } from "./suggestion.ts";

export interface AiHint {
  suggestion: string | null;
  confidence: number;
  reasoning: string;
}

export interface AiHintResult extends AiHint {
  cached: boolean;
}

interface RefTableContext {
  label: string;
}

const NOTHING: AiHintResult = { suggestion: null, confidence: 0, reasoning: "", cached: false };

export async function getAiHint(
  refTableId: string,
  raw: string,
  recordLabels: string[],
  refTable: RefTableContext,
  tenantId: string,
): Promise<AiHintResult> {
  if (recordLabels.length === 0) {
    return { ...NOTHING, reasoning: "No records exist in this table yet." };
  }

  let suggestion;
  try {
    suggestion = await generateSuggestion(tenantId, {
      refTableId,
      refTableName: refTable.label,
      rawValue: raw,
      existingRecordValues: recordLabels,
    });
  } catch (e) {
    // No AI set up for this workspace — degrade to "no hint", never an error.
    if (e instanceof AINotEnabledError) return NOTHING;
    throw e;
  }

  if (!recordLabels.includes(suggestion.record)) {
    return { ...NOTHING, reasoning: "No match in this table.", cached: suggestion.cached };
  }
  return {
    suggestion: suggestion.record,
    confidence: confidenceToScore(suggestion.confidence),
    reasoning: suggestion.reasoning || "Matches an existing record.",
    cached: suggestion.cached,
  };
}
