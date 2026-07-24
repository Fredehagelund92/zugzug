import { env, pg } from "./env.ts";
import { pgGet, pgRun } from "./repo-shared.ts";

export interface AiHint {
  suggestion: string | null;
  confidence: number;
  reasoning: string;
}

export interface AiHintResult extends AiHint {
  cached: boolean;
}

interface DimContext {
  label: string;
}

// ── validation ────────────────────────────────────────────────────────────────

export function validateClaudeResponse(raw: unknown, recordLabels: string[]): AiHint {
  if (typeof raw !== "object" || raw === null) {
    return { suggestion: null, confidence: 0, reasoning: "Invalid response from AI." };
  }
  const r = raw as Record<string, unknown>;

  const suggestion =
    typeof r.suggestion === "string" && recordLabels.includes(r.suggestion) ? r.suggestion : null;

  const confidence =
    suggestion !== null && typeof r.confidence === "number"
      ? Math.max(0, Math.min(95, Math.round(r.confidence)))
      : 0;

  const reasoning =
    suggestion === null
      ? "No match in record set."
      : typeof r.reasoning === "string" && r.reasoning.length > 0
        ? r.reasoning.slice(0, 300)
        : "Matched to record record.";

  return { suggestion, confidence, reasoning };
}

// ── Claude API call ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a data mapping assistant for a Master Data Management tool. Match a raw source value to the best record record in a controlled vocabulary.

Respond ONLY with a JSON object:
{"suggestion": string | null, "confidence": number, "reasoning": string}

Rules:
- suggestion: exact string from the record list or null if no match
- confidence: 0-100. >90 = unambiguous (abbreviation, translation, alternate spelling). 60-89 = plausible. <60 = guessing. 0 only when suggestion is null.
- reasoning: 1-2 sentences, terse and concrete, max 200 chars. Show pattern evidence (e.g. "ISO 3166-1 alpha-2 code. DE→Germany, FR→France.")
- Never invent a suggestion not in the record list
- Never set confidence above 95`;

export async function callClaude(
  raw: string,
  recordLabels: string[],
  dim: DimContext,
): Promise<AiHint> {
  if (!env.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const recordBlock =
    recordLabels.length > 0
      ? recordLabels.map((l, i) => `${i + 1}. ${l}`).join("\n")
      : "(empty — no record records exist yet)";

  const userMessage = `Dimension: ${dim.label}

Record options:
${recordBlock}

Raw source value to match: "${raw}"`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(8000),
    headers: {
      "content-type": "application/json",
      "x-api-key": env.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Claude API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content.find((b) => b.type === "text")?.text ?? "";
  const jsonText = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`Claude returned non-JSON: ${text.slice(0, 100)}`);
  }

  return validateClaudeResponse(parsed, recordLabels);
}

// ── cache + orchestration ─────────────────────────────────────────────────────

interface CacheRow {
  suggestion: string | null;
  confidence: number;
  reasoning: string;
}

export async function getAiHint(
  dimId: string,
  raw: string,
  recordLabels: string[],
  dim: DimContext,
  tenantId: string,
): Promise<AiHintResult> {
  // 1. Postgres cache hit
  const cached = await pgGet<CacheRow>(
    `SELECT suggestion, confidence, reasoning
     FROM ${pg("ai_hint_cache")}
     WHERE dim_id = $1 AND raw = $2 AND tenant_id = $3`,
    [dimId, raw, tenantId],
  );
  if (cached) {
    void pgRun(
      `UPDATE ${pg("ai_hint_cache")} SET hits = hits + 1
       WHERE dim_id = $1 AND raw = $2 AND tenant_id = $3`,
      [dimId, raw, tenantId],
    );
    return { ...cached, cached: true };
  }

  // 2. Empty record set — skip Claude
  if (recordLabels.length === 0) {
    return {
      suggestion: null,
      confidence: 0,
      reasoning: "No record records exist yet.",
      cached: false,
    };
  }

  // 3. No API key — graceful degradation
  if (!env.anthropicApiKey) {
    return { suggestion: null, confidence: 0, reasoning: "", cached: false };
  }

  // 4. Claude call
  const result = await callClaude(raw, recordLabels, dim);

  // 5. Store in cache
  await pgRun(
    `INSERT INTO ${pg("ai_hint_cache")}
       (dim_id, raw, suggestion, confidence, reasoning, model, created_at, hits, tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, current_timestamp, 0, $7)
     ON CONFLICT (tenant_id, dim_id, raw) DO UPDATE
       SET suggestion  = EXCLUDED.suggestion,
           confidence  = EXCLUDED.confidence,
           reasoning   = EXCLUDED.reasoning,
           model       = EXCLUDED.model,
           created_at  = EXCLUDED.created_at`,
    [
      dimId,
      raw,
      result.suggestion,
      result.confidence,
      result.reasoning,
      "claude-haiku-4-5-20251001",
      tenantId,
    ],
  );

  return { ...result, cached: false };
}
