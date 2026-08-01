import type { DuckDbCreds } from "../credentials.ts";

/** What DuckDB should be handed for a given set of credentials.
 *
 *  A local warehouse file is opened READ_ONLY whenever the adapter is the
 *  read-only one (record writes go to Postgres). DuckDB allows many concurrent
 *  READ_ONLY handles but only one read-write handle, so this is what lets the
 *  demo reset run while the server is up (#217). */
export function resolveOpen(creds: DuckDbCreds): {
  path: string;
  options: Record<string, string>;
  isReadOnlyFile: boolean;
} {
  // MotherDuck: open `md:` directly so every MD database is a first-class catalog.
  if (creds.attached && creds.token) {
    return {
      path: `md:?motherduck_token=${encodeURIComponent(creds.token)}`,
      options: {},
      isReadOnlyFile: false,
    };
  }
  const path = creds.path ?? ":memory:";
  const readOnly = path !== ":memory:" && !creds.writable;
  return {
    path,
    options: readOnly ? { access_mode: "READ_ONLY" } : {},
    isReadOnlyFile: readOnly,
  };
}
