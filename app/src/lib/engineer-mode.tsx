import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useWorkspaceInfo } from "../store";

/* useEngineerMode — a workspace-wide toggle that exposes warehouse internals
   (table names, SQL, MERGE/JOIN copy, ATTACH prose). Persisted to localStorage;
   when no preference is stored, falls back to the server-provided default
   (env.defaultEngineerMode). Also reflected on <html data-engineer> so CSS
   can react. */

const KEY = "zugzug:engineer-mode";

interface Ctx {
  engineer: boolean;
  setEngineer: (on: boolean) => void;
}

const EngineerModeCtx = createContext<Ctx>({ engineer: false, setEngineer: () => {} });

// Read the current localStorage preference. Returns null if no preference is set
// (caller falls back to server default or false).
function readStoredPreference(): boolean | null {
  if (typeof localStorage === "undefined") return null;
  const stored = localStorage.getItem(KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  return null;
}

export function EngineerModeProvider({ children }: { children: ReactNode }) {
  const wsInfo = useWorkspaceInfo();
  // Tri-state: true / false (user preference set) or null (no preference; fall back to server default)
  const [engineer, setEngineerState] = useState<boolean | null>(readStoredPreference);

  // When workspace info arrives AND user has no explicit preference, adopt the server default.
  useEffect(() => {
    if (engineer === null && wsInfo) {
      setEngineerState(wsInfo.defaultEngineerMode);
    }
  }, [wsInfo, engineer]);

  // Persist + reflect to <html data-engineer> when value changes (skip the null state).
  useEffect(() => {
    if (engineer === null) return;
    localStorage.setItem(KEY, engineer ? "1" : "0");
    document.documentElement.dataset.engineer = engineer ? "1" : "0";
  }, [engineer]);

  // setEngineer always writes an explicit preference (true/false), never null.
  const setEngineer = (on: boolean) => setEngineerState(on);

  // During initial render before workspace info loads AND no localStorage preference,
  // treat as false (safe — don't accidentally expose engineer details).
  const effective = engineer ?? false;

  return (
    <EngineerModeCtx.Provider value={{ engineer: effective, setEngineer }}>
      {children}
    </EngineerModeCtx.Provider>
  );
}

export function useEngineerMode(): Ctx {
  return useContext(EngineerModeCtx);
}
