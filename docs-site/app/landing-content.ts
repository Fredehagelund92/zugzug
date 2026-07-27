// Auto-generated from docs/website-preview/index.html — the landing mockup.
// Rendered only on `/`, so this CSS/markup never reaches the /docs pages.
export const LANDING_CSS = `
  :root{
    --bg:#080b14; --surface:#0f1526; --surface-2:#182240; --surface-3:#243056;
    --ink:#eaeef7; --ink-2:#9ba7bf; --ink-3:#5b6884;
    --line:rgba(255,255,255,.09); --line-2:rgba(255,255,255,.16);
    --accent:#d6336c; --accent-2:#f0a323; --teal:#0e9f8a;
    --accent-soft:color-mix(in srgb, var(--accent) 16%, transparent);
    --amber-soft:color-mix(in srgb, var(--accent-2) 15%, transparent);
    --teal-soft:color-mix(in srgb, var(--teal) 15%, transparent);
    --display:var(--font-display),ui-sans-serif,sans-serif;
    --body:var(--font-body),ui-sans-serif,sans-serif;
    --mono:var(--font-mono),ui-monospace,monospace;
    --maxw:1120px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{
    background:var(--bg); color:var(--ink); font-family:var(--body);
    font-size:16px; line-height:1.65; -webkit-font-smoothing:antialiased;
    text-rendering:optimizeLegibility; overflow-x:hidden;
  }
  /* consistent, visible focus for every interactive element */
  a:focus-visible, .btn:focus-visible, .gh:focus-visible{
    outline:2px solid var(--accent); outline-offset:3px; border-radius:6px;
  }
  /* faint lattice ground */
  .lattice{
    position:fixed; inset:0; z-index:0; pointer-events:none;
    background-image:radial-gradient(circle at 1px 1px, rgba(255,255,255,.05) 1px, transparent 0);
    background-size:34px 34px;
    mask-image:radial-gradient(ellipse 80% 60% at 50% 0%, #000 30%, transparent 78%);
  }
  .glow{
    position:fixed; z-index:0; pointer-events:none; filter:blur(90px); opacity:.5;
  }
  .glow.rose{top:-160px; left:50%; transform:translateX(-50%); width:640px; height:360px;
    background:radial-gradient(circle, var(--accent) 0%, transparent 68%); opacity:.28}
  .glow.amber{top:340px; left:-120px; width:420px; height:340px;
    background:radial-gradient(circle, var(--accent-2) 0%, transparent 70%); opacity:.14}
  main,nav{position:relative; z-index:1}
  .wrap{max-width:var(--maxw); margin:0 auto; padding-inline:28px}

  /* ---------- nav ---------- */
  nav{display:flex; align-items:center; justify-content:space-between;
    height:70px; border-bottom:1px solid var(--line);
    backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px)}
  .brand{display:flex; align-items:center; gap:10px; text-decoration:none; color:var(--ink)}
  .brand .mark{width:26px; height:26px; flex:none}
  .brand .wm{font-family:var(--display); font-weight:800; letter-spacing:-.02em; font-size:19px}
  .brand .dot{color:var(--accent)}
  .navlinks{display:flex; align-items:center; gap:28px; font-size:14px}
  .navlinks a{color:var(--ink-2); text-decoration:none; transition:color .15s ease}
  .navlinks a:hover{color:var(--ink)}
  .kbd{font-family:var(--mono); font-size:12px; color:var(--ink-3);
    border:1px solid var(--line); border-radius:7px; padding:4px 9px;
    display:inline-flex; gap:6px; align-items:center}
  .gh{display:inline-flex; align-items:center; gap:8px;
    border:1px solid var(--line-2); border-radius:9px; padding:8px 14px;
    color:var(--ink)!important; font-weight:500; transition:background .15s ease, border-color .15s ease}
  .gh:hover{background:var(--surface-2); border-color:color-mix(in srgb,var(--ink-3) 60%,var(--line-2))}
  .gh .star{color:var(--accent-2)}
  a:focus-visible,.btn:focus-visible,.brand:focus-visible{outline:2px solid var(--accent);
    outline-offset:3px; border-radius:8px}

  /* ---------- eyebrow / cased mono labels ---------- */
  .eyebrow{font-family:var(--mono); font-size:12px; letter-spacing:.16em;
    text-transform:uppercase; color:var(--ink-2)}
  .eyebrow .br{color:var(--accent)}
  .sec-head .eyebrow{margin-bottom:10px}

  /* ---------- hero ---------- */
  .hero{padding-block:88px 44px}
  .hero h1{font-family:var(--display); font-weight:700; letter-spacing:-.032em;
    line-height:1.02; font-size:clamp(2.7rem,6.1vw,4.7rem); max-width:15ch; margin:26px 0 0}
  .hero h1 .em{color:var(--accent)}
  .lede{font-size:clamp(1.06rem,2.05vw,1.28rem); color:var(--ink-2);
    max-width:54ch; margin:26px 0 0; line-height:1.6}
  .lede code{font-family:var(--mono); font-size:.86em; color:var(--ink);
    background:var(--surface-2); border:1px solid var(--line); padding:1px 6px; border-radius:6px}
  .cta-row{display:flex; gap:14px; align-items:center; margin-top:36px; flex-wrap:wrap}
  .btn{font-family:var(--mono); font-size:14px; font-weight:500; text-decoration:none;
    border-radius:11px; padding:14px 19px; display:inline-flex; gap:10px; align-items:center;
    transition:transform .12s ease, background .12s ease, box-shadow .12s ease}
  .btn-primary{background:var(--accent); color:#fff;
    box-shadow:0 0 0 1px var(--accent), 0 12px 34px -12px var(--accent)}
  .btn-primary:hover{transform:translateY(-1px); box-shadow:0 0 0 1px var(--accent), 0 16px 40px -12px var(--accent)}
  .btn-primary .prompt{opacity:.72}
  .btn-ghost{color:var(--ink); border:1px solid var(--line-2)}
  .btn-ghost:hover{background:var(--surface); border-color:color-mix(in srgb,var(--ink-3) 55%,var(--line-2)); transform:translateY(-1px)}

  /* ---------- junction diagram ---------- */
  .junction{margin-top:60px; border:1px solid var(--line); border-radius:18px;
    background:linear-gradient(180deg, var(--surface) 0%, #0a0f1d 100%);
    padding:24px 26px 22px; position:relative; overflow:hidden;
    box-shadow:0 30px 80px -40px rgba(0,0,0,.9), inset 0 1px 0 rgba(255,255,255,.04)}
  .junction::before{content:""; position:absolute; inset:0;
    background-image:radial-gradient(circle at 1px 1px, rgba(255,255,255,.045) 1px, transparent 0);
    background-size:26px 26px; opacity:.5;
    mask-image:radial-gradient(120% 100% at 50% 46%, #000 55%, transparent 100%)}
  .jhead{display:flex; justify-content:space-between; align-items:center;
    position:relative; z-index:2; margin-bottom:22px}
  .jhead .t{font-family:var(--mono); font-size:11px; letter-spacing:.12em;
    text-transform:uppercase; color:var(--ink-3); display:inline-flex; align-items:center; gap:8px}
  .jhead .t .accent{color:var(--ink-2)}
  .jhead .t.live::before{content:""; width:6px; height:6px; border-radius:50%;
    background:var(--teal); box-shadow:0 0 0 3px color-mix(in srgb,var(--teal) 22%,transparent)}
  /* the three rows share one track template so columns line up exactly */
  .jrow{position:relative; z-index:2; display:grid;
    grid-template-columns:1fr 132px minmax(196px,1fr); gap:0}
  .jlabels{align-items:end; margin-bottom:12px}
  .col-label{font-family:var(--mono); font-size:10px; letter-spacing:.16em;
    text-transform:uppercase; color:var(--ink-3)}
  /* fixed 180px stage: space-between puts chip centers at 23 / 90 / 157;
     the record is align-items:center -> center 90. SVG maps 1:1 to 132x180. */
  .jstage{height:180px; align-items:center}
  .sources{height:100%; display:flex; flex-direction:column; justify-content:space-between}
  .chip{font-family:var(--mono); font-size:13px; border:1px solid var(--line);
    background:linear-gradient(180deg, var(--surface-2), color-mix(in srgb,var(--surface-2) 62%, #0a0f1d));
    border-radius:10px; padding:0 13px; height:46px; color:var(--ink);
    display:flex; justify-content:space-between; align-items:center; gap:12px; position:relative}
  .chip .v{white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .chip .n{color:var(--accent-2); font-size:11px; flex:none; opacity:.9}
  .chip.src{border-left:2px solid var(--accent-2)}
  .chip.src::after{content:""; position:absolute; right:-3.5px; top:50%; transform:translateY(-50%);
    width:6px; height:6px; border-radius:50%; background:var(--accent); z-index:3;
    box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
  .connectors{height:100%; position:relative}
  .connectors svg{display:block; width:100%; height:100%; overflow:visible}
  .wire{stroke:var(--line-2); stroke-width:1.25; fill:none}
  .flow{stroke:var(--accent); stroke-width:1.7; fill:none; stroke-linecap:round;
    stroke-dasharray:1.5 11; animation:flow 1.6s linear infinite;
    filter:drop-shadow(0 0 3px color-mix(in srgb,var(--accent) 80%,transparent))}
  @keyframes flow{to{stroke-dashoffset:-25}}
  .out{position:relative; height:100%}
  .record{position:absolute; left:0; right:0; top:50%; transform:translateY(-50%);
    border:1px solid color-mix(in srgb,var(--teal) 48%,var(--line));
    background:linear-gradient(180deg, color-mix(in srgb,var(--teal) 12%,var(--surface)), var(--surface));
    border-radius:12px; padding:0 16px; height:56px; display:flex; flex-direction:column;
    justify-content:center; gap:3px;
    box-shadow:0 0 0 1px color-mix(in srgb,var(--teal) 20%,transparent),
      0 0 30px -8px color-mix(in srgb,var(--teal) 50%,transparent),
      0 16px 40px -24px color-mix(in srgb,var(--teal) 55%,transparent)}
  .record::before{content:""; position:absolute; left:-3.5px; top:50%; transform:translateY(-50%);
    width:6px; height:6px; border-radius:50%; background:var(--teal); z-index:3;
    box-shadow:0 0 0 3px color-mix(in srgb,var(--teal) 22%,transparent)}
  .record .rk{font-family:var(--mono); font-size:10.5px; letter-spacing:.04em;
    color:color-mix(in srgb,var(--teal) 80%,var(--ink))}
  .record .rl{font-family:var(--display); font-weight:600; font-size:17px; letter-spacing:-.01em; line-height:1}
  .record .badge{position:absolute; top:50%; right:13px; transform:translateY(-50%);
    font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.08em;
    color:var(--teal); border:1px solid color-mix(in srgb,var(--teal) 40%,transparent);
    border-radius:20px; padding:3px 9px; background:color-mix(in srgb,var(--teal) 10%,transparent)}
  .tables{position:absolute; left:0; right:0; top:calc(50% + 34px); display:flex; gap:10px}
  .tbl{flex:1; font-family:var(--mono); font-size:11px; border:1px solid var(--line);
    border-radius:9px; padding:9px 11px; color:var(--ink-2); background:var(--surface); text-align:center}
  .tbl b{color:var(--accent); font-weight:600}
  .joinline{position:relative; z-index:2; margin-top:18px; font-family:var(--mono);
    font-size:12.5px; color:var(--ink-2); border-top:1px dashed var(--line);
    padding-top:15px; overflow-x:auto; white-space:nowrap}
  .joinline .kw{color:var(--accent)}
  .joinline .tb{color:var(--ink)}

  /* ---------- section frame ---------- */
  section{padding:88px 0; border-top:1px solid var(--line)}
  .sec-head{display:flex; flex-direction:column; gap:14px; margin-bottom:46px; max-width:60ch}
  .sec-head h2{font-family:var(--display); font-weight:700; letter-spacing:-.02em;
    font-size:clamp(1.7rem,3.4vw,2.5rem); line-height:1.08}
  .sec-head p{color:var(--ink-2); font-size:1.05rem}

  /* pipeline steps */
  .steps{display:grid; grid-template-columns:repeat(3,1fr); gap:14px}
  .step{background:var(--surface); border:1px solid var(--line); border-radius:14px;
    padding:24px 24px 26px; position:relative; display:flex; flex-direction:column;
    transition:border-color .16s ease, background .16s ease}
  .step:hover{border-color:var(--line-2); background:var(--surface-2)}
  .step .idx{display:inline-flex; align-items:center; gap:9px; font-family:var(--mono);
    font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3)}
  .step .idx b{display:inline-grid; place-items:center; width:24px; height:24px; flex:none;
    font-size:12px; font-weight:600; color:var(--accent); letter-spacing:0;
    border:1px solid color-mix(in srgb,var(--accent) 42%,transparent); border-radius:8px;
    background:var(--accent-soft)}
  .step h3{font-family:var(--display); font-weight:600; font-size:1.22rem; margin:16px 0 8px; letter-spacing:-.01em}
  .step p{color:var(--ink-2); font-size:.95rem; line-height:1.55}
  .step code{font-family:var(--mono); font-size:.85em; color:var(--accent)}
  .step .tag{align-self:flex-start; margin-top:auto; padding-top:18px; font-family:var(--mono);
    font-size:11px; letter-spacing:.02em; color:var(--ink-3)}
  .step .tag i{font-style:normal; color:color-mix(in srgb,var(--ink-3) 60%,transparent); padding:0 6px}
  /* flow arrows between steps */
  .step:not(:last-child)::after{content:"→"; position:absolute; z-index:3; right:-14px;
    top:50%; transform:translate(50%,-50%); width:28px; height:28px; display:grid;
    place-items:center; font-family:var(--mono); font-size:14px; color:var(--ink-3);
    background:var(--bg); border:1px solid var(--line); border-radius:50%}

  /* pillars */
  .pillars{display:grid; grid-template-columns:1fr 1fr; gap:20px}
  .pillar{--tint:var(--accent); border:1px solid var(--line); border-radius:14px; padding:28px 28px 30px;
    background:var(--surface); position:relative; overflow:hidden;
    transition:border-color .16s ease}
  .pillar:hover{border-color:var(--line-2)}
  .pillar::before{content:""; position:absolute; left:0; top:0; bottom:0; width:2px;
    background:var(--tint); opacity:.7}
  .pillar.amber{--tint:var(--accent-2)}
  .pillar .lbl{font-family:var(--mono); font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--tint)}
  .pillar h3{font-family:var(--display); font-weight:700; font-size:1.4rem; margin:12px 0 10px; letter-spacing:-.02em}
  .pillar p{color:var(--ink-2); font-size:.98rem; line-height:1.55}
  .pillar p code{font-family:var(--mono); font-size:.85em; color:var(--tint)}
  .pillar ul{list-style:none; margin-top:20px; padding-top:18px; border-top:1px solid var(--line);
    display:flex; flex-direction:column; gap:11px}
  .pillar li{font-family:var(--mono); font-size:12.5px; color:var(--ink-2); display:flex; gap:11px; align-items:baseline}
  .pillar li::before{content:""; flex:none; width:5px; height:5px; border-radius:2px;
    background:var(--tint); transform:translateY(-2px)}

  /* closing CTA */
  .closer{text-align:center; border-top:1px solid var(--line); padding-block:96px}
  .closer .eyebrow{justify-content:center; display:block; margin-bottom:26px}
  .closer h2{font-family:var(--display); font-weight:700; letter-spacing:-.025em;
    font-size:clamp(2rem,4.5vw,3.1rem); line-height:1.05; max-width:18ch; margin:0 auto}
  .term{max-width:560px; margin:36px auto 0; text-align:left; font-family:var(--mono);
    font-size:13px; background:#0a0f1c; border:1px solid var(--line-2); border-radius:12px;
    overflow:hidden; box-shadow:0 30px 60px -30px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.02)}
  .term .bar{display:grid; grid-template-columns:1fr auto 1fr; align-items:center;
    padding:11px 14px; background:linear-gradient(180deg,#141b2e,#0e1424);
    border-bottom:1px solid var(--line)}
  .term .lights{display:flex; gap:8px}
  .term .lights i{width:12px;height:12px;border-radius:50%;display:block;
    box-shadow:inset 0 0 0 .5px rgba(0,0,0,.35), inset 0 1px 1px rgba(255,255,255,.28)}
  .term .lights i:nth-child(1){background:#ff5f57}
  .term .lights i:nth-child(2){background:#febc2e}
  .term .lights i:nth-child(3){background:#28c840}
  .term .title{grid-column:2; font-size:11px; letter-spacing:.02em; color:var(--ink-3)}
  .term .body{padding:18px 18px 20px; line-height:1.95}
  .term .p{color:var(--teal)} .term .c{color:var(--ink)} .term .o{color:var(--ink-3)}
  .term .cmd{color:var(--accent)}
  .term .cursor{display:inline-block; width:8px; height:15px; margin-left:3px;
    background:var(--accent); vertical-align:-2px; animation:blink 1.1s step-end infinite}
  @keyframes blink{50%{opacity:0}}

  footer{border-top:1px solid var(--line); padding:30px 0 56px}
  .foot{display:flex; justify-content:space-between; align-items:center; color:var(--ink-3);
    font-size:13px; flex-wrap:wrap; gap:16px}
  .foot .brandline{display:flex; align-items:center; gap:9px; font-family:var(--mono)}
  .foot .brandline .m{width:16px; height:16px; flex:none; opacity:.85}
  .foot .brandline b{color:var(--ink-2); font-weight:500}
  .foot .brandline .sep{color:color-mix(in srgb,var(--ink-3) 55%,transparent)}
  .foot nav{display:flex; gap:20px; height:auto; border:none; backdrop-filter:none; font-family:var(--mono); font-size:12.5px}
  .foot a{color:var(--ink-2); text-decoration:none; border-radius:5px}
  .foot a:hover{color:var(--ink)}
  .foot a:focus-visible{outline:2px solid var(--accent); outline-offset:3px}

  @media(max-width:820px){
    .navlinks .hide{display:none}
    /* junction stacks: chips → record → tables, in normal flow */
    .jrow{grid-template-columns:1fr; gap:16px}
    .jlabels{display:none}
    .jstage{height:auto}
    .sources{gap:12px}
    .connectors{display:none}
    .out{height:auto}
    /* full-width on mobile: size to content, keep record as the badge's positioning context */
    .record{position:relative; top:auto; transform:none; height:auto; padding-block:15px}
    .record .badge{top:15px; transform:none}
    .tables{position:static; margin-top:12px}
    .chip.src::after, .record::before{display:none}
    .joinline{white-space:normal; overflow-x:visible; line-height:1.85}
    .steps{grid-template-columns:1fr}
    .pillars{grid-template-columns:1fr}
  }
  @media(max-width:560px){
    .wrap{padding-inline:20px}
    .hero{padding-block:56px 32px}
    section{padding:68px 0}
    .closer{padding-block:72px}
    .sec-head{margin-bottom:36px}
    .junction{padding:20px 18px 18px}
    .joinline{white-space:normal; overflow-x:visible; line-height:1.9}
    .cta-row{flex-direction:column; align-items:stretch}
    .cta-row .btn{justify-content:center}
  }
  @media(prefers-reduced-motion:reduce){
    html{scroll-behavior:auto}
    .flow,.term .cursor{animation:none}
    *{transition:none!important}
  }
`;

export const LANDING_HTML = `
<div class="lattice"></div>
<div class="glow rose"></div>
<div class="glow amber"></div>

<nav class="wrap">
  <a class="brand" href="#top" aria-label="Zug Zug home">
    <svg class="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <g stroke="var(--ink)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M7 6H25"/><path d="M7 16H25"/><path d="M7 26H25"/>
      </g>
      <g stroke="var(--accent)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M25 6L7 16"/><path d="M25 16L7 26"/>
      </g>
    </svg>
    <span class="wm">Zug Zug<span class="dot">.</span></span>
  </a>
  <div class="navlinks">
    <a class="hide" href="#how">How it works</a>
    <a class="hide" href="/docs">Docs</a>
    <span class="kbd hide">⌘ K</span>
    <a class="gh" href="https://github.com/Fredehagelund92/zugzug">GitHub <span class="star">★</span> 0</a>
  </div>
</nav>

<main>
  <!-- HERO -->
  <section class="hero wrap" style="border-top:none">
    <div class="eyebrow"><span class="br">[</span> open source · next to your warehouse <span class="br">]</span></div>
    <h1>Every messy value in your warehouse, <span class="em">pinned to one record</span>.</h1>
    <p class="lede">Every warehouse fills with names nobody agrees on — <code>BCG</code>, <code>B.C.G.</code>, <code>Boston Consulting Group</code>. Zug Zug pins them to one approved record, and keeps the lists everything downstream depends on. Right next to your warehouse. One command to run.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="https://demo.zugzughq.com">Try the live demo →</a>
      <a class="btn btn-ghost" href="https://github.com/Fredehagelund92/zugzug"><span class="prompt">$</span> docker compose up</a>
    </div>

    <!-- SIGNATURE: junction diagram -->
    <div class="junction">
      <div class="jhead">
        <span class="t"><span class="accent">dim_partner</span> · junction</span>
        <span class="t live">v18 · published</span>
      </div>
      <div class="jrow jlabels">
        <span class="col-label">source values</span>
        <span></span>
        <span class="col-label">approved record</span>
      </div>
      <div class="jrow jstage">
        <div class="sources">
          <div class="chip src"><span class="v">"BCG"</span><span class="n">&times;4,102</span></div>
          <div class="chip src"><span class="v">"B.C.G."</span><span class="n">&times;880</span></div>
          <div class="chip src"><span class="v">"Boston Consulting Group"</span><span class="n">&times;213</span></div>
        </div>
        <div class="connectors" aria-hidden="true">
          <svg viewBox="0 0 132 180" preserveAspectRatio="none">
            <path class="wire" d="M0,23 C66,23 66,90 132,90"/>
            <path class="wire" d="M0,90 L132,90"/>
            <path class="wire" d="M0,157 C66,157 66,90 132,90"/>
            <path class="flow" d="M0,23 C66,23 66,90 132,90"/>
            <path class="flow" d="M0,90 L132,90" style="animation-delay:-.53s"/>
            <path class="flow" d="M0,157 C66,157 66,90 132,90" style="animation-delay:-1.06s"/>
          </svg>
        </div>
        <div class="out">
          <div class="record">
            <span class="badge">published</span>
            <div class="rk">key &middot; boston_consulting_group</div>
            <div class="rl">Boston Consulting Group</div>
          </div>
          <div class="tables">
            <div class="tbl"><b>dim_</b>partner</div>
            <div class="tbl"><b>map_</b>partner</div>
          </div>
        </div>
      </div>
      <div class="joinline"><span class="kw">left join</span> <span class="tb">map_partner</span> <span class="kw">using</span> (raw_partner_name)   <span class="kw">left join</span> <span class="tb">dim_partner</span> <span class="kw">using</span> (key)</div>
    </div>
  </section>

  <!-- HOW IT WORKS -->
  <section id="how" class="wrap">
    <div class="sec-head">
      <div class="eyebrow"><span class="br">[</span> the loop <span class="br">]</span></div>
      <h2>Read-only in. Agreed by a human. Written back to your warehouse.</h2>
      <p>One pipeline, three moves. The warehouse is never touched unless you explicitly wire a writable adapter.</p>
    </div>
    <div class="steps">
      <div class="step">
        <div class="idx"><b>1</b> warehouse column</div>
        <h3>Scan</h3>
        <p>Point Zugzug at a warehouse column with a read-only credential. It pulls the distinct values still waiting for a mapping — each with a frequency count.</p>
        <span class="tag">read-only<i>·</i>select distinct</span>
      </div>
      <div class="step">
        <div class="idx"><b>2</b> the review grid</div>
        <h3>Curate</h3>
        <p>The team maps each source value to an approved record in a spreadsheet-fast grid — bulk merge, comments, roles, and a full audit trail.</p>
        <span class="tag">drafts<i>→</i>review</span>
      </div>
      <div class="step">
        <div class="idx"><b>3</b> dim_ / map_ tables</div>
        <h3>Publish</h3>
        <p>One act folds the drafts into a numbered version and materializes <code>dim_</code> / <code>map_</code> — pulled by whatever reads your warehouse, or pushed straight in.</p>
        <span class="tag">v18<i>·</i>pull-first</span>
      </div>
    </div>
  </section>

  <!-- PILLARS -->
  <section class="wrap">
    <div class="sec-head">
      <div class="eyebrow"><span class="br">[</span> two surfaces, one grid <span class="br">]</span></div>
      <h2>Not entity resolution. Not an app builder.</h2>
      <p>Curated lists, and the mappings into them — materialized right where your warehouse can read them.</p>
    </div>
    <div class="pillars">
      <div class="pillar">
        <div class="lbl">value mapping</div>
        <h3>Reconcile the mess</h3>
        <p>Turn thousands of raw variants into one agreed key. The crosswalk lands in <code>map_partner</code> — one join and messy input resolves, wherever you already query your warehouse.</p>
        <ul>
          <li>frequency-ranked Review inbox</li>
          <li>bulk merge, skip, map-to</li>
          <li>who published what, and when</li>
        </ul>
      </div>
      <div class="pillar amber">
        <div class="lbl">reference tables</div>
        <h3>Maintain the list</h3>
        <p>The one <code>dim_country</code> or <code>dim_currency</code> list your dashboards and finance close depend on — edited in place like a spreadsheet, with owners and CSV import/export.</p>
        <ul>
          <li>typed columns, validation rules</li>
          <li>self-referencing hierarchies</li>
          <li>published v18, diffable history</li>
        </ul>
      </div>
    </div>
  </section>

  <!-- CLOSER -->
  <div class="closer wrap">
    <span class="eyebrow"><span class="br">[</span> no warehouse or account needed <span class="br">]</span></span>
    <h2>See it agree on a name in 30 seconds.</h2>
    <div class="term">
      <div class="bar">
        <div class="lights"><i></i><i></i><i></i></div>
        <span class="title">zugzug — bash</span>
      </div>
      <div class="body">
        <div><span class="o">$</span> <span class="c">git clone https://github.com/Fredehagelund92/zugzug.git</span></div>
        <div><span class="o">$</span> <span class="c">cd zugzug</span></div>
        <div><span class="o">$</span> <span class="cmd">docker compose up</span><span class="cursor"></span></div>
        <div><span class="o">#</span> <span class="p">http://localhost:8080 — first user becomes admin</span></div>
      </div>
    </div>
  </div>
</main>

<footer class="wrap">
  <div class="foot">
    <span class="brandline">
      <svg class="m" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <g stroke="var(--ink-2)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 6H25"/><path d="M7 16H25"/><path d="M7 26H25"/>
        </g>
        <g stroke="var(--accent)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M25 6L7 16"/><path d="M25 16L7 26"/>
        </g>
      </svg>
      <b>zug·zug</b><span class="sep">·</span>MIT<span class="sep">·</span>self-hosted<span class="sep">·</span>pre-1.0
    </span>
    <nav>
      <a href="/docs">Docs</a>
      <a href="https://github.com/Fredehagelund92/zugzug">GitHub</a>
      <a href="/docs/guides/deploy">Deploy</a>
    </nav>
  </div>
</footer>
`;
