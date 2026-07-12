import { useEffect, useState } from "react";
import { Mark } from "./Mark";
import { Button } from "./Button";
import { authFetch } from "../api";

export function NoWorkspaceLanding() {
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() => window.location.replace("/login"));

  // Poll memberships so the user is dropped in the moment an admin adds them.
  useEffect(() => {
    void authFetch("/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((me: { email?: string } | null) => setEmail(me?.email ?? null));
    const t = window.setInterval(() => {
      void authFetch("/me/memberships")
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { memberships?: unknown[] } | null) => {
          if (Array.isArray(body?.memberships) && body.memberships.length > 0)
            window.location.reload();
        });
    }, 30_000);
    return () => window.clearInterval(t);
  }, []);

  const copyEmail = () => {
    if (!email) return;
    void navigator.clipboard.writeText(email).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      window.prompt("Copy your email:", email);
    });
  };

  return (
    <div className="zz-canvas grid min-h-screen place-items-center p-8">
      <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-8 text-center">
        <Mark className="mx-auto h-10 w-10" />
        <h1 className="font-display text-2xl font-bold text-ink">
          You&apos;re not in any workspace yet.
        </h1>
        <p className="text-ink-2">
          Ask a workspace admin to add your email in Settings → Members. This page checks
          automatically every 30 seconds — you&apos;ll be dropped straight in once they do.
        </p>
        <div className="flex items-center justify-center gap-2">
          {email && (
            <Button variant="secondary" onClick={copyEmail}>
              {copied ? "Copied!" : "Copy my email"}
            </Button>
          )}
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Check now
          </Button>
          <Button onClick={signOut}>Sign out</Button>
        </div>
      </div>
    </div>
  );
}
