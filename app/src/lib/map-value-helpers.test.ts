import { describe, it, expect } from "vitest";
import { recordKeyByLabel, suggestRecordLabel } from "./map-value-helpers";
import type { RecordValue } from "../data";

const rec = (key: string, label: string): RecordValue =>
  ({ key, label, version: 1 }) as RecordValue;

const RECORDS: RecordValue[] = [
  rec("germany", "Germany"),
  rec("united_states", "United States"),
  rec("netherlands", "Netherlands"),
];

describe("recordKeyByLabel", () => {
  it("maps each record label to its key", () => {
    const m = recordKeyByLabel(RECORDS);
    expect(m.get("Germany")).toBe("germany");
    expect(m.get("United States")).toBe("united_states");
    expect(m.get("Missing")).toBeUndefined();
  });
});

describe("suggestRecordLabel", () => {
  it("returns the closest record label for a near-match rep", () => {
    // "Germanny" falls outside buildCandidates' fold-match (it folds exactly,
    // not fuzzily); "Germany " (trailing space) folds identically to "Germany"
    // and is guaranteed within threshold.
    expect(suggestRecordLabel(RECORDS, "Germany ")).toBe("Germany");
  });
  it("returns null when nothing is close", () => {
    expect(suggestRecordLabel(RECORDS, "Zzzxqq")).toBeNull();
  });
});
