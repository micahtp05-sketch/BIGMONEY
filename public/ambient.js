/**
 * The constellation, still, inside the night header (SPEC §4.2).
 *
 * A miniature of /welcome/scene.js: the same people on the same kind of
 * Fibonacci sphere, the same three hub colours, the same warm-near / cool-far
 * depth colouring and the same ease — but it is a photograph, not a film. It
 * is drawn once, redrawn when the header resizes or the page scrolls a few
 * degrees of yaw, and otherwise left alone: at rest there are no timers, no
 * animation frames and no listeners firing. The only light that ever moves is
 * pulse(kind): one point travelling one link to a hub because somebody on
 * Commons actually spoke.
 *
 * Plain ES module. No imports, no dependencies.
 */

// Constants copied from /welcome/scene.js (CATEGORY_COLOURS, NEAR, FAR, ease)
// so the two skies cannot drift apart; scene.js itself is untouched.
export const HUBS = { help: [150, 200, 255], group: [208, 176, 246], social: [126, 228, 172] };
export const NEAR = [255, 247, 232];
const FAR = [128, 158, 205];
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2); // easeInOutQuad, as scene.js
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [
  Math.round(lerp(a[0], b[0], t)),
  Math.round(lerp(a[1], b[1], t)),
  Math.round(lerp(a[2], b[2], t)),
];

const NIGHT = '#080D16';
export const ZONE = 0.12;                    // alpha multiplier under any header text box (see test/contrast.test.ts)
export const CAP = { link: 0.22, halo: 0.30, core: 0.60, hubCore: 0.85 };
const ZONE_PAD = 6;                   // px around every '.top-in > *' box for dimming
const SIGNAL_PAD = 12;                // px around every box a travelling point must stay out of
const FOV = 900;
const TILT = 0.2;
const YAW_REST = 0.6;
const YAW_PER_PX = 0.0004;            // radians per scrolled pixel (≈ 23° over 1000 px)
const DPR_CAP = 1.5;
const MIN_DRAW_GAP = 33;              // ms between scroll-driven draws
const SEED = 20260905;
const SIGNAL_MS = 900;
const SWELL_UP_MS = 200;
const SWELL_DOWN_MS = 400;
const SWELL_PEAK = 1.6;
const MAX_SIGNALS = 3;

const NOOP = { pulse() {}, redraw() {}, stop() {}, stats: () => ({ draws: 0, pulses: 0 }) };

export function startAmbient(canvas) {
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d', { alpha: false }) : null;
  if (!ctx) return NOOP;

  const header = canvas.parentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

  let draws = 0;
  let pulses = 0;

  // ------------------------------------------------------------------ people

  let width = 0;
  let height = 0;
  let N = 0;
  let R = 0;
  let nodes = [];
  let links = [];
  const hubIndex = { help: -1, group: -1, social: -1 };
  let projected = [];

  function build() {
    // A live light indexes nodes that are about to be replaced; drop it first
    // or a resize mid-pulse throws inside the next frame.
    cancelLoop();
    // Re-seeded on every build, so a given header width always draws the same sky.
    const rnd = mulberry32(SEED);
    // Stretch the band to the header's width, not the hero's globe: the sky is
    // the frame, and density costs nothing because contrast is bounded by
    // CAP × ZONE, not by how many points there are.
    const stretch = width >= 900 ? 2.1 : 1.6;
    const linkDistance = 0.36 * R;
    nodes = [];
    for (let i = 0; i < N; i += 1) {
      const t = (i + 0.5) / N;
      const phi = Math.acos(1 - 2 * t);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const radius = R * (0.66 + rnd() * 0.5);
      nodes.push({
        bx: radius * Math.sin(phi) * Math.cos(theta) * stretch,
        by: radius * Math.sin(phi) * Math.sin(theta) * 0.14, // a band, not a globe
        bz: radius * Math.cos(phi),
        hub: false,
        kind: null,
        colour: null,
        size: 0.9 + rnd() * 1.2,
      });
    }
    for (const [kind, at] of [['help', 0.17], ['group', 0.5], ['social', 0.83]]) {
      const index = Math.floor(N * at);
      const node = nodes[index];
      hubIndex[kind] = node ? index : -1;
      if (!node) continue;
      node.hub = true;
      node.kind = kind;
      node.colour = HUBS[kind];
      node.size = 4.2;
    }
    links = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        const d = Math.hypot(a.bx - b.bx, a.by - b.by, a.bz - b.bz);
        if (d < linkDistance) links.push({ i, j, strength: 1 - d / linkDistance });
      }
    }
    projected = new Array(nodes.length);
  }

  // ---------------------------------------------------------------- viewport

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = width >= 900 ? 84 : width >= 560 ? 60 : 36;
    const r = Math.min(640, Math.max(260, width * 0.42));
    if (n !== N || r !== R) { N = n; R = r; build(); }
    draw(performance.now());
  }

  // -------------------------------------------------------------- projection

  function project() {
    const yaw = YAW_REST + (window.scrollY || 0) * YAW_PER_PX;
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    const sinX = Math.sin(TILT);
    const cosX = Math.cos(TILT);
    const cx = width / 2;
    const cy = height * 0.5;
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      const x1 = n.bx * cosY - n.bz * sinY;
      const z1 = n.bx * sinY + n.bz * cosY;
      const y2 = n.by * cosX - z1 * sinX;
      const z2 = n.by * sinX + z1 * cosX;
      const scale = FOV / (FOV + z2 + 620);
      let y = cy + y2 * scale;
      if (n.hub) y = Math.min(Math.max(y, height * 0.22), height * 0.78);
      projected[i] = { x: cx + x1 * scale, y, scale, depth: z2 };
    }
  }

  // ------------------------------------------------------------------- zones

  /** Bounding boxes of everything in the header's text row, in canvas space. */
  function zones(pad) {
    const out = [];
    if (!header || typeof header.querySelectorAll !== 'function') return out;
    const c = canvas.getBoundingClientRect();
    for (const box of header.querySelectorAll('.top-in > *')) {
      const r = box.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({
        l: r.left - c.left - pad,
        t: r.top - c.top - pad,
        r: r.right - c.left + pad,
        b: r.bottom - c.top + pad,
      });
    }
    return out;
  }
  const inside = (x, y, z) => x >= z.l && x <= z.r && y >= z.t && y <= z.b;
  const zoneFactor = (x, y, zs) => {
    for (const z of zs) if (inside(x, y, z)) return ZONE;
    return 1;
  };
  const clear = (x, y, zs) => {
    for (const z of zs) if (inside(x, y, z)) return false;
    return true;
  };

  // ----------------------------------------------------------------- signals

  const signals = [];   // { link, from, to, started }
  const swells = [];    // { hub, started }
  const pick = mulberry32(SEED ^ 0x5bd1e995); // which eligible link a pulse takes: seeded, so screenshots are stable

  function swellOf(index, now) {
    let f = 1;
    for (const s of swells) {
      if (s.hub !== index) continue;
      const t = now - s.started;
      if (t < SWELL_UP_MS) f = Math.max(f, 1 + (SWELL_PEAK - 1) * ease(t / SWELL_UP_MS));
      else if (t < SWELL_UP_MS + SWELL_DOWN_MS) f = Math.max(f, SWELL_PEAK - (SWELL_PEAK - 1) * ease((t - SWELL_UP_MS) / SWELL_DOWN_MS));
    }
    return f;
  }

  // ------------------------------------------------------------------- frame

  const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a.toFixed(3)})`;

  function draw(now) {
    draws += 1;
    if (width === 0 || height === 0) return;
    ctx.fillStyle = NIGHT;
    ctx.fillRect(0, 0, width, height);
    if (nodes.length === 0) return;

    project();
    const zs = zones(ZONE_PAD);
    const factor = projected.map((p) => zoneFactor(p.x, p.y, zs));

    // ---- the lines
    ctx.lineWidth = 1;
    for (const link of links) {
      const a = projected[link.i];
      const b = projected[link.j];
      const near = (a.scale + b.scale) / 2;
      const alpha = Math.min(link.strength * near, CAP.link) * Math.min(factor[link.i], factor[link.j]);
      if (alpha < 0.005) continue;
      ctx.strokeStyle = rgba([140, 180, 235], alpha);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // ---- the people, far to near so nearer ones sit on top
    const order = projected.map((_, i) => i).sort((i, j) => projected[j].depth - projected[i].depth);
    for (const i of order) {
      const n = nodes[i];
      const p = projected[i];
      const zone = factor[i];
      const r = n.size * p.scale * 2.6;
      const alpha = Math.min(1, p.scale * p.scale * (n.hub ? 3.4 : 2.4));

      // Depth as colour: warm when close, cool when far (scene.js).
      const warmth = Math.max(0, Math.min(1, (p.scale - 0.45) / 0.5));
      const base = n.hub ? n.colour : mix(FAR, NEAR, warmth);

      const haloPeak = (n.hub ? CAP.halo : Math.min(alpha * 0.95, CAP.halo)) * zone;
      const haloRadius = Math.min(Math.max(r * (n.hub ? 5.5 * swellOf(i, now) : 4), 2), height * 0.42);
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, haloRadius);
      glow.addColorStop(0, rgba(base, haloPeak));
      glow.addColorStop(0.3, rgba(base, haloPeak * 0.32));
      glow.addColorStop(1, rgba(base, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, haloRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = n.hub
        ? rgba([Math.min(base[0] + 45, 255), Math.min(base[1] + 45, 255), Math.min(base[2] + 45, 255)], CAP.hubCore * zone)
        : rgba([255, 255, 255], Math.min(alpha * 0.85, CAP.core) * zone);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(r, 0.6), 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- live signals: one person reaching a hub
    for (const sig of signals) {
      const p = Math.min(1, (now - sig.started) / SIGNAL_MS);
      const a = projected[sig.from];
      const b = projected[sig.to];
      const e = ease(p);
      const x = lerp(a.x, b.x, e);
      const y = lerp(a.y, b.y, e);
      const depthScale = lerp(a.scale, b.scale, e);
      const fade = Math.sin(p * Math.PI); // in, bright in the middle, out
      const r = 2.6 * depthScale * (0.8 + fade * 0.6);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
      glow.addColorStop(0, rgba(NEAR, 0.9 * fade));
      glow.addColorStop(0.3, rgba([220, 235, 255], 0.35 * fade));
      glow.addColorStop(1, rgba([220, 235, 255], 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // -------------------------------------------------------------- pulse loop

  let loopRaf = 0;

  function step(now) {
    loopRaf = 0;
    // Retire finished signals; each one hands its light to the hub as a swell.
    for (let s = signals.length - 1; s >= 0; s -= 1) {
      if (now - signals[s].started >= SIGNAL_MS) {
        swells.push({ hub: signals[s].to, started: now });
        signals.splice(s, 1);
      }
    }
    for (let s = swells.length - 1; s >= 0; s -= 1) {
      if (now - swells[s].started >= SWELL_UP_MS + SWELL_DOWN_MS) swells.splice(s, 1);
    }
    draw(now);
    if (signals.length || swells.length) loopRaf = window.requestAnimationFrame(step);
  }

  function runLoop() {
    if (!loopRaf) loopRaf = window.requestAnimationFrame(step);
  }

  /** Cancel the loop and drop every live light; the next draw is the rest frame. */
  function cancelLoop() {
    const wasLive = Boolean(loopRaf || signals.length || swells.length);
    if (loopRaf) window.cancelAnimationFrame(loopRaf);
    loopRaf = 0;
    signals.length = 0;
    swells.length = 0;
    return wasLive;
  }

  function pulse(kind) {
    if (reduced.matches || document.hidden || signals.length >= MAX_SIGNALS) return;
    const hub = hubIndex[kind];
    if (hub === undefined || hub < 0 || width === 0 || height === 0) return;
    project();
    const zs = zones(SIGNAL_PAD);
    // A link is eligible when it touches the hub and neither projected end sits
    // under a header text box (padded 12 px), so the point never crosses a word.
    const eligible = links.filter((l) => {
      if (l.i !== hub && l.j !== hub) return false;
      const a = projected[l.i];
      const b = projected[l.j];
      return clear(a.x, a.y, zs) && clear(b.x, b.y, zs);
    });
    if (eligible.length === 0) return; // the rule and the rail carry the event instead
    // SPEC §4.2 asks for a strong link (strength > 0.5). At N = 60 on this band the
    // hubs have no strong links at all, so that rule alone would never let a pulse
    // fire; when it yields nothing, fall back to the strongest link the hub has.
    const strong = eligible.filter((l) => l.strength > 0.5);
    const link = strong.length
      ? strong[Math.floor(pick() * strong.length)]
      : eligible.reduce((best, l) => (l.strength > best.strength ? l : best));
    const from = link.i === hub ? link.j : link.i;
    signals.push({ link, from, to: hub, started: performance.now() });
    pulses += 1;
    runLoop();
  }

  // -------------------------------------------------------- scroll → redraw

  let scrollRaf = 0;
  let lastDraw = -Infinity;
  function scheduleDraw() {
    if (scrollRaf) return;
    scrollRaf = window.requestAnimationFrame((now) => {
      scrollRaf = 0;
      if (now - lastDraw < MIN_DRAW_GAP) { scheduleDraw(); return; } // wait for the next frame, no timer
      lastDraw = now;
      if (!loopRaf) draw(now);   // a running pulse loop is already drawing
    });
  }
  const onScroll = () => scheduleDraw();

  let scrolling = false;
  function applyMotion() {
    if (reduced.matches) {
      if (scrolling) { window.removeEventListener('scroll', onScroll); scrolling = false; }
      if (scrollRaf) { window.cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
      if (cancelLoop()) draw(performance.now()); // settle on the still frame
    } else if (!scrolling) {
      window.addEventListener('scroll', onScroll, { passive: true });
      scrolling = true;
    }
  }

  let pendingRest = false;   // a loop was cancelled while hidden; draw the rest frame on return
  const onVisibility = () => {
    if (document.hidden) { if (cancelLoop()) pendingRest = true; }
    else if (pendingRest) { pendingRest = false; draw(performance.now()); }
  };

  // ------------------------------------------------------------------- wire

  let observer = null;
  if (typeof ResizeObserver === 'function' && header) {
    observer = new ResizeObserver(() => resize());
    observer.observe(header);
  } else {
    window.addEventListener('resize', resize);
  }
  if (typeof reduced.addEventListener === 'function') reduced.addEventListener('change', applyMotion);
  else if (typeof reduced.addListener === 'function') reduced.addListener(applyMotion);
  document.addEventListener('visibilitychange', onVisibility);

  applyMotion();
  resize();

  function stop() {
    cancelLoop();
    if (scrollRaf) { window.cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    if (observer) observer.disconnect();
    else window.removeEventListener('resize', resize);
    if (scrolling) { window.removeEventListener('scroll', onScroll); scrolling = false; }
    if (typeof reduced.removeEventListener === 'function') reduced.removeEventListener('change', applyMotion);
    else if (typeof reduced.removeListener === 'function') reduced.removeListener(applyMotion);
    document.removeEventListener('visibilitychange', onVisibility);
  }

  return {
    pulse,
    redraw: () => draw(performance.now()),
    stop,
    stats: () => ({ draws, pulses }),
  };
}

function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
