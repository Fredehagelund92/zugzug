// server/src/ai-providers/types.ts

export interface SuggestionRequest {
  refTableName: string;
  rawValue: string;
  existingRecordValues: string[];
}

export interface SuggestionResponse {
  record: string;
  confidence: "high" | "medium" | "low";
  reasoning?: string;
}

export interface AIProvider {
  suggestMapping(request: SuggestionRequest): Promise<SuggestionResponse>;
}
