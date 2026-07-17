import { describe, it, expect } from "vitest";
import {
  initMapperState,
  clusterMapperReducer,
  stagedCount,
  type MapperState,
} from "./cluster-mapper-reducer";

const KEYS = ["usa", "germany", "uk"];
const init = (): MapperState => initMapperState(KEYS);

describe("clusterMapperReducer", () => {
  it("initializes at cursor 0 with no decisions", () => {
    const s = init();
    expect(s.order).toEqual(KEYS);
    expect(s.cursor).toBe(0);
    expect(s.decisions).toEqual({});
    expect(s.undo).toEqual([]);
  });

  it("map records the decision and advances to the next undecided cluster", () => {
    const s = clusterMapperReducer(init(), {
      type: "map",
      clusterKey: "usa",
      recordKey: "us",
      recordLabel: "United States",
    });
    expect(s.decisions.usa).toEqual({
      status: "mapped",
      recordKey: "us",
      recordLabel: "United States",
    });
    expect(s.cursor).toBe(1); // advanced to "germany"
    expect(s.undo).toEqual(["usa"]);
    expect(stagedCount(s)).toBe(1);
  });

  it("skip records a skipped decision and advances", () => {
    const s = clusterMapperReducer(init(), { type: "skip", clusterKey: "usa" });
    expect(s.decisions.usa).toEqual({ status: "skipped" });
    expect(s.cursor).toBe(1);
    expect(stagedCount(s)).toBe(0); // skipped is not staged
  });

  it("advance skips over already-decided clusters", () => {
    let s = init();
    s = clusterMapperReducer(s, {
      type: "map",
      clusterKey: "germany",
      recordKey: "de",
      recordLabel: "Germany",
    });
    // cursor started at 0 (usa), germany was decided out of order → advance from 0 stays at 0 (usa undecided)
    expect(s.cursor).toBe(0);
    s = clusterMapperReducer(s, {
      type: "map",
      clusterKey: "usa",
      recordKey: "us",
      recordLabel: "United States",
    });
    // usa + germany decided → next undecided is "uk" (index 2)
    expect(s.cursor).toBe(2);
  });

  it("undo reverts the last decision and moves the cursor back to it", () => {
    let s = clusterMapperReducer(init(), {
      type: "map",
      clusterKey: "usa",
      recordKey: "us",
      recordLabel: "United States",
    });
    s = clusterMapperReducer(s, { type: "undo" });
    expect(s.decisions.usa).toBeUndefined();
    expect(s.cursor).toBe(0);
    expect(s.undo).toEqual([]);
    expect(stagedCount(s)).toBe(0);
  });

  it("undo with an empty stack is a no-op", () => {
    const s = init();
    expect(clusterMapperReducer(s, { type: "undo" })).toBe(s);
  });

  it("init action resets to a fresh state for the given keys", () => {
    let s = clusterMapperReducer(init(), {
      type: "map",
      clusterKey: "usa",
      recordKey: "us",
      recordLabel: "United States",
    });
    s = clusterMapperReducer(s, { type: "init", clusterKeys: ["a", "b"] });
    expect(s.order).toEqual(["a", "b"]);
    expect(s.cursor).toBe(0);
    expect(s.decisions).toEqual({});
    expect(s.undo).toEqual([]);
  });

  it("jumpTo sets the cursor", () => {
    const s = clusterMapperReducer(init(), { type: "jumpTo", index: 2 });
    expect(s.cursor).toBe(2);
  });

  it("when all clusters are decided, cursor lands at order.length", () => {
    let s = init();
    for (const k of KEYS) s = clusterMapperReducer(s, { type: "skip", clusterKey: k });
    expect(s.cursor).toBe(KEYS.length);
  });
});
