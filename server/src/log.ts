export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogFields {
  level: LogLevel;
  msg: string;
  reqId?: string;
  method?: string;
  path?: string;
  status?: number;
  ms?: number;
  userId?: string;
  err?: string;
  [key: string]: unknown;
}

export function log(fields: LogFields): void {
  const line = { ts: new Date().toISOString(), ...fields };
  const out = JSON.stringify(line);
  if (fields.level === "error" || fields.level === "warn") console.error(out);
  else console.log(out);
}
