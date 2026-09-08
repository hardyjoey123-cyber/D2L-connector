/**
 * Backdrop: two grid layers drifting at different speeds plus slow-rising
 * motes. Everything here is deliberately near the threshold of visibility —
 * it should register as depth, not as content competing with the reactor.
 */

const MOTE_DENSITY = 1 / 26000; // motes per CSS pixel of viewport area
const MAX_MOTES = 110;

const hsla = (h, s, l, a) => `hsla(${h}, ${s}%, ${l}%, ${a})`;

export function createAmbient(canvas, signal, { reducedMotion = false } = {}) {
  const ctx = canvas.getContext("2d", { alpha: true });
  const drift = reducedMotion ? 0.15 : 1;
  let width = 0;
  let height = 0;
  let motes = [];
  const parallax = { x: 0, y: 0, targetX: 0, targetY: 0 };

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, window.innerWidth);
    height = Math.max(1, window.innerHeight);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seedMotes();
  }

  function seedMotes() {
    const count = Math.min(MAX_MOTES, Math.round(width * height * MOTE_DENSITY));
    motes = Array.from({ length: count }, () => spawnMote(width, height, true));
  }

  if (!reducedMotion) {
    window.addEventListener(
      "pointermove",
      (event) => {
        parallax.targetX = (event.clientX / width - 0.5) * 18;
        parallax.targetY = (event.clientY / height - 0.5) * 12;
      },
      { passive: true }
    );
  }

  function draw(dt) {
    if (width === 0 || height === 0) return;
    const { hue, level, time } = signal;

    ctx.clearRect(0, 0, width, height);

    parallax.x += (parallax.targetX - parallax.x) * Math.min(1, dt * 2.2);
    parallax.y += (parallax.targetY - parallax.y) * Math.min(1, dt * 2.2);

    // Coarse layer drifts one way, fine layer the other — the shear is what
    // makes a flat grid read as two planes.
    drawGrid(ctx, width, height, {
      cell: 132,
      hue,
      alpha: 0.06 + level * 0.05,
      offsetX: (time * 5 * drift) % 132 + parallax.x,
      offsetY: (-time * 3 * drift) % 132 + parallax.y,
    });
    drawGrid(ctx, width, height, {
      cell: 33,
      hue,
      alpha: 0.022 + level * 0.02,
      offsetX: (-time * 2.2 * drift) % 33 - parallax.x * 0.4,
      offsetY: (time * 1.4 * drift) % 33 - parallax.y * 0.4,
    });

    for (const mote of motes) {
      mote.y -= mote.speed * dt * drift * 60;
      mote.phase += dt * mote.wobble;
      if (mote.y < -12) Object.assign(mote, spawnMote(width, height, false));

      const x = mote.x + Math.sin(mote.phase) * mote.sway + parallax.x * mote.depth;
      const y = mote.y + parallax.y * mote.depth;
      const twinkle = 0.65 + Math.sin(mote.phase * 1.7) * 0.35;

      ctx.fillStyle = hsla(hue, 90, 76, mote.alpha * twinkle * (0.7 + level * 0.6));
      ctx.beginPath();
      ctx.arc(x, y, mote.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { resize, draw };
}

function drawGrid(ctx, width, height, { cell, hue, alpha, offsetX, offsetY }) {
  ctx.strokeStyle = hsla(hue, 85, 60, alpha);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = offsetX % cell; x < width; x += cell) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
  }
  for (let y = offsetY % cell; y < height; y += cell) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
  }
  ctx.stroke();
}

function spawnMote(width, height, scatter) {
  return {
    x: Math.random() * width,
    y: scatter ? Math.random() * height : height + Math.random() * 40,
    size: 0.5 + Math.random() * 1.3,
    speed: 0.12 + Math.random() * 0.35,
    sway: 6 + Math.random() * 26,
    wobble: 0.15 + Math.random() * 0.4,
    phase: Math.random() * Math.PI * 2,
    alpha: 0.12 + Math.random() * 0.35,
    depth: 0.3 + Math.random() * 0.9,
  };
}
