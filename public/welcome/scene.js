/**
 * The constellation behind the hero.
 *
 * Real 3D — points live in a rotating volume and are projected through a
 * perspective divide, so near points are bigger, brighter and move further
 * across the screen than far ones. It is drawn on a 2D canvas rather than with
 * WebGL and a library, for three reasons: the repo has no dependencies and no
 * build step, a 2D context exists everywhere so there is no fallback to write,
 * and a few hundred glowing sprites is nowhere near the point where WebGL
 * starts to matter.
 *
 * What it is meant to say: a lot of separate people, and the lines that appear
 * between them when they are close enough to help each other.
 */
const CATEGORY_COLOURS = [
  [110, 168, 250], // help
  [110, 168, 250],
  [110, 168, 250],
  [192, 162, 234], // group
  [111, 215, 155], // social
  [111, 215, 155],
];

export function startScene(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return () => {};

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = window.matchMedia('(max-width: 700px)').matches;
  const COUNT = small ? 90 : 170;
  const LINK_DISTANCE = small ? 300 : 260;

  /** Points on a jittered spherical shell — a crowd, not a grid. */
  const nodes = [];
  for (let i = 0; i < COUNT; i += 1) {
    // Fibonacci sphere, so they spread evenly instead of clumping at the poles.
    const t = (i + 0.5) / COUNT;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const radius = 520 * (0.68 + Math.random() * 0.5);
    nodes.push({
      x: radius * Math.sin(phi) * Math.cos(theta),
      y: radius * Math.sin(phi) * Math.sin(theta) * 0.66,
      z: radius * Math.cos(phi),
      hub: false,
      colour: [214, 226, 240],
      size: 1.1 + Math.random() * 1.5,
      phase: Math.random() * Math.PI * 2,
    });
  }
  // Six brighter nodes for the six categories, spaced through the crowd.
  for (let i = 0; i < 6; i += 1) {
    const node = nodes[Math.floor((i + 0.5) * (COUNT / 6))];
    if (!node) continue;
    node.hub = true;
    node.colour = CATEGORY_COLOURS[i] ?? [110, 168, 250];
    node.size = 5.2;
  }

  // Which pairs are close enough to draw a line between. Fixed in model space,
  // so it is computed once rather than every frame.
  const links = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      if (d < LINK_DISTANCE) links.push({ a, b, strength: 1 - d / LINK_DISTANCE });
    }
  }

  let width = 0;
  let height = 0;
  let dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  // A little parallax, clamped so it never becomes a fairground ride.
  let pointerX = 0;
  let pointerY = 0;
  const onPointer = (event) => {
    pointerX = (event.clientX / window.innerWidth - 0.5) * 0.35;
    pointerY = (event.clientY / window.innerHeight - 0.5) * 0.22;
  };
  if (!still) window.addEventListener('pointermove', onPointer, { passive: true });

  const FOV = 900;
  const projected = new Array(nodes.length);
  let spin = 0;
  let raf = 0;
  let last = performance.now();

  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!still) spin += dt * 0.055;

    const sinY = Math.sin(spin + pointerX);
    const cosY = Math.cos(spin + pointerX);
    const tilt = 0.22 + pointerY;
    const sinX = Math.sin(tilt);
    const cosX = Math.cos(tilt);

    const cx = width / 2;
    const cy = height / 2;

    ctx.fillStyle = '#080D16';
    ctx.fillRect(0, 0, width, height);

    for (let i = 0; i < nodes.length; i += 1) {
      const n = nodes[i];
      // Rotate about Y, then X.
      const x1 = n.x * cosY - n.z * sinY;
      const z1 = n.x * sinY + n.z * cosY;
      const y2 = n.y * cosX - z1 * sinX;
      const z2 = n.y * sinX + z1 * cosX;
      const scale = FOV / (FOV + z2 + 620);
      projected[i] = {
        x: cx + x1 * scale,
        y: cy + y2 * scale,
        scale,
        depth: z2,
      };
    }

    // Lines first, so points sit on top of them.
    ctx.lineWidth = 1;
    for (const link of links) {
      const a = projected[nodes.indexOf(link.a)];
      const b = projected[nodes.indexOf(link.b)];
      if (!a || !b) continue;
      const near = (a.scale + b.scale) / 2;
      const alpha = link.strength * near * near * 1.15;
      if (alpha < 0.015) continue;
      ctx.strokeStyle = `rgba(132, 176, 232, ${Math.min(alpha, 0.5).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Points far-to-near, so nearer ones overlap properly.
    const order = projected
      .map((p, i) => i)
      .sort((i, j) => (projected[j]?.depth ?? 0) - (projected[i]?.depth ?? 0));

    for (const i of order) {
      const n = nodes[i];
      const p = projected[i];
      if (!p) continue;
      const twinkle = still ? 1 : 0.82 + Math.sin(now / 1400 + n.phase) * 0.18;
      const r = n.size * p.scale * 3.4 * twinkle;
      const alpha = Math.min(1, p.scale * p.scale * (n.hub ? 3.4 : 2.3)) * twinkle;
      const [cr, cg, cb] = n.colour;

      const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(r * 4, 2));
      glow.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${(alpha * 0.95).toFixed(3)})`);
      glow.addColorStop(0.32, `rgba(${cr}, ${cg}, ${cb}, ${(alpha * 0.3).toFixed(3)})`);
      glow.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(r * 4, 2), 0, Math.PI * 2);
      ctx.fill();

      // Ordinary points burn out to white; the six category hubs keep their hue,
      // because that colour is the only thing distinguishing them.
      const core = n.hub
        ? `rgba(${Math.min(cr + 40, 255)}, ${Math.min(cg + 40, 255)}, ${Math.min(cb + 40, 255)}, ${Math.min(alpha, 1).toFixed(3)})`
        : `rgba(255, 255, 255, ${Math.min(alpha * 0.82, 1).toFixed(3)})`;
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(r, 0.5), 0, Math.PI * 2);
      ctx.fill();
    }

    raf = window.requestAnimationFrame(frame);
  }

  raf = window.requestAnimationFrame(frame);

  // Nothing to draw for a tab nobody is looking at.
  const onVisibility = () => {
    if (document.hidden) {
      window.cancelAnimationFrame(raf);
    } else {
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
