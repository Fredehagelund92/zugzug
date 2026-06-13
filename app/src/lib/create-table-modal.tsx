import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { CreateTableModal } from "../components/CreateTableModal";
import { useOpenTabs } from "./open-tabs";
import { useNavLinks } from "./use-tenant-navigate";

interface UseCreateTableModal {
  open: () => void;
}

const Ctx = createContext<UseCreateTableModal | null>(null);

export function CreateTableModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const { openTab } = useOpenTabs();
  const navigate = useNavigate();
  const navLinks = useNavLinks();

  const open = useCallback(() => setIsOpen(true), []);
  const value = useMemo<UseCreateTableModal>(() => ({ open }), [open]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <CreateTableModal
        open={isOpen}
        onClose={() => setIsOpen(false)}
        onCreated={(id) => {
          openTab(id);
          navigate(navLinks.tables);
        }}
      />
    </Ctx.Provider>
  );
}

export function useCreateTableModal(): UseCreateTableModal {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCreateTableModal must be used within CreateTableModalProvider");
  return v;
}
