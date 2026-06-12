import { Mark } from "./Mark";
import { Button } from "./Button";
import { authFetch } from "../api";

export function NoWorkspaceLanding() {
  const signOut = () =>
    authFetch("/auth/logout", { method: "POST" }).then(() => window.location.replace("/login"));

  return (
    <div className="zz-canvas grid min-h-screen place-items-center p-8">
      <div className="max-w-lg space-y-4 rounded-lg border border-line bg-surface p-8 text-center">
        <Mark className="mx-auto h-10 w-10" />
        <h1 className="font-display text-2xl font-bold text-ink">You&apos;re not in any workspace yet.</h1>
        <p className="text-ink-2">
          Ask a workspace admin to invite your email. Once they do, refresh this page and you&apos;ll be
          dropped straight into the workspace.
        </p>
        <Button onClick={signOut}>Sign out</Button>
      </div>
    </div>
  );
}
