import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/* useEngineerMode — a workspace-wide toggle that exposes warehouse internals
   (table names, SQL, MERGE/JOIN copy, ATTACH prose). Off by default; persisted
   to localStorage; also reflected on <html data-engineer> so CSS can react. */

const KEY = "zugzug:engineer-mode";

interface Ctx { engineer: boolean; setEngineer: (on: boolean) => void }

const EngineerModeCtx = createContext<Ctx>({ engineer: false, setEngineer: () => {} });

export function EngineerModeProvider({ children }: { children: ReactNode }) {
  const [engineer, setEngineerState] = useState<boolean>(() => {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(KEY) === "1";
  });
  useEffect(() => {
    localStorage.setItem(KEY, engineer ? "1" : "0");
    document.documentElement.dataset.engineer = engineer ? "1" : "0";
  }, [engineer]);
  return <EngineerModeCtx.Provider value={{ engineer, setEngineer: setEngineerState }}>{children}</EngineerModeCtx.Provider>;
}

export function useEngineerMode(): Ctx { return useContext(EngineerModeCtx); }
