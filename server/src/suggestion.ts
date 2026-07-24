// server/src/suggestion.ts
//
// Core suggestion generation: cache lookup → AI provider call → cache write.
// Cache lives in `zugzug_app.ai_hint_cache` (see drizzle/schema.ts). AI config
// (enabled flag, provider, API key) lives in `zugzug_app.preferences`, scoped
// per tenant.

import { pgGet, pgRun } from "./pg.ts";
import { pg as pgTable } from "./env.ts";
import { getAIProvider, InvalidAPIKeyError, type AIProviderType } from "./ai-providers/index.ts";

export interface SuggestionContext {
  refTableId: string;
  refTableName: string;
  rawValue: string;
  existingRecordValues: string[];
}

export interface Suggestion {
  record: string;
  confidence: "high" | "medium" | "low";
  reasoning?: string;
  cached: boolean;
}

interface TenantAIConfig {
  ai_enabled: boolean;
  ai_provider: AIProviderType;
  ai_api_key?: string;
}

/**
 * Generate an AI suggestion mapping a raw value to a record value.
 *
 * 1. Check cache; return on hit (unless `forceRefresh` is true).
 * 2. Fetch tenant AI config from `preferences`.
 * 3. Call AI provider.
 * 4. Persist into `ai_hint_cache`.
 * 5. Return suggestion.
 */
export async function generateSuggestion(
  tenantId: string,
  context: SuggestionContext,
  options?: { forceRefresh?: boolean },
): Promise<Suggestion> {
  const { refTableId, rawValue } = context;

  if (!options?.forceRefresh) {
    const cached = await getCachedSuggestion(tenantId, refTableId, rawValue);
    if (cached) return cached;
  }

  const config = await getTenantAIConfig(tenantId);

  if (!config.ai_enabled) {
    throw new AINotEnabledError("AI is not enabled for this workspace");
  }
  if (!config.ai_api_key) {
    throw new InvalidAPIKeyError("AI API key is not configured for this workspace");
  }

  const provider = getAIProvider(config.ai_provider, config.ai_api_key);
  const aiResponse = await provider.suggestMapping({
    refTableName: context.refTableName,
    rawValue: context.rawValue,
    existingRecordValues: context.existingRecordValues,
  });

  const confidenceScore = confidenceToScore(aiResponse.confidence);
  const model = modelForProvider(config.ai_provider);

  await cacheSuggestion(tenantId, refTableId, rawValue, {
    suggestion: aiResponse.record,
    confidence: confidenceScore,
    reasoning: aiResponse.reasoning ?? "",
    model,
  });

  return {
    record: aiResponse.record,
    confidence: aiResponse.confidence,
    reasoning: aiResponse.reasoning,
    cached: false,
  };
}

interface CacheRow {
  suggestion: string;
  confidence: number;
  reasoning: string;
}

async function getCachedSuggestion(
  tenantId: string,
  refTableId: string,
  rawValue: string,
): Promise<Suggestion | null> {
  const row = await pgGet<CacheRow>(
    `SELECT suggestion, confidence, reasoning
       FROM ${pgTable("ai_hint_cache")}
      WHERE tenant_id = $1 AND reference_table_id = $2 AND raw = $3
      LIMIT 1`,
    [tenantId, refTableId, rawValue],
  );
  if (!row || row.suggestion === null) return null;

  // Bump hit counter (fire and forget — caching is best-effort).
  void pgRun(
    `UPDATE ${pgTable("ai_hint_cache")} SET hits = hits + 1
      WHERE tenant_id = $1 AND reference_table_id = $2 AND raw = $3`,
    [tenantId, refTableId, rawValue],
  );

  return {
    record: row.suggestion,
    confidence: scoreToConfidence(row.confidence),
    reasoning: row.reasoning,
    cached: true,
  };
}

async function cacheSuggestion(
  tenantId: string,
  refTableId: string,
  rawValue: string,
  suggestion: {
    suggestion: string;
    confidence: number;
    reasoning: string;
    model: string;
  },
): Promise<void> {
  await pgRun(
    `INSERT INTO ${pgTable("ai_hint_cache")}
       (tenant_id, reference_table_id, raw, suggestion, confidence, reasoning, model, created_at, hits)
     VALUES ($1, $2, $3, $4, $5, $6, $7, current_timestamp, 0)
     ON CONFLICT (tenant_id, reference_table_id, raw) DO UPDATE SET
       suggestion = EXCLUDED.suggestion,
       confidence = EXCLUDED.confidence,
       reasoning  = EXCLUDED.reasoning,
       model      = EXCLUDED.model,
       created_at = EXCLUDED.created_at`,
    [
      tenantId,
      refTableId,
      rawValue,
      suggestion.suggestion,
      suggestion.confidence,
      suggestion.reasoning,
      suggestion.model,
    ],
  );
}

async function getTenantAIConfig(tenantId: string): Promise<TenantAIConfig> {
  const row = await pgGet<{
    ai_enabled: boolean;
    ai_provider: string;
    ai_api_key: string | null;
  }>(
    `SELECT ai_enabled, ai_provider, ai_api_key
       FROM ${pgTable("preferences")}
      WHERE tenant_id = $1
      LIMIT 1`,
    [tenantId],
  );

  if (!row) {
    return { ai_enabled: false, ai_provider: "openai" };
  }

  const provider: AIProviderType = row.ai_provider === "anthropic" ? "anthropic" : "openai";

  return {
    ai_enabled: row.ai_enabled,
    ai_provider: provider,
    ai_api_key: row.ai_api_key ?? undefined,
  };
}

/** Map confidence band → numeric score persisted in cache (0–100). */
function confidenceToScore(confidence: "high" | "medium" | "low"): number {
  switch (confidence) {
    case "high":
      return 90;
    case "medium":
      return 60;
    case "low":
      return 30;
  }
}

/** Inverse of `confidenceToScore` for cache reads. */
function scoreToConfidence(score: number): "high" | "medium" | "low" {
  if (score >= 75) return "high";
  if (score >= 45) return "medium";
  return "low";
}

function modelForProvider(provider: AIProviderType): string {
  switch (provider) {
    case "openai":
      return "gpt-4o-mini";
    case "anthropic":
      return "claude-haiku-4-5-20251001";
  }
}

/** Raised when a tenant attempts AI suggestion without `ai_enabled=true`. */
export class AINotEnabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AINotEnabledError";
  }
}
