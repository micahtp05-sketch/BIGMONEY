/**
 * The constellation behind the hero.
 *
 * A crowd of people, and the lines that appear between them when one of them
 * needs a hand. Real 3D — points live in a rotating volume and are projected
 * through a perspective divide — drawn on a 2D canvas because a few hundred
 * glowing sprites is nowhere near where WebGL starts to matter, and a 2D
 * context exists everywhere so there is no fallback to write.
 *
 * What makes it feel alive rather than mechanical:
 *   - nobody stands still: each point drifts on its own slow, layered sines,
 *     so the whole cloud breathes instead of turning like a globe
 *   - the camera eases toward the pointer rather than snapping to it, and its
 *     tilt wanders on a slow sine of its own
 *   - depth is colour as well as size: near points are warm, far ones cool
 *   - a faint current runs along the stronger connections
 *   - every so often a bright point travels one link, one person to another —
 *     which is the whole idea, drawn
 */

const CATEGORY_COLOURS = [
  [150, 200, 255], // help — lighter than the sky, or it disappears into it
  [150, 200, 255],
  [150, 200, 255],
  [208, 176, 246], // group
  [126, 228, 172], // social
  [126, 228, 172],
];

const NEAR = [255, 247, 232];
const FAR = [128, 158, 205];

const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [
  Math.round(lerp(a[0], b[0], t)),
  Math.round(lerp(a[1], b[1], t)),
  Math.round(lerp(a[2], b[2], t)),
];

export function startScene(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return () => {};

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = window.matchMedia('(max-width: 700px)').matches;
  const COUNT = small ? 110 : 200;
  const LINK_DISTANCE = small ? 310 : 250;
  const RADIUS = small ? 420 : 520;

  // ----------------------------------------------------------------- people

  const nodes = [];
  for (let i = 0; i < COUNT; i += 1) {
    // Fibonacci sphere, so they spread evenly instead of clumping at the poles.
    const t = (i + 0.5) / COUNT;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const radius = RADIUS * (0.66 + Math.random() * 0.5);
    nodes.push({
      // Rest position. The live position is this plus a drift, every frame.
      bx: radius * Math.sin(phi) * Math.cos(theta),
      by: radius * Math.sin(phi) * Math.sin(theta) * 0.7,
      bz: radius * Math.cos(phi),
      x: 0, y: 0, z: 0,
      hub: false,
      colour: null,
      size: 1.1 + Math.random() * 1.6,
      // Three phases so no two points share a rhythm on any axis.
      p1: Math.random() * Math.PI * 2,
      p2: Math.random() * Math.PI * 2,
      p3: Math.random() * Math.PI * 2,
      // How far this one wanders. A few barely move; a few roam.
      reach: 10 + Math.random() * 26,
    });
  }
  for (let i = 0; i < 6; i += 1) {
    const node = nodes[Math.floor((i + 0.5) * (COUNT / 6))];
    if (!node) continue;
    node.hub = true;
    node.colour = CATEGORY_COLOURS[i] ?? CATEGORY_COLOURS[0];
    node.size = 5.4;
    node.reach *= 0.6; // the anchors of the crowd drift less than the crowd
  }

  // Which pairs are close enough to draw a line between. Fixed in rest space
  // and computed once; the drift is small enough that neighbours stay neighbours.
  const links = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const d = Math.hypot(a.bx - b.bx, a.by - b.by, a.bz - b.bz);
      if (d < LINK_DISTANCE) links.push({ i, j, strength: 1 - d / LINK_DISTANCE });
    }
  }
  const strongLinks = links.filter((l) => l.strength > 0.5);

  // --------------------------------------------------------------- viewport

  let width = 0;
  let height = 0;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // The pointer sets a target; the camera eases toward it. Snapping to the
  // pointer is what makes a parallax feel like a fairground ride.
  let targetX = 0;
  let targetY = 0;
  let easedX = 0;
  let easedY = 0;
  const onPointer = (event) => {
    targetX = (event.clientX / window.innerWidth - 0.5) * 0.45;
    targetY = (event.clientY / window.innerHeight - 0.5) * 0.28;
  };
  if (!still) window.addEventListener('pointermove', onPointer, { passive: true });

  // ---------------------------------------------------------------- signals

  /** A bright point travelling one link. At most a handful alive at once. */
  const signals = [];
  let lastSpawn = 0;

  function spawnSignal(now) {
    if (signals.length >= 7 || strongLinks.length === 0) return;
    const link = strongLinks[Math.floor(Math.random() * strongLinks.length)];
    if (!link) return;
    signals.push({
      link,
      forward: Math.random() < 0.5,
      started: now,
      duration: 1100 + Math.random() * 900,
    });
  }

  // ------------------------------------------------------------------ frame

  const FOV = 900;
  const projected = new Array(nodes.length);
  let spin = 0;
  let raf = 0;
  let last = performance.now();
  const startedAt = last;

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const t = (now - startedAt) / 1000;

    if (!still) {
      spin += dt * 0.05;
      easedX += (targetX - easedX) * Math.min(1, dt * 2.2);
      easedY += (targetY - easedY) * Math.min(1, dt * 2.2);
    }

    // The camera's own slow wander, on top of the pointer.
    const yaw = spin + easedX + (still ? 0 : Math.sin(t * 0.11) * 0.08);
    const tilt = 0.2 + easedY + (still ? 0 : Math.sin(t * 0.09) * 0.07);
    const breathe = still ? 1 : 1 + Math.sin(t * 0.17) * 0.025;

    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    const sinX = Math.sin(tilt);
    const cosX = Math.cos(tilt);
    const cx = width / 2;
    const cy = height * 0.46;

    // ---- backdrop: a night sky with two slow, soft lights moving through it
    ctx.fillStyle = '#080D16';
    ctx.fillRect(0, 0, width, height);
    const glowA = ctx.createRadialGradient(
      cx + Math.sin(t * 0.07) * width * 0.18, cy - height * 0.2 + Math.cos(t * 0.05) * height * 0.1, 0,
      cx, cy, Math.max(width, height) * 0.7,
    );
    glowA.addColorStop(0, 'rgba(30, 58, 110, 0.55)');
    glowA.addColorStop(1, 'rgba(8, 13, 22, 0)');
    ctx.fillStyle = glowA;
    ctx.fillRect(0, 0, width, height);
    const glowB = ctx.createRadialGradient(
      cx - Math.cos(t * 0.06) * width * 0.22, cy + height * 0.25 + Math.sin(t * 0.08) * height * 0.08, 0,
      cx, cy, Math.max(width, height) * 0.6,
    );
    glowB.addColorStop(0, 'rgba(34, 78, 74, 0.32)');
    glowB.addColorStop(1, 'rgba(8, 13, 22, 0)');
    ctx.fillStyle = glowB;
    ctx.fillRect(0, 0, width, height);

    // ---- move and project every person
    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      if (still) {
        n.x = n.bx; n.y = n.by; n.z = n.bz;
      } else {
        // Layered sines at unrelated frequencies: cheap, smooth, never repeats
        // on any timescale a person would notice.
        n.x = n.bx + n.reach * Math.sin(t * 0.33 + n.p1) * Math.cos(t * 0.19 + n.p2);
        n.y = n.by + n.reach * Math.sin(t * 0.27 + n.p2) * 0.8;
        n.z = n.bz + n.reach * Math.cos(t * 0.31 + n.p3) * Math.sin(t * 0.13 + n.p1);
      }
      const x0 = n.x * breathe;
      const y0 = n.y * breathe;
      const z0 = n.z * breathe;
      const x1 = x0 * cosY - z0 * sinY;
      const z1 = x0 * sinY + z0 * cosY;
      const y2 = y0 * cosX - z1 * sinX;
      const z2 = y0 * sinX + z1 * cosX;
      const scale = FOV / (FOV + z2 + 620);
      projected[i] = { x: cx + x1 * scale, y: cy + y2 * scale, scale, depth: z2 };
    }

    // ---- the lines: faint and solid for all, plus a slow current on the strong ones
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const link of links) {
      const a = projected[link.i];
      const b = projected[link.j];
      if (!a || !b) continue;
      const near = (a.scale + b.scale) / 2;
      const alpha = link.strength * near * near * 1.05;
      if (alpha < 0.014) continue;
      ctx.strokeStyle = `rgba(140, 180, 235, ${Math.min(alpha, 0.42).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    if (!still) {
      ctx.setLineDash([3, 22]);
      ctx.lineDashOffset = -(t * 26);
      for (const link of strongLinks) {
        const a = projected[link.i];
        const b = projected[link.j];
        if (!a || !b) continue;
        const near = (a.scale + b.scale) / 2;
        const alpha = (link.strength - 0.5) * near * near * 1.6;
        if (alpha < 0.02) continue;
        ctx.strokeStyle = `rgba(200, 224, 255, ${Math.min(alpha, 0.55).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // ---- signals: one person reaching another
    if (!still) {
      if (now - lastSpawn > 650) { spawnSignal(now); lastSpawn = now; }
      for (let s = signals.length - 1; s >= 0; s -= 1) {
        const sig = signals[s];
        const p = (now - sig.started) / sig.duration;
        if (p >= 1) { signals.splice(s, 1); continue; }
        const a = projected[sig.forward ? sig.link.i : sig.link.j];
        const b = projected[sig.forward ? sig.link.j : sig.link.i];
        if (!a || !b) continue;
        const e = ease(p);
        const x = lerp(a.x, b.x, e);
        const y = lerp(a.y, b.y, e);
        const depthScale = lerp(a.scale, b.scale, e);
        const fade = Math.sin(p * Math.PI); // in, bright in the middle, out
        const r = 2.6 * depthScale * (0.8 + fade * 0.6);
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
        glow.addColorStop(0, `rgba(255, 250, 240, ${(0.9 * fade).toFixed(3)})`);
        glow.addColorStop(0.3, `rgba(220, 235, 255, ${(0.35 * fade).toFixed(3)})`);
        glow.addColorStop(1, 'rgba(220, 235, 255, 0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- the people, far to near so nearer ones sit on top
    const order = projected.map((_, i) => i)
      .sort((i, j) => (projected[j]?.depth ?? 0) - (projected[i]?.depth ?? 0));

    for (const i of order) {
      const n = nodes[i];
      const p = projected[i];
      if (!p) continue;
      const twinkle = still ? 1 : 0.84 + Math.sin(t * 1.3 + n.p3) * 0.16;
      const r = n.size * p.scale * 3.3 * twinkle;
      const alpha = Math.min(1, p.scale * p.scale * (n.hub ? 3.4 : 2.4)) * twinkle;

      // Depth as colour: warm when close, cool when far.
      const warmth = Math.max(0, Math.min(1, (p.scale - 0.45) / 0.5));
      const base = n.hub ? n.colour : mix(FAR, NEAR, warmth);
      const [cr, cg, cb] = base;

      const halo = Math.max(r * (n.hub ? 5.5 : 4), 2);
      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, halo);
      glow.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${(alpha * 0.95).toFixed(3)})`);
      glow.addColorStop(0.3, `rgba(${cr}, ${cg}, ${cb}, ${(alpha * 0.3).toFixed(3)})`);
      glow.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, halo, 0, Math.PI * 2);
      ctx.fill();

      const core = n.hub
        ? `rgba(${Math.min(cr + 45, 255)}, ${Math.min(cg + 45, 255)}, ${Math.min(cb + 45, 255)}, ${Math.min(alpha, 1).toFixed(3)})`
        : `rgba(255, 255, 255, ${Math.min(alpha * 0.85, 1).toFixed(3)})`;
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(r, 0.6), 0, Math.PI * 2);
      ctx.fill();
    }

    if (!still) raf = window.requestAnimationFrame(frame);
  }

  raf = window.requestAnimationFrame(frame);

  const onVisibility = () => {
    if (document.hidden) {
      window.cancelAnimationFrame(raf);
    } else if (!still) {
      last = performance.now();
      raf = window.requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    window.cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pointermove', onPointer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
