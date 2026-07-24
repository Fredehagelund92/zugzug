// test/use-ai-hint.test.ts
import { describe, test, expect } from "vitest";

// validateClaudeResponse logic is replicated client-side for tests.
// We test the pure validation rules without needing the hook itself.

function validateHint(
  raw: unknown,
  recordLabels: string[],
): { suggestion: string | null; confidence: number; reasoning: string } {
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

const LABELS = ["United States", "United Kingdom", "Germany", "France"];

describe("validateHint", () => {
  test("returns valid suggestion when label is in record list", () => {
    const r = validateHint(
      { suggestion: "United Kingdom", confidence: 88, reasoning: "ISO 3166-1 alpha-2 code." },
      LABELS,
    );
    expect(r.suggestion).toBe("United Kingdom");
    expect(r.confidence).toBe(88);
    expect(r.reasoning).toBe("ISO 3166-1 alpha-2 code.");
  });

  test("rejects hallucinated suggestion not in record list", () => {
    const r = validateHint(
      { suggestion: "England", confidence: 70, reasoning: "Common name." },
      LABELS,
    );
    expect(r.suggestion).toBeNull();
    expect(r.confidence).toBe(0);
  });

  test("caps confidence at 95", () => {
    const r = validateHint({ suggestion: "Germany", confidence: 100, reasoning: "Exact." }, LABELS);
    expect(r.confidence).toBe(95);
  });

  test("sets confidence to 0 when suggestion is null", () => {
    const r = validateHint({ suggestion: null, confidence: 80, reasoning: "Ambiguous." }, LABELS);
    expect(r.confidence).toBe(0);
  });

  test("falls back reasoning when field is missing", () => {
    const r = validateHint({ suggestion: "France", confidence: 72 }, LABELS);
    expect(r.reasoning).toBe("Matched to record record.");
  });

  test("falls back reasoning for no-match", () => {
    const r = validateHint({ suggestion: null, confidence: 0 }, LABELS);
    expect(r.reasoning).toBe("No match in record set.");
  });

  test("handles non-object response", () => {
    const r = validateHint("bad string", LABELS);
    expect(r.suggestion).toBeNull();
    expect(r.confidence).toBe(0);
  });

  test("truncates reasoning to 300 chars", () => {
    const long = "x".repeat(400);
    const r = validateHint(
      { suggestion: "United States", confidence: 90, reasoning: long },
      LABELS,
    );
    expect(r.reasoning.length).toBe(300);
  });

  test("uses fallback reasoning when suggestion rejected despite valid reasoning field", () => {
    // When suggestion is rejected (not in list), reasoning should be the fallback,
    // not Claude's potentially misleading reasoning.
    const r = validateHint(
      { suggestion: "England", confidence: 70, reasoning: "This is why England matches" },
      LABELS,
    );
    expect(r.reasoning).toBe("No match in record set.");
  });
});
