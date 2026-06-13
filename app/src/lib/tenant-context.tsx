import { createContext, useContext, type ReactNode } from "react";

export interface TenantContextValue {
  id: string;
  slug: string;
  label: string;
  color: string | null;
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

/** Like useTenant() but returns null instead of throwing outside the provider.
 *  Use from hooks that may be called from non-tenant routes (e.g. account shell). */
export function useTenantOptional(): TenantContextValue | null {
  return useContext(Ctx);
}
