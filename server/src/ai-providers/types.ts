// server/src/ai-providers/types.ts

export interface SuggestionRequest {
  dimensionName: string;
  rawValue: string;
  existingCanonicalValues: string[];
}

export interface SuggestionResponse {
  canonical: string;
  confidence: "high" | "medium" | "low";
  reasoning?: string;
}

export interface AIProvider {
  suggestMapping(request: SuggestionRequest): Promise<SuggestionResponse>;
}
