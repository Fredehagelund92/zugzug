import { Link } from "react-router-dom";
import { Button } from "../components/Button";
import { Mark } from "../components/Mark";
import { Badge } from "../components/Badge";
import { ThemeToggle } from "../components/ThemeToggle";
import { cx } from "../lib/cx";

/* Showcase (/design) — the design-system surface that proves the brand is wired
   through: tokens → Tailwind utilities → components, with live theme + accent
   switching. Every colour/type/radius below is a token-backed utility (no hex). */

const swatches: { label: string; cls: string; border?: boolean }[] = [
  { label: "--accent", cls: "bg-accent" },
  { label: "--accent-2", cls: "bg-accent-2" },
  { label: "--accent-soft", cls: "bg-accent-soft" },
  { label: "--bg", cls: "bg-bg", border: true },
  { label: "--surface", cls: "bg-surface", border: true },
  { label: "--surface-2", cls: "bg-surface-2", border: true },
  { label: "--surface-3", cls: "bg-surface-3", border: true },
  { label: "--ink", cls: "bg-ink" },
  { label: "--ink-2", cls: "bg-ink-2" },
  { label: "--ink-3", cls: "bg-ink-3" },
  { label: "--ok", cls: "bg-ok" },
  { label: "--warn", cls: "bg-warn" },
  { label: "--danger", cls: "bg-danger" },
];

function Section({
  title,
  hint,
  delay,
  children,
}: {
  title: string;
  hint?: string;
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <section className="zz-rise space-y-6" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-baseline gap-3">
        <span className="h-2.5 w-2.5 rounded-sm bg-accent" />
        <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">{title}</h2>
        {hint && <span className="font-mono text-xs text-accent">/ {hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function Showcase() {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-50 flex items-center justify-between border-b border-line bg-[var(--ak-glass)] px-6 py-3.5 backdrop-blur-md">
        <Link
          to="/app"
          className="flex items-center gap-2.5 font-display text-base font-extrabold tracking-tight text-ink"
        >
          <Mark className="h-6 w-6" />
          Zug Zug<span className="text-accent">.</span>
        </Link>
        <ThemeToggle />
      </header>

      <div className="zz-canvas">
        <main className="mx-auto max-w-[var(--maxw)] space-y-16 px-8 py-16">
          <div className="zz-rise space-y-5">
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-3">
              <span className="text-accent">[ </span>design system · live
              <span className="text-accent"> ]</span>
            </div>
            <h1 className="font-display text-[clamp(40px,8vw,84px)] font-extrabold leading-[0.9] tracking-[-0.04em] text-ink">
              One table to trust<span className="text-accent">.</span>
            </h1>
            <p className="max-w-[52ch] text-lg text-ink-2">
              The Zug Zug component layer, assembled in Tailwind from the brand tokens. Switch the
              accent or theme above — every component recolors from a single token, never a
              hardcoded value.
            </p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Link to="/app">
                <Button>Open the app</Button>
              </Link>
              <Button variant="secondary">Browse tables</Button>
              <Button variant="ghost">View docs →</Button>
            </div>
          </div>

          <Section
            title="Color tokens"
            hint="accent fixed to brand · BrandApp.setAccent() in console"
            delay={150}
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
              {swatches.map((s) => (
                <div key={s.label}>
                  <div
                    className={cx(
                      "h-16 rounded-md border",
                      s.border ? "border-line-2" : "border-line",
                      s.cls,
                    )}
                  />
                  <div className="mt-2 font-mono text-xs text-ink-3">{s.label}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Typography" hint="Bricolage · Hanken · JetBrains" delay={210}>
            <div className="space-y-5 rounded-lg border border-line bg-surface p-8">
              <p className="font-display text-[64px] font-extrabold leading-none tracking-[-0.04em] text-ink">
                Aa
              </p>
              <p className="font-display text-3xl font-medium tracking-tight text-ink-2">
                The quick brown fox maps over the lazy dog
              </p>
              <p className="max-w-[60ch] text-base text-ink-2">
                Body copy is set in Hanken Grotesk at a comfortable measure. Headlines use Bricolage
                Grotesque; anything tabular uses JetBrains Mono so columns line up and data stays
                honest.
              </p>
              <p className="font-mono text-sm text-ink-3">
                dim_customer · 1.24M rows · 98.7% mapped · 28 cols
              </p>
            </div>
          </Section>

          <Section title="Buttons" hint="kit → tailwind" delay={270}>
            <div className="space-y-4 rounded-lg border border-line bg-surface p-8">
              {(["primary", "secondary", "ghost", "danger"] as const).map((v) => (
                <div key={v} className="flex flex-wrap items-center gap-3">
                  <span className="w-20 font-mono text-[11px] uppercase tracking-wider text-ink-3">
                    {v}
                  </span>
                  <Button variant={v} size="lg">
                    Action
                  </Button>
                  <Button variant={v}>Action</Button>
                  <Button variant={v} size="sm">
                    Action
                  </Button>
                  <Button variant={v} disabled>
                    Disabled
                  </Button>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Badges" hint="status" delay={330}>
            <div className="flex flex-wrap gap-3 rounded-lg border border-line bg-surface p-8">
              <Badge tone="accent">Pro</Badge>
              <Badge tone="ok" dot>
                Mapped
              </Badge>
              <Badge tone="warn" dot>
                Review
              </Badge>
              <Badge tone="danger" dot>
                Unmapped
              </Badge>
              <Badge>neutral</Badge>
            </div>
          </Section>
        </main>
      </div>
    </div>
  );
}
