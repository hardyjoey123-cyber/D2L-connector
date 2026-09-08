/**
 * The reactor: concentric HUD rings around a radial waveform whose radius is
 * driven by `signal.bands`. Every ring reads the same signal, so listening,
 * thinking and speaking each produce a visibly different machine rather than
 * the same animation in a different color.
 */

import { BANDS } from "./signal.js";

const TICKS = BANDS;
const ORBIT_DOTS = 3;

const hsla = (h, s, l, a) => `hsla(${h}, ${s}%, ${l}%, ${a})`;

export function createReactor(canvas, signal, { reducedMotion = false } = {}) {
  const ctx = canvas.getContext("2d", { alpha: true });
  // Rotation is what sells "alive"; with reduced motion it becomes a slow
  // drift instead of a stop, so the interface still reads as running.
  const spin = reducedMotion ? 0.12 : 1;
  let width = 0;
  let height = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw() {
    if (width === 0 || height === 0) return;

    const { hue, level, time, bands } = signal;
    const cx = width / 2;
    const cy = height / 2;
    const R = Math.min(width, height) / 2;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(cx, cy);

    drawAura(ctx, R, hue, level);
    if (signal.mode === "thinking") drawSweep(ctx, R, hue, time, spin);
    drawOuterRing(ctx, R, hue, time, spin, level);
    drawSegments(ctx, R, hue, time, spin, level);
    drawTicks(ctx, R, hue, time, spin, bands);
    drawWaveform(ctx, R, hue, bands, level, reducedMotion);
    drawCore(ctx, R, hue, time, level);
    drawCrosshairs(ctx, R, hue, level);

    ctx.restore();
  }

  return { resize, draw };
}

/** Soft bloom behind everything, brightening with energy. */
function drawAura(ctx, R, hue, level) {
  const gradient = ctx.createRadialGradient(0, 0, R * 0.05, 0, 0, R);
  gradient.addColorStop(0, hsla(hue, 95, 60, 0.11 + level * 0.26));
  gradient.addColorStop(0.45, hsla(hue, 92, 52, 0.05 + level * 0.11));
  gradient.addColorStop(1, hsla(hue, 90, 50, 0));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.fill();
}

/** Radar-style wedge, only while a request is in flight. */
function drawSweep(ctx, R, hue, time, spin) {
  const angle = time * 1.5 * spin;
  ctx.save();
  ctx.rotate(angle);

  if (typeof ctx.createConicGradient === "function") {
    const gradient = ctx.createConicGradient(0, 0, 0);
    gradient.addColorStop(0, hsla(hue, 95, 65, 0.2));
    gradient.addColorStop(0.16, hsla(hue, 95, 65, 0));
    gradient.addColorStop(1, hsla(hue, 95, 65, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.86, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = hsla(hue, 95, 65, 0.16);
    ctx.lineWidth = R * 0.34;
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.68, 0, Math.PI * 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

/** Hairline boundary plus a few dots orbiting at different rates. */
function drawOuterRing(ctx, R, hue, time, spin, level) {
  const radius = R * 0.965;
  ctx.strokeStyle = hsla(hue, 85, 68, 0.16 + level * 0.14);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  for (let i = 0; i < ORBIT_DOTS; i++) {
    const speed = 0.22 + i * 0.13;
    const angle = time * speed * spin + (i * Math.PI * 2) / ORBIT_DOTS;
    ctx.fillStyle = hsla(hue, 95, 72, 0.5 + level * 0.4);
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Four arc segments counter-rotating against the tick ring. */
function drawSegments(ctx, R, hue, time, spin, level) {
  const radius = R * 0.885;
  const count = 4;
  const sweep = Math.PI * 0.28;
  const angle = -time * 0.16 * spin;

  ctx.lineWidth = 2.5;
  ctx.lineCap = "round";
  ctx.strokeStyle = hsla(hue, 90, 66, 0.26 + level * 0.4);
  for (let i = 0; i < count; i++) {
    const start = angle + (i * Math.PI * 2) / count;
    ctx.beginPath();
    ctx.arc(0, 0, radius, start, start + sweep);
    ctx.stroke();
  }

  // A second, thinner set at a different rate keeps the ring from looking
  // like one rigid object.
  ctx.lineWidth = 1;
  ctx.strokeStyle = hsla(hue, 85, 70, 0.16 + level * 0.2);
  for (let i = 0; i < count; i++) {
    const start = -angle * 1.7 + (i * Math.PI * 2) / count + 0.6;
    ctx.beginPath();
    ctx.arc(0, 0, radius - 9, start, start + sweep * 0.55);
    ctx.stroke();
  }
}

/** Spectrum bars laid out radially — the ring that reacts most directly. */
function drawTicks(ctx, R, hue, time, spin, bands) {
  const inner = R * 0.76;
  const angle = time * 0.07 * spin;

  ctx.save();
  ctx.rotate(angle);
  ctx.lineWidth = 1.6;
  ctx.lineCap = "butt";

  for (let i = 0; i < TICKS; i++) {
    const v = bands[i];
    const theta = (i / TICKS) * Math.PI * 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const length = R * (0.018 + v * 0.085);

    ctx.strokeStyle = hsla(hue, 90, 62 + v * 26, 0.22 + v * 0.7);
    ctx.beginPath();
    ctx.moveTo(cos * inner, sin * inner);
    ctx.lineTo(cos * (inner + length), sin * (inner + length));
    ctx.stroke();
  }
  ctx.restore();
}

/** The closed polar waveform: the core of the whole visualization. */
function drawWaveform(ctx, R, hue, bands, level, reducedMotion) {
  const base = R * 0.5;
  const amp = R * (reducedMotion ? 0.13 : 0.19);
  const points = new Array(BANDS);

  for (let i = 0; i < BANDS; i++) {
    const theta = (i / BANDS) * Math.PI * 2 - Math.PI / 2;
    const radius = base + bands[i] * amp;
    points[i] = [Math.cos(theta) * radius, Math.sin(theta) * radius];
  }

  // Quadratic curves through band midpoints — smooth without the overshoot a
  // cardinal spline gives on spiky spectra.
  const path = new Path2D();
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let start = mid(points[BANDS - 1], points[0]);
  path.moveTo(start[0], start[1]);
  for (let i = 0; i < BANDS; i++) {
    const current = points[i];
    const next = points[(i + 1) % BANDS];
    const end = mid(current, next);
    path.quadraticCurveTo(current[0], current[1], end[0], end[1]);
  }
  path.closePath();

  const fill = ctx.createRadialGradient(0, 0, base * 0.3, 0, 0, base + amp);
  fill.addColorStop(0, hsla(hue, 95, 60, 0.1 + level * 0.16));
  fill.addColorStop(1, hsla(hue, 95, 60, 0));
  ctx.fillStyle = fill;
  ctx.fill(path);

  ctx.save();
  ctx.shadowBlur = 16 + level * 30;
  ctx.shadowColor = hsla(hue, 100, 60, 0.8);
  ctx.strokeStyle = hsla(hue, 100, 78, 0.72 + level * 0.28);
  ctx.lineWidth = 1.8;
  ctx.stroke(path);
  ctx.restore();

  ctx.strokeStyle = hsla(hue, 85, 70, 0.18);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.4, 0, Math.PI * 2);
  ctx.stroke();
}

/** The bright center, breathing with overall energy. */
function drawCore(ctx, R, hue, time, level) {
  const breath = 1 + Math.sin(time * 1.4) * 0.03;
  const radius = R * (0.15 + level * 0.06) * breath;

  const reach = radius * 2;
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
  gradient.addColorStop(0, hsla(hue, 100, 97, 0.9 + level * 0.1));
  gradient.addColorStop(0.22, hsla(hue, 100, 74, 0.45 + level * 0.3));
  gradient.addColorStop(1, hsla(hue, 100, 60, 0));

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, reach, 0, Math.PI * 2);
  ctx.fill();
}

/** Cardinal registration marks, like an instrument bezel. */
function drawCrosshairs(ctx, R, hue, level) {
  ctx.strokeStyle = hsla(hue, 85, 70, 0.3 + level * 0.25);
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const theta = (i * Math.PI) / 2;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    ctx.beginPath();
    ctx.moveTo(cos * R * 0.915, sin * R * 0.915);
    ctx.lineTo(cos * R * 0.955, sin * R * 0.955);
    ctx.stroke();
  }
}
