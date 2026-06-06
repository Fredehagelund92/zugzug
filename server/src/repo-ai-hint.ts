import { env } from "./env.ts";

export interface AiHint {
  suggestion: string | null;
  confidence: number;
  reasoning:  string;
}

export interface AiHintResult extends AiHint {
  cached: boolean;
}

interface DimContext {
  label: string;
}

// ── validation ────────────────────────────────────────────────────────────────

export function validateClaudeResponse(
  raw: unknown,
  canonicalLabels: string[],
): AiHint {
  if (typeof raw !== "object" || raw === null) {
    return { suggestion: null, confidence: 0, reasoning: "Invalid response from AI." };
  }
  const r = raw as Record<string, unknown>;

  const suggestion =
    typeof r.suggestion === "string" && canonicalLabels.includes(r.suggestion)
      ? r.suggestion
      : null;

  const confidence =
    suggestion !== null && typeof r.confidence === "number"
      ? Math.max(0, Math.min(95, Math.round(r.confidence)))
      : 0;

  const reasoning =
    suggestion === null
      ? "No match in canonical set."
      : typeof r.reasoning === "string" && r.reasoning.length > 0
        ? r.reasoning.slice(0, 300)
        : "Matched to canonical record.";

  return { suggestion, confidence, reasoning };
}

// ── Claude API call ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a data mapping assistant for a Master Data Management tool. Match a raw source value to the best canonical record in a controlled vocabulary.

Respond ONLY with a JSON object:
{"suggestion": string | null, "confidence": number, "reasoning": string}

Rules:
- suggestion: exact string from the canonical list or null if no match
- confidence: 0-100. >90 = unambiguous (abbreviation, translation, alternate spelling). 60-89 = plausible. <60 = guessing. 0 only when suggestion is null.
- reasoning: 1-2 sentences, terse and concrete, max 200 chars. Show pattern evidence (e.g. "ISO 3166-1 alpha-2 code. DE→Germany, FR→France.")
- Never invent a suggestion not in the canonical list
- Never set confidence above 95`;

export async function callClaude(
  raw: string,
  canonicalLabels: string[],
  dim: DimContext,
): Promise<AiHint> {
  if (!env.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const canonicalBlock =
    canonicalLabels.length > 0
      ? canonicalLabels.map((l, i) => `${i + 1}. ${l}`).join("\n")
      : "(empty — no canonical records exist yet)";

  const userMessage = `Dimension: ${dim.label}

Canonical options:
${canonicalBlock}

Raw source value to match: "${raw}"`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(8000),
    headers: {
      "content-type":    "application/json",
      "x-api-key":       env.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userMessage }],
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

  return validateClaudeResponse(parsed, canonicalLabels);
}
