// server/src/ai-providers/openai.ts

import type { AIProvider, SuggestionRequest, SuggestionResponse } from "./types";

export class OpenAIProvider implements AIProvider {
  private apiKey: string;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("OpenAI API key is required");
    this.apiKey = apiKey;
  }

  async suggestMapping(request: SuggestionRequest): Promise<SuggestionResponse> {
    const { dimensionName, rawValue, existingCanonicalValues } = request;

    const prompt = `You are a data quality specialist. Map the raw value to the most likely canonical value.

Dimension: ${dimensionName}
Raw value: "${rawValue}"

Existing canonical values in this dimension:
${existingCanonicalValues
  .slice(0, 30)
  .map((v) => `- ${v}`)
  .join("\n")}

Respond with valid JSON (no markdown, no extra text):
{
  "canonical": "the best matching canonical value (string)",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation (optional, <100 chars)"
}

Confidence guidelines:
- "high": exact match, clear spelling variant, or strong semantic match to existing values
- "medium": plausible but requires some interpretation or there's ambiguity
- "low": unclear, requires human domain knowledge, or unlikely to be correct

Always prefer a canonical value that already exists in the dimension if reasonable.`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as { error?: { message?: string } };
      const status = response.status;
      if (status === 429) {
        throw new RateLimitError("OpenAI rate limit exceeded");
      }
      if (status === 401) {
        throw new InvalidAPIKeyError("OpenAI API key is invalid");
      }
      throw new AIProviderError(`OpenAI API error: ${error.error?.message || "unknown error"}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new AIProviderError("OpenAI returned empty response");
    }

    let parsed: SuggestionResponse;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new AIResponseParseError(`Failed to parse OpenAI response: ${content}`);
    }

    if (!parsed.canonical || !["high", "medium", "low"].includes(parsed.confidence)) {
      throw new AIResponseParseError(
        `OpenAI response missing required fields: ${JSON.stringify(parsed)}`,
      );
    }

    return parsed;
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class InvalidAPIKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAPIKeyError";
  }
}

export class AIProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderError";
  }
}

export class AIResponseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIResponseParseError";
  }
}
