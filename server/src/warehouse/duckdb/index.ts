import type { WarehouseAdapter } from "../adapter.ts";
import type { DuckDbCreds } from "../credentials.ts";
import { DuckDbReadOnlyAdapter } from "./read-only.ts";
import { DuckDbWritableAdapter } from "./writable.ts";

export { DuckDbReadOnlyAdapter } from "./read-only.ts";
export { DuckDbWritableAdapter } from "./writable.ts";
export { DuckDbBase, toStringList } from "./base.ts";

/** Factory: returns the right adapter variant based on credentials.writable.
 *  Used by server.ts and bootstrap.ts's registerFactories() calls. */
export function createDuckDbAdapter(creds: DuckDbCreds): WarehouseAdapter {
  return creds.writable ? new DuckDbWritableAdapter(creds) : new DuckDbReadOnlyAdapter(creds);
}
