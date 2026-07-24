/* BrandCover — the brand-ink left panel of the auth split shell.
   Ported from docs/ui-demos/01-login.html (.cover section).
   Holds across themes: --brand-ink ground, junction lattice pseudo-elements,
   accent-glow, and the source→record convergence motif. See DESIGN.md §3. */

export function BrandCover() {
  return (
    <>
      <style>{`
        .brand-cover {
          position: relative;
          background: var(--brand-ink);
          color: #eaeef7;
          padding: 64px 48px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          overflow: hidden;
        }
        /* signature junction lattice, light on the dark cover */
        .brand-cover::before {
          content: "";
          position: absolute; inset: 0; z-index: 0; pointer-events: none;
          background-image:
            radial-gradient(circle at center, rgba(255,255,255,0.06) 1.4px, transparent 1.6px),
            linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px);
          background-size: 74px 74px;
          mask-image: radial-gradient(120% 120% at 30% 20%, #000 40%, transparent 100%);
        }
        /* warm source-lamp glow bleeding from the convergence node */
        .brand-cover::after {
          content: "";
          position: absolute; z-index: 0; pointer-events: none;
          width: 420px; height: 420px; right: -120px; bottom: -140px;
          background: radial-gradient(circle, color-mix(in srgb, var(--accent) 42%, transparent), transparent 62%);
          filter: blur(8px);
        }
        .brand-cover > * { position: relative; z-index: 1; }

        .brand-cover-mark {
          display: flex; align-items: center; gap: 10px;
          font-family: var(--font-display);
          font-weight: 800; font-size: 18px; letter-spacing: -0.02em;
        }
        .brand-cover-mark .glyph {
          width: 28px; height: 28px; display: grid; place-items: center;
          background: var(--accent); color: #fff; font-weight: 800; flex: none;
        }

        /* Bound the block for a tidy measure — in rem, NOT ch: a ch max-width
           resolves against this div's inherited 15px body font (~168px), which
           would crush the 58px display headline into a word-per-line stack.
           The headline breaks via its own <br>; the sub keeps its own ch cap. */
        .brand-cover-lead { max-width: 30rem; }
        .brand-cover-kick {
          font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.22em;
          text-transform: uppercase; color: rgba(234,238,247,0.5);
        }
        .brand-cover-kick b { color: var(--accent); font-weight: 500; }
        .brand-cover-h1 {
          font-family: var(--font-display); font-weight: 800;
          font-size: clamp(38px, 4.6vw, 60px); line-height: 0.94; letter-spacing: -0.035em;
          margin: 18px 0 16px; color: #f4f6fc;
        }
        .brand-cover-h1 .dot { color: var(--accent); }
        .brand-cover-sub { color: rgba(234,238,247,0.66); font-size: 15px; max-width: 34ch; }

        .brand-cover-converge { margin-top: 32px; }
        .brand-cover-converge svg { width: 100%; max-width: 360px; height: auto; display: block; }

        .brand-cover-foot {
          display: flex; flex-wrap: wrap; gap: 12px 24px; color: rgba(234,238,247,0.55); font-size: 12px;
        }
        .brand-cover-foot b { color: #eaeef7; font-family: var(--font-mono); font-weight: 500; }

        /* The split shell collapses to a single column below the md breakpoint
           (see AuthLayout). Hide the cover there so the form stands alone and
           the cover's footer row can never force horizontal overflow on a
           phone. Matches docs/ui-demos/01-login.html, which hides .cover small. */
        @media (max-width: 767px) {
          .brand-cover { display: none; }
        }
      `}</style>

      <section className="brand-cover">
        <div className="brand-cover-mark">
          <span className="glyph">Z</span>
          Zug Zug<span style={{ color: "var(--accent)" }}>.</span>
        </div>

        <div className="brand-cover-lead">
          <div className="brand-cover-kick">
            <b>[</b> reference tables <b>]</b>
          </div>
          <h1 className="brand-cover-h1">
            One table
            <br />
            to trust<span className="dot">.</span>
          </h1>
          <p className="brand-cover-sub">
            Turn scattered source values into one approved record your whole warehouse can join.
          </p>

          <div className="brand-cover-converge" aria-hidden="true">
            <svg viewBox="0 0 360 150" fill="none">
              {/* source values on the left */}
              <g
                style={{ fontFamily: "var(--font-mono)" }}
                fontSize="10"
                fill="rgba(234,238,247,0.5)"
              >
                <text x="0" y="24">
                  &quot;USA&quot;
                </text>
                <text x="0" y="52">
                  &quot;U.S.&quot;
                </text>
                <text x="0" y="80">
                  &quot;United States&quot;
                </text>
                <text x="0" y="108">
                  &quot;us&quot;
                </text>
                <text x="0" y="136">
                  &quot;america&quot;
                </text>
              </g>
              {/* connectors converging to the node */}
              <g stroke="rgba(255,255,255,0.16)" strokeWidth="1">
                <path d="M96 20 C 180 20, 200 71, 268 75" />
                <path d="M96 48 C 180 48, 210 71, 268 75" />
                <path d="M120 76 C 190 76, 210 75, 268 75" />
                <path d="M78 104 C 180 104, 210 79, 268 75" />
                <path d="M96 132 C 180 132, 200 79, 268 75" />
              </g>
              {/* animated flow accent on one path */}
              <path d="M120 76 C 190 76, 210 75, 268 75" stroke="var(--accent)" strokeWidth="1.5" />
              {/* source dots */}
              <g fill="var(--accent-2)">
                <circle cx="96" cy="20" r="2.5" />
                <circle cx="96" cy="48" r="2.5" />
                <circle cx="120" cy="76" r="2.5" />
                <circle cx="78" cy="104" r="2.5" />
                <circle cx="96" cy="132" r="2.5" />
              </g>
              {/* the record record node */}
              <circle cx="272" cy="75" r="15" fill="var(--accent)" />
              <circle
                cx="272"
                cy="75"
                r="24"
                stroke="var(--accent)"
                strokeOpacity="0.35"
                strokeWidth="1"
              />
              <text
                x="300"
                y="72"
                style={{ fontFamily: "var(--font-mono)" }}
                fontSize="10"
                fill="#f4f6fc"
              >
                United
              </text>
              <text
                x="300"
                y="86"
                style={{ fontFamily: "var(--font-mono)" }}
                fontSize="10"
                fill="#f4f6fc"
              >
                States
              </text>
            </svg>
          </div>
        </div>

        <div className="brand-cover-foot">
          <span>
            <b>1.24M</b> rows mapped
          </span>
          <span>
            <b>98.7%</b> coverage
          </span>
          <span>
            <b>v18</b> published today
          </span>
        </div>
      </section>
    </>
  );
}
