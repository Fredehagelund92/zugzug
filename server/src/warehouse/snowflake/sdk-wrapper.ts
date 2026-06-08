import snowflake from "snowflake-sdk";
import type { Binds } from "snowflake-sdk";
import type { SnowflakeCreds } from "../credentials.ts";

// Minimal promise-shaped surface the adapter uses. Implementations:
//   - createRealConnection (production)
//   - mock connection (tests)
export interface SnowflakeConnection {
  /** Execute a SQL statement with optional positional binds.
   *  Returns the result rows as plain objects (column names lowercase by default
   *  — see Snowflake's case-folding notes in the adapter). */
  execute(opts: { sqlText: string; binds?: unknown[] }): Promise<Record<string, unknown>[]>;

  /** Execute a SQL statement and return the number of rows affected.
   *  Used by writable operations (MERGE INTO, INSERT). */
  executeAffected(opts: { sqlText: string; binds?: unknown[] }): Promise<number>;

  /** Close the underlying connection (called once at process exit; tests don't need to call). */
  close(): Promise<void>;
}

/** Production factory: wraps the real snowflake-sdk callback API in promises.
 *  LIVE-VALIDATION: this function is unverified against a real Snowflake account
 *  until credentials exist. The error path (auth failure, network) needs a
 *  smoke pass before claiming production-ready. */
export function createRealConnection(creds: SnowflakeCreds): SnowflakeConnection {
  // LIVE-VALIDATION: key-pair auth format. snowflake-sdk expects either:
  //   - authenticator: 'SNOWFLAKE_JWT' + privateKey: <PEM string>
  //   - authenticator: 'SNOWFLAKE' + password
  // The PEM must include the BEGIN/END markers. If the user passes a path,
  // they must load it themselves before constructing creds.
  const connection = snowflake.createConnection({
    account: creds.account,
    username: creds.user,
    authenticator: "SNOWFLAKE_JWT",
    privateKey: creds.privateKey,
    privateKeyPass: creds.privateKeyPassphrase,
    warehouse: creds.warehouse,
    database: creds.database,
    schema: creds.schema,
  });

  // Single-flight connect; subsequent execute() calls reuse it.
  let connected: Promise<void> | null = null;
  function ensureConnected(): Promise<void> {
    if (connected) return connected;
    connected = new Promise<void>((resolve, reject) => {
      connection.connect((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return connected;
  }

  return {
    async execute(opts) {
      await ensureConnected();
      return new Promise<Record<string, unknown>[]>((resolve, reject) => {
        connection.execute({
          sqlText: opts.sqlText,
          binds: opts.binds as Binds | undefined,
          complete: (err, _stmt, rows) => {
            if (err) reject(err);
            else resolve((rows ?? []) as Record<string, unknown>[]);
          },
        });
      });
    },

    async executeAffected(opts) {
      await ensureConnected();
      return new Promise<number>((resolve, reject) => {
        connection.execute({
          sqlText: opts.sqlText,
          binds: opts.binds as Binds | undefined,
          complete: (err, stmt) => {
            if (err) return reject(err);
            // LIVE-VALIDATION: confirm getNumUpdatedRows() returns the MERGE row count.
            // Per docs, MERGE statements set "number of rows affected" reflecting
            // INSERTed + UPDATEd + DELETEd. With INSERT-only MERGE the count = inserts.
            resolve(stmt?.getNumUpdatedRows?.() ?? 0);
          },
        });
      });
    },

    async close() {
      return new Promise<void>((resolve, reject) => {
        connection.destroy((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
