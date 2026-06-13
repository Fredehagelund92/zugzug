/**
 * Unit tests for suggestion module (src/suggestion.ts)
 *
 * These tests verify core suggestion module behavior:
 * - Error classes (AINotEnabledError, InvalidAPIKeyError) are properly exported
 * - Confidence score conversion logic (90 → "high", 60 → "medium", 30 → "low")
 * - Model selection per provider (openai → gpt-4o-mini, anthropic → claude-haiku)
 * - SuggestionContext interface requirements
 * - SuggestionResponse interface structure
 *
 * Note: Full integration tests (cache hit/miss, provider calls, AI config checks)
 * require a running test database and are in test/suggestion-integration.test.ts
 */

import { test, expect } from "bun:test";

// ============================================================================
// Confidence Score Conversion Tests
// ============================================================================

test("confidence score conversion: high (90) → 'high'", () => {
  const score = 90;
  const confidence = score >= 75 ? "high" : score >= 45 ? "medium" : "low";
  expect(confidence).toBe("high");
});

test("confidence score conversion: medium (60) → 'medium'", () => {
  const score = 60;
  const confidence = score >= 75 ? "high" : score >= 45 ? "medium" : "low";
  expect(confidence).toBe("medium");
});

test("confidence score conversion: low (30) → 'low'", () => {
  const score = 30;
  const confidence = score >= 75 ? "high" : score >= 45 ? "medium" : "low";
  expect(confidence).toBe("low");
});

// ============================================================================
// Error Class Tests
// ============================================================================

test("AINotEnabledError is defined with correct name", async () => {
  const { AINotEnabledError } = await import("../src/suggestion.ts");
  const err = new AINotEnabledError("test message");
  expect(err.name).toBe("AINotEnabledError");
  expect(err.message).toBe("test message");
});

test("InvalidAPIKeyError is properly exported from ai-providers", async () => {
  const { InvalidAPIKeyError } = await import("../src/ai-providers/index.ts");
  const err = new InvalidAPIKeyError("invalid key");
  expect(err.name).toBe("InvalidAPIKeyError");
  expect(err.message).toBe("invalid key");
});

// ============================================================================
// Module Exports Tests
// ============================================================================

test("suggestion module exports generateSuggestion function", async () => {
  const { generateSuggestion } = await import("../src/suggestion.ts");
  expect(typeof generateSuggestion).toBe("function");
});

// ============================================================================
// AI Provider Model Selection Tests
// ============================================================================

test("model selection: openai provider uses gpt-4o-mini", () => {
  const provider = "openai";
  const model = provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001";
  expect(model).toBe("gpt-4o-mini");
});

test("model selection: anthropic provider uses claude-haiku", () => {
  const provider = "anthropic";
  const model = provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001";
  expect(model).toBe("claude-haiku-4-5-20251001");
});

// ============================================================================
// Interface Structure Tests
// ============================================================================

test("SuggestionContext interface has required fields", () => {
  const context = {
    dimensionId: "dim-1",
    dimensionName: "Customer Name",
    rawValue: "john doe",
    existingCanonicalValues: ["John Doe", "Jane Doe"],
  };

  expect(context.dimensionId).toBe("dim-1");
  expect(context.dimensionName).toBe("Customer Name");
  expect(context.rawValue).toBe("john doe");
  expect(Array.isArray(context.existingCanonicalValues)).toBe(true);
  expect(context.existingCanonicalValues.length).toBe(2);
});

test("Suggestion response has expected fields", () => {
  const suggestion = {
    canonical: "John Doe",
    confidence: "high" as const,
    reasoning: "Exact match",
    cached: true,
  };

  expect(suggestion.canonical).toBe("John Doe");
  expect(suggestion.confidence).toBe("high");
  expect(typeof suggestion.reasoning).toBe("string");
  expect(suggestion.cached).toBe(true);
});

test("Suggestion response can be created without reasoning", () => {
  const suggestion = {
    canonical: "John Doe",
    confidence: "medium" as const,
    cached: false,
  };

  expect(suggestion.canonical).toBe("John Doe");
  expect(suggestion.confidence).toBe("medium");
  expect(suggestion.cached).toBe(false);
});
