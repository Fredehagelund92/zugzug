import React from "react";
import * as Sentry from "@sentry/react";

type State = { error: Error | null };

export class RouteErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("Route error:", error, info.componentStack);
    if (import.meta.env.VITE_SENTRY_DSN) {
      Sentry.captureException(error, {
        contexts: { react: { componentStack: info.componentStack } },
      });
    }
  }

  reset = (): void => this.setState({ error: null });

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center bg-bg p-6 text-ink">
        <div className="max-w-md space-y-4 text-center">
          <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-ink-3">
            Something went wrong
          </div>
          <div className="font-display text-2xl font-semibold">The app hit an unexpected error</div>
          <p className="text-sm text-ink-2">
            {this.state.error.message || "An unknown error occurred."}
          </p>
          <div className="flex justify-center gap-2 pt-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded border border-line px-3 py-1.5 text-sm hover:border-accent"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.assign("/app")}
              className="rounded bg-accent px-3 py-1.5 text-sm text-accent-ink"
            >
              Go to dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }
}
