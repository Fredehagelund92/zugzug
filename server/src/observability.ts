/* observability.ts — opt-in server error tracking (Sentry). Disabled unless a
   DSN is configured (mirrors the client's VITE_SENTRY_DSN opt-in). Callers use
   initSentry/captureError/flushSentry and never import Sentry directly; the
   AppError-vs-unexpected decision lives at the call sites. */
import * as Sentry from "@sentry/bun";
import { env } from "./env.ts";

let active = false;

/** Initialize error tracking. No-op when dsn is empty. Idempotent per dsn:
 *  active is derived from the dsn argument so calls are order-independent. */
export function initSentry(
  dsn: string = env.sentryDsn,
  environment: string = env.sentryEnvironment,
): void {
  active = Boolean(dsn);
  if (!active) return;
  Sentry.init({
    dsn,
    environment: environment || "production",
    tracesSampleRate: 0,
  });
}

/** Capture an unexpected error with optional string tags. No-op when inactive.
 *  Never throws — a telemetry failure must not break the caller. */
export function captureError(e: unknown, context?: Record<string, string>): void {
  if (!active) return;
  try {
    Sentry.captureException(e, context ? { tags: context } : undefined);
  } catch {
    // swallow
  }
}

/** Drain pending events before process exit. Resolves immediately when inactive. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!active) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // swallow
  }
}
