import { useState, useEffect, useRef } from "react";
import { Card } from "../components/Card";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { FormField } from "../components/FormField";
import { PageHeader } from "../components/PageHeader";
import { SegControl } from "../components/SegControl";
import { ThresholdRange } from "../components/ThresholdRange";
import { cx } from "../lib/cx";
import { useEngineerMode } from "../lib/engineer-mode";
import { usePreferences, setPreferences, currentUser, scanSources } from "../store";

/* Every control on this page persists on change — there is no Save button. */

/* Settings — workspace, appearance (theme), the DuckDB connection, and matching
   defaults. Token-driven, squared. UI only. */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-0">
      <div className="border-b border-line px-6 py-4">
        <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-ink-2">{hint}</p>}
      </div>
      <div className="space-y-5 px-6 py-5">{children}</div>
    </Card>
  );
}

const input =
  "w-full max-w-sm rounded-sm border border-line-2 bg-bg px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";

interface ScanStatus {
  lastScanAt: string | null;
  sourceCount: number;
  unmappedCount: number;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function ScansSection() {
  const prefs = usePreferences();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    fetch("/api/sources/scan-status")
      .then((r) => r.json() as Promise<ScanStatus>)
      .then(setStatus)
      .catch(() => {});
  }, []);

  const handleScheduleChange = (next: string | null) => {
    void setPreferences({
      ...prefs,
      scanSchedule: next as "15m" | "hourly" | "daily" | null,
    });
  };

  const handleScanNow = async () => {
    setScanning(true);
    try {
      await scanSources();
      const fresh = await fetch("/api/sources/scan-status").then(
        (r) => r.json() as Promise<ScanStatus>,
      );
      setStatus(fresh);
    } finally {
      setScanning(false);
    }
  };

  const scheduleOptions = [
    { value: null,     label: "Off" },
    { value: "15m",    label: "15 min" },
    { value: "hourly", label: "Hourly" },
    { value: "daily",  label: "Daily" },
  ];

  return (
    <Section
      title="Scans"
      hint="How often Zug Zug checks your warehouse sources for new unmapped values."
    >
      <FormField label="Schedule">
        <SegControl
          value={prefs.scanSchedule}
          options={scheduleOptions}
          onChange={handleScheduleChange}
        />
      </FormField>

      {status && (
        <div className="flex items-center justify-between rounded-sm border border-line bg-surface-2 px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className={cx(
                "inline-block h-2 w-2 rounded-full",
                status.unmappedCount > 0
                  ? "bg-accent shadow-[0_0_6px_var(--accent)]"
                  : "bg-ok shadow-[0_0_6px_var(--ok)]",
              )}
            />
            <span className="font-mono text-[11.5px] text-ink-2">
              last scan {relativeTime(status.lastScanAt)}
              {" · "}
              {status.sourceCount} {status.sourceCount === 1 ? "source" : "sources"}
              {status.unmappedCount > 0 && (
                <span className="text-accent"> · {status.unmappedCount} unmapped</span>
              )}
            </span>
          </div>
          <Button onClick={() => void handleScanNow()} loading={scanning}>
            Scan now
          </Button>
        </div>
      )}

      {!status && prefs.scanSchedule && (
        <p className="font-mono text-[11px] text-ink-3">Loading scan status…</p>
      )}
    </Section>
  );
}

interface Member {
  email: string;
  addedBy: string;
  addedAt: string;
}

function TeamSection() {
  const [members, setMembers] = useState<Member[]>([]);
  const [addEmail, setAddEmail] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => {
    fetch("/api/team/members")
      .then((r) => r.json())
      .then((data: Member[]) => setMembers(data))
      .catch(() => {});
  };

  useEffect(load, []);

  const add = async () => {
    setAddError(null);
    if (!addEmail.trim()) return;
    setAdding(true);
    try {
      const res = await fetch("/api/team/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: addEmail.trim().toLowerCase() }),
      });
      if (res.status === 409) {
        setAddError("Already added.");
        return;
      }
      if (res.status === 400) {
        setAddError("Must be a @example.com email.");
        return;
      }
      if (!res.ok) {
        setAddError("Something went wrong.");
        return;
      }
      setAddEmail("");
      load();
    } finally {
      setAdding(false);
      inputRef.current?.focus();
    }
  };

  const remove = async (email: string) => {
    const res = await fetch(`/api/team/members/${encodeURIComponent(email)}`, { method: "DELETE" });
    if (res.ok) load();
  };

  const myEmail = currentUser.email;

  return (
    <Section
      title="Team"
      hint="Only people on this list can log in. Any team member can add or remove others."
    >
      <ul className="divide-y divide-line rounded-sm border border-line">
        {members.length === 0 && (
          <li className="px-4 py-3 text-[13px] text-ink-3">No members yet.</li>
        )}
        {members.map((m) => (
          <li key={m.email} className="flex items-center gap-3 px-4 py-2.5">
            <span className="flex-1 font-mono text-[12px] text-ink">{m.email}</span>
            <span className="text-[11px] text-ink-3">
              added by {m.addedBy === "bootstrap" ? "bootstrap" : m.addedBy}
            </span>
            {m.email !== myEmail && (
              <button
                type="button"
                onClick={() => remove(m.email)}
                className="text-[11px] text-ink-3 hover:text-warn"
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-start gap-2">
        <div className="flex-1 space-y-1">
          <input
            ref={inputRef}
            className={input}
            placeholder="colleague@example.com"
            value={addEmail}
            onChange={(e) => {
              setAddEmail(e.target.value);
              setAddError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            disabled={adding}
          />
          {addError && <p className="font-mono text-[11px] text-warn">{addError}</p>}
        </div>
        <Button onClick={() => void add()} disabled={adding || !addEmail.trim()}>
          {adding ? "Adding…" : "Add"}
        </Button>
      </div>
    </Section>
  );
}

export function Settings() {
  const { engineer, setEngineer } = useEngineerMode();
  const prefs = usePreferences();

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-8">
      <PageHeader kicker="Workspace" title="Settings" lede="Changes are saved as you make them." />

      <div className="zz-rise" style={{ animationDelay: "60ms" }}>
        <ScansSection />
      </div>

      <div className="zz-rise" style={{ animationDelay: "100ms" }}>
        <Section title="Appearance" hint="Theme follows the toggle in the top bar.">
          <FormField label="Engineer details">
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={engineer}
                aria-label="Engineer details"
                onClick={() => setEngineer(!engineer)}
                className={cx("ak-toggle", engineer && "on")}
              />
              <span className="text-[13px] text-ink-2">
                Show warehouse table names, SQL, and join warnings
              </span>
            </div>
          </FormField>
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "140ms" }}>
        <Section
          title="Connections"
          hint={
            engineer
              ? "Reads your warehouse (MotherDuck), writes records to its own MotherDuck database, and keeps multi-user app state in Postgres."
              : "Where Zug Zug is connected."
          }
        >
          {engineer ? (
            <>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[14px] font-semibold text-ink">
                      Warehouse
                    </span>
                    <Badge>read-only</Badge>
                  </div>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
                  <span className="text-ink-2">md:analytics</span>
                  <span>·</span>
                  <span>attached &amp; scanned for source values — never written to</span>
                </div>
              </div>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[14px] font-semibold text-ink">
                      Master store
                    </span>
                    <Badge>MotherDuck</Badge>
                  </div>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
                  <span className="text-ink-2">md:zugzug</span>
                  <span>·</span>
                  <span>its own database — every dim_* master + map_* lookup dbt joins</span>
                </div>
              </div>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-[14px] font-semibold text-ink">
                      App state
                    </span>
                    <Badge tone="accent">Postgres</Badge>
                  </div>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-ink-2">
                  <span className="text-ink-2">postgres://zugzug</span>
                  <span>·</span>
                  <span>drafts, audit log, users &amp; presence — the multi-user layer</span>
                </div>
              </div>
              <p className="font-mono text-[10.5px] leading-relaxed text-ink-3">
                DuckDB <span className="text-ink-2">ATTACH … (TYPE postgres)</span> bridges them — a
                single scan can join live drafts ⋈ master ⋈ warehouse.
              </p>
            </>
          ) : (
            <>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[14px] font-semibold text-ink">Warehouse</span>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-1 text-[12.5px] text-ink-2">
                  Reading from your warehouse — read-only.
                </div>
              </div>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[14px] font-semibold text-ink">
                    Master store
                  </span>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-1 text-[12.5px] text-ink-2">
                  Stores every table — this is what downstream models pick up.
                </div>
              </div>
              <div className="rounded-sm border border-line bg-surface-2 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-display text-[14px] font-semibold text-ink">Workspace</span>
                  <Badge tone="ok" dot>
                    connected
                  </Badge>
                </div>
                <div className="mt-1 text-[12.5px] text-ink-2">
                  Drafts, history, and your team — the collaborative layer.
                </div>
              </div>
            </>
          )}
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "180ms" }}>
        <Section
          title="Matching defaults"
          hint="How aggressively Zug Zug matches new values when a scan finds them."
        >
          <FormField label="Confidence bands">
            <ThresholdRange
              publish={prefs.publishThreshold}
              suggest={prefs.suggestThreshold}
              onChange={({ publish, suggest }) =>
                setPreferences({ ...prefs, publishThreshold: publish, suggestThreshold: suggest })
              }
            />
          </FormField>
        </Section>
      </div>

      <div className="zz-rise" style={{ animationDelay: "220ms" }}>
        <TeamSection />
      </div>
    </div>
  );
}
