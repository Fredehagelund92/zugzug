// server/src/ai-providers/anthropic.ts

import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, SuggestionRequest, SuggestionResponse } from "./types";
import {
  RateLimitError,
  InvalidAPIKeyError,
  AIProviderError,
  AIResponseParseError,
} from "./openai";

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("Anthropic API key is required");
    this.client = new Anthropic({ apiKey });
  }

  async suggestMapping(request: SuggestionRequest): Promise<SuggestionResponse> {
    const { refTableName, rawValue, existingRecordValues } = request;

    const prompt = `You are a data quality specialist. Map the raw value to the most likely record value.

RefTable: ${refTableName}
Raw value: "${rawValue}"

Existing record values in this refTable:
${existingRecordValues
  .slice(0, 30)
  .map((v) => `- ${v}`)
  .join("\n")}

Respond with valid JSON (no markdown, no extra text):
{
  "record": "the best matching record value (string)",
  "confidence": "high" | "medium" | "low",
  "reasoning": "brief explanation (optional, <100 chars)"
}

Confidence guidelines:
- "high": exact match, clear spelling variant, or strong semantic match to existing values
- "medium": plausible but requires some interpretation or there's ambiguity
- "low": unclear, requires human domain knowledge, or unlikely to be correct

Always prefer a record value that already exists in the refTable if reasonable.`;

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        throw new RateLimitError("Anthropic rate limit exceeded");
      }
      if (err instanceof Anthropic.AuthenticationError) {
        throw new InvalidAPIKeyError("Anthropic API key is invalid");
      }
      if (err instanceof Anthropic.APIError) {
        throw new AIProviderError(`Anthropic API error: ${err.message}`);
      }
      throw err;
    }

    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new AIProviderError("Anthropic returned no text content");
    }

    let parsed: SuggestionResponse;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      throw new AIResponseParseError(`Failed to parse Anthropic response: ${textBlock.text}`);
    }

    if (!parsed.record || !["high", "medium", "low"].includes(parsed.confidence)) {
      throw new AIResponseParseError(
        `Anthropic response missing required fields: ${JSON.stringify(parsed)}`,
      );
    }

    return parsed;
  }
}
