export type Decision =
  | { status: "mapped"; recordKey: string; recordLabel: string }
  | { status: "skipped" };

export interface MapperState {
  /** Cluster keys in worst-impact-first order. */
  order: string[];
  /** Index into `order` of the cluster currently in the focused card. */
  cursor: number;
  /** Decision per cluster key. Absent = undecided. */
  decisions: Record<string, Decision>;
  /** Stack of cluster keys decided, most recent last — drives undo. */
  undo: string[];
}

export type MapperAction =
  | { type: "init"; clusterKeys: string[] }
  | { type: "map"; clusterKey: string; recordKey: string; recordLabel: string }
  | { type: "skip"; clusterKey: string }
  | { type: "undo" }
  | { type: "jumpTo"; index: number };

export function initMapperState(clusterKeys: string[]): MapperState {
  return { order: clusterKeys, cursor: 0, decisions: {}, undo: [] };
}

/** First index at or after `from` whose cluster is undecided; `order.length` if none. */
function nextUndecided(state: MapperState, from: number): number {
  let i = Math.max(0, from);
  while (i < state.order.length && state.decisions[state.order[i]]) i++;
  return i;
}

export function clusterMapperReducer(state: MapperState, action: MapperAction): MapperState {
  switch (action.type) {
    case "init":
      return initMapperState(action.clusterKeys);

    case "map": {
      const decisions = {
        ...state.decisions,
        [action.clusterKey]: {
          status: "mapped" as const,
          recordKey: action.recordKey,
          recordLabel: action.recordLabel,
        },
      };
      const next = { ...state, decisions, undo: [...state.undo, action.clusterKey] };
      return { ...next, cursor: nextUndecided(next, 0) };
    }

    case "skip": {
      const decisions = { ...state.decisions, [action.clusterKey]: { status: "skipped" as const } };
      const next = { ...state, decisions, undo: [...state.undo, action.clusterKey] };
      return { ...next, cursor: nextUndecided(next, 0) };
    }

    case "undo": {
      if (state.undo.length === 0) return state;
      const undo = state.undo.slice(0, -1);
      const last = state.undo[state.undo.length - 1];
      const decisions = { ...state.decisions };
      delete decisions[last];
      const cursor = state.order.indexOf(last);
      return { ...state, decisions, undo, cursor: cursor < 0 ? state.cursor : cursor };
    }

    case "jumpTo":
      return { ...state, cursor: action.index };

    default:
      return state;
  }
}

/** Number of clusters mapped (skipped clusters are not staged for publish). */
export function stagedCount(state: MapperState): number {
  return Object.values(state.decisions).filter((d) => d.status === "mapped").length;
}
