import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { useDimensions } from "../store";

declare const __tabId: unique symbol;
export type TabId = string & { readonly [__tabId]: true };

const TAB_PREFIX = "tables:";

export function makeTabId(dimId: string): TabId {
  return `${TAB_PREFIX}${dimId}` as TabId;
}
export function dimIdFromTabId(id: TabId): string {
  return id.slice(TAB_PREFIX.length);
}

export interface OpenTab {
  id: TabId;
  dimId: string;
  pinned: boolean;
  openedAt: number;
}

export interface OpenTabsState {
  tabs: OpenTab[];
  activeId: TabId | null;
}

export interface UseOpenTabs extends OpenTabsState {
  openTab: (dimId: string) => TabId;
  closeTab: (id: TabId) => void;
  focusTab: (id: TabId) => void;
  pinTab: (id: TabId, pinned: boolean) => void;
  reorderTabs: (fromIdx: number, toIdx: number) => void;
}

type Action =
  | { type: "open"; dimId: string; now: number }
  | { type: "close"; id: TabId }
  | { type: "focus"; id: TabId }
  | { type: "pin"; id: TabId; pinned: boolean }
  | { type: "reorder"; fromIdx: number; toIdx: number }
  | { type: "prune"; validDimIds: Set<string> }
  | { type: "hydrate"; state: OpenTabsState };

function reducer(state: OpenTabsState, a: Action): OpenTabsState {
  switch (a.type) {
    case "open": {
      const id = makeTabId(a.dimId);
      if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id };
      const tabs = [...state.tabs, { id, dimId: a.dimId, pinned: false, openedAt: a.now }];
      return { tabs, activeId: id };
    }
    case "close": {
      const idx = state.tabs.findIndex((t) => t.id === a.id);
      if (idx < 0) return state;
      const tabs = state.tabs.filter((t) => t.id !== a.id);
      let activeId = state.activeId;
      if (state.activeId === a.id) {
        const fallback = tabs[idx] ?? tabs[idx - 1] ?? tabs[tabs.length - 1] ?? null;
        activeId = fallback?.id ?? null;
      }
      return { tabs, activeId };
    }
    case "focus": {
      if (!state.tabs.some((t) => t.id === a.id)) return state;
      return { ...state, activeId: a.id };
    }
    case "pin": {
      const tabs = state.tabs.map((t) => (t.id === a.id ? { ...t, pinned: a.pinned } : t));
      tabs.sort((x, y) => Number(y.pinned) - Number(x.pinned));
      return { ...state, tabs };
    }
    case "reorder": {
      const { fromIdx, toIdx } = a;
      if (fromIdx === toIdx) return state;
      const tabs = state.tabs.slice();
      const [moved] = tabs.splice(fromIdx, 1);
      if (!moved) return state;
      tabs.splice(toIdx, 0, moved);
      return { ...state, tabs };
    }
    case "prune": {
      const tabs = state.tabs.filter((t) => a.validDimIds.has(t.dimId));
      if (tabs.length === state.tabs.length) return state;
      const activeId =
        state.activeId && tabs.some((t) => t.id === state.activeId)
          ? state.activeId
          : (tabs[0]?.id ?? null);
      return { tabs, activeId };
    }
    case "hydrate":
      return a.state;
  }
}

const STORAGE_KEY = "zugzug:open-tabs";

interface Serialized {
  tabs: Array<{ id: string; dimId: string; pinned: boolean; openedAt: number }>;
  activeId: string | null;
}

function readStored(): OpenTabsState {
  if (typeof localStorage === "undefined") return { tabs: [], activeId: null };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { tabs: [], activeId: null };
    const parsed = JSON.parse(raw) as Serialized;
    return {
      tabs: parsed.tabs.map((t) => ({
        id: t.id as TabId,
        dimId: t.dimId,
        pinned: t.pinned,
        openedAt: t.openedAt,
      })),
      activeId: (parsed.activeId as TabId | null) ?? null,
    };
  } catch {
    return { tabs: [], activeId: null };
  }
}

function writeStored(state: OpenTabsState): void {
  if (typeof localStorage === "undefined") return;
  try {
    const payload: Serialized = {
      tabs: state.tabs.map((t) => ({
        id: t.id,
        dimId: t.dimId,
        pinned: t.pinned,
        openedAt: t.openedAt,
      })),
      activeId: state.activeId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / disabled — silently fall back to ephemeral */
  }
}

const Ctx = createContext<UseOpenTabs | null>(null);

export function OpenTabsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, readStored);
  const dims = useDimensions();

  useEffect(() => {
    const validDimIds = new Set(dims.map((d) => d.id));
    dispatch({ type: "prune", validDimIds });
  }, [dims]);

  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      writeStored(state);
      writeTimer.current = null;
    }, 200);
    return () => {
      if (writeTimer.current) clearTimeout(writeTimer.current);
    };
  }, [state]);

  const openTab = useCallback((dimId: string): TabId => {
    dispatch({ type: "open", dimId, now: Date.now() });
    return makeTabId(dimId);
  }, []);
  const closeTab = useCallback((id: TabId) => dispatch({ type: "close", id }), []);
  const focusTab = useCallback((id: TabId) => dispatch({ type: "focus", id }), []);
  const pinTab = useCallback(
    (id: TabId, pinned: boolean) => dispatch({ type: "pin", id, pinned }),
    [],
  );
  const reorderTabs = useCallback(
    (fromIdx: number, toIdx: number) => dispatch({ type: "reorder", fromIdx, toIdx }),
    [],
  );

  const value = useMemo<UseOpenTabs>(
    () => ({
      tabs: state.tabs,
      activeId: state.activeId,
      openTab,
      closeTab,
      focusTab,
      pinTab,
      reorderTabs,
    }),
    [state, openTab, closeTab, focusTab, pinTab, reorderTabs],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOpenTabs(): UseOpenTabs {
  const v = useContext(Ctx);
  if (!v) throw new Error("useOpenTabs must be used within OpenTabsProvider");
  return v;
}

export function useActiveDimId(): string | null {
  const { activeId } = useOpenTabs();
  return activeId ? dimIdFromTabId(activeId) : null;
}
