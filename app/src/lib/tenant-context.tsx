import { createContext, useContext, type ReactNode } from "react";

export interface TenantContextValue {
  id: string;
  slug: string;
  label: string;
  role: "admin" | "editor" | "viewer";
  isSuperAdmin: boolean;
}

const Ctx = createContext<TenantContextValue | null>(null);

export function TenantProvider({
  value,
  children,
}: {
  value: TenantContextValue;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTenant(): TenantContextValue {
  const v = useContext(Ctx);
  if (!v)
    throw new Error(
      "useTenant() called outside <TenantProvider> — only valid inside /app/:slug/* routes",
    );
  return v;
}
