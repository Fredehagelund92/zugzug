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
import { useRefTables, useStoreLoading } from "../store";
import { scopedKey } from "./tenant-storage";

declare const __tabId: unique symbol;
export type TabId = string & { readonly [__tabId]: true };

const TAB_PREFIX = "tables:";

export function makeTabId(refTableId: string): TabId {
  return `${TAB_PREFIX}${refTableId}` as TabId;
}
export function refTableIdFromTabId(id: TabId): string {
  if (!id.startsWith(TAB_PREFIX)) {
    throw new Error(
      `refTableIdFromTabId: malformed tab id (missing "${TAB_PREFIX}" prefix): ${id}`,
    );
  }
  return id.slice(TAB_PREFIX.length);
}

export interface OpenTab {
  id: TabId;
  refTableId: string;
  pinned: boolean;
  openedAt: number;
}

export interface OpenTabsState {
  tabs: OpenTab[];
  activeId: TabId | null;
}

export interface UseOpenTabs extends OpenTabsState {
  openTab: (refTableId: string) => TabId;
  closeTab: (id: TabId) => void;
  focusTab: (id: TabId) => void;
  pinTab: (id: TabId, pinned: boolean) => void;
  reorderTabs: (fromIdx: number, toIdx: number) => void;
}

type Action =
  | { type: "open"; refTableId: string; now: number }
  | { type: "close"; id: TabId }
  | { type: "focus"; id: TabId }
  | { type: "pin"; id: TabId; pinned: boolean }
  | { type: "reorder"; fromIdx: number; toIdx: number }
  | { type: "prune"; validRefTableIds: Set<string> }
  | { type: "hydrate"; state: OpenTabsState };

function reducer(state: OpenTabsState, a: Action): OpenTabsState {
  switch (a.type) {
    case "open": {
      const id = makeTabId(a.refTableId);
      if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id };
      const tabs = [
        ...state.tabs,
        { id, refTableId: a.refTableId, pinned: false, openedAt: a.now },
      ];
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
      const tabs = state.tabs.filter((t) => a.validRefTableIds.has(t.refTableId));
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

const STORAGE_KEY_BASE = "zugzug:open-tabs";

interface Serialized {
  tabs: Array<{ id: string; refTableId: string; pinned: boolean; openedAt: number }>;
  activeId: string | null;
}

function readStored(storageKey: string): OpenTabsState {
  if (typeof localStorage === "undefined") return { tabs: [], activeId: null };
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return { tabs: [], activeId: null };
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { tabs?: unknown }).tabs)
    ) {
      return { tabs: [], activeId: null };
    }
    const p = parsed as Serialized;
    const tabs: OpenTab[] = [];
    for (const t of p.tabs) {
      if (typeof t?.id !== "string" || !t.id.startsWith(TAB_PREFIX)) continue;
      if (typeof t.refTableId !== "string" || t.refTableId.length === 0) continue;
      tabs.push({
        id: t.id as TabId,
        refTableId: t.refTableId,
        pinned: !!t.pinned,
        openedAt: typeof t.openedAt === "number" ? t.openedAt : Date.now(),
      });
    }
    const activeId =
      typeof p.activeId === "string" && p.activeId.startsWith(TAB_PREFIX)
        ? (p.activeId as TabId)
        : null;
    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: null };
  }
}

function writeStored(storageKey: string, state: OpenTabsState): void {
  if (typeof localStorage === "undefined") return;
  try {
    const payload: Serialized = {
      tabs: state.tabs.map((t) => ({
        id: t.id,
        refTableId: t.refTableId,
        pinned: t.pinned,
        openedAt: t.openedAt,
      })),
      activeId: state.activeId,
    };
    localStorage.setItem(storageKey, JSON.stringify(payload));
  } catch {
    /* quota / disabled — silently fall back to ephemeral */
  }
}

const Ctx = createContext<UseOpenTabs | null>(null);

export function OpenTabsProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const storageKey = scopedKey(STORAGE_KEY_BASE, slug);
  const [state, dispatch] = useReducer(reducer, undefined, () => readStored(storageKey));
  const refTables = useRefTables();
  const storeLoading = useStoreLoading();

  useEffect(() => {
    if (storeLoading) return;
    const validRefTableIds = new Set(refTables.map((d) => d.id));
    dispatch({ type: "prune", validRefTableIds });
  }, [refTables, storeLoading]);

  const writeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (writeTimer.current) clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      writeStored(storageKey, state);
      writeTimer.current = null;
    }, 200);
    return () => {
      if (writeTimer.current) clearTimeout(writeTimer.current);
    };
  }, [storageKey, state]);

  const openTab = useCallback((refTableId: string): TabId => {
    dispatch({ type: "open", refTableId, now: Date.now() });
    return makeTabId(refTableId);
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

export function useActiveRefTableId(): string | null {
  const { activeId } = useOpenTabs();
  return activeId ? refTableIdFromTabId(activeId) : null;
}
