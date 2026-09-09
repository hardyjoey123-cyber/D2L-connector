/**
 * The single source of animation truth.
 *
 * Both canvases read from one Signal instead of polling the DOM or the audio
 * graph themselves, so the background and the reactor always agree on what the
 * assistant is doing. `bands` is a normalized spectrum around the circle;
 * `level` is its overall energy.
 */

export const BANDS = 96;

/**
 * Hue shift per mode, relative to the user's chosen accent, kept in step with
 * the body classes in styles.css. Error is absolute: a fault has to read as a
 * fault whatever accent someone picked.
 */
export const MODES = {
  idle: { delta: 0, className: "is-idle" },
  listening: { delta: -4, className: "is-listening" },
  thinking: { delta: 15, className: "is-thinking" },
  speaking: { delta: -12, className: "is-speaking" },
  error: { absolute: 8, className: "is-error" },
};

export const DEFAULT_HUE = 190;

function resolveHue(baseHue, mode) {
  const spec = MODES[mode] ?? MODES.idle;
  return spec.absolute ?? (baseHue + spec.delta + 360) % 360;
}

/** Cheap smooth noise: interpolated hash, good enough for organic motion. */
function hash(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

export class Signal {
  constructor() {
    this.mode = "idle";
    this.baseHue = DEFAULT_HUE;
    this.hue = DEFAULT_HUE;
    /** Smoothed spectrum the renderers draw. */
    this.bands = new Float32Array(BANDS);
    /** Overall energy, 0…1. */
    this.level = 0;
    /** Seconds since start, advanced by update(). */
    this.time = 0;

    this._target = new Float32Array(BANDS);
    /** Optional () => Float32Array(BANDS) supplying a real spectrum. */
    this._source = null;
    /** Decaying kick, raised by impulse() on each spoken word. */
    this._impulse = 0;
    this._seed = Math.random() * 1000;
  }

  setMode(mode) {
    if (!(mode in MODES)) throw new Error(`Unknown mode: ${mode}`);
    this.mode = mode;
    this.hue = resolveHue(this.baseHue, mode);
  }

  /** Re-tints everything to a new accent, keeping the current mode's shift. */
  setBaseHue(hue) {
    this.baseHue = hue;
    this.hue = resolveHue(hue, this.mode);
  }

  /** Attach a live spectrum source (the microphone analyser). */
  setSource(fn) {
    this._source = fn;
  }

  /** Nudge the visualizer — used per spoken word so speech looks articulated. */
  impulse(strength = 1) {
    this._impulse = Math.min(1.6, this._impulse + strength);
  }

  update(dt) {
    this.time += dt;
    this._impulse = Math.max(0, this._impulse - dt * 3.2);

    const live = this._source ? this._source() : null;
    // Only listening has a real waveform behind it. Synthesized speech
    // exposes no audio stream, and echo cancellation would strip it from the
    // microphone anyway, so speaking is reconstructed below.
    if (live && this.mode === "listening") {
      this._target.set(live);
    } else {
      this._synthesize();
    }

    // Ease toward the target so a dropped frame or a jumpy analyser reading
    // never shows up as a flicker.
    const ease = 1 - Math.exp(-dt * 14);
    let sum = 0;
    for (let i = 0; i < BANDS; i++) {
      this.bands[i] += (this._target[i] - this.bands[i]) * ease;
      sum += this.bands[i];
    }
    this.level = sum / BANDS;
  }

  /** Fallback animation for modes with no real audio behind them. */
  _synthesize() {
    const t = this.time;
    const s = this._seed;

    for (let i = 0; i < BANDS; i++) {
      const phase = (i / BANDS) * Math.PI * 2;
      let v;

      switch (this.mode) {
        case "thinking": {
          // A pulse travelling around the ring: busy, but unhurried.
          const wave = Math.sin(phase * 3 - t * 2.4) * 0.5 + 0.5;
          const drift = noise(i * 0.18 + t * 1.1 + s) * 0.5;
          v = 0.1 + wave * 0.16 + drift * 0.16;
          break;
        }
        case "speaking": {
          // No audio stream is exposed for synthesized speech, so the shape is
          // reconstructed: word impulses drive the envelope, a formant-ish
          // tilt puts more energy in the low bands.
          const tilt = Math.pow(1 - i / BANDS, 0.7);
          const grain = noise(i * 0.55 + t * 9 + s);
          v = (0.12 + this._impulse * 0.62) * (0.35 + grain * 0.9) * tilt;
          break;
        }
        case "listening": {
          // Mic unavailable — stay visibly attentive rather than dead.
          const grain = noise(i * 0.3 + t * 3.4 + s);
          v = 0.08 + grain * 0.14;
          break;
        }
        case "error": {
          v = 0.14 + Math.sin(phase * 2 + t * 6) * 0.06;
          break;
        }
        default: {
          // Idle: a slow ripple travelling around a near-perfect circle.
          const breath = Math.sin(t * 0.7) * 0.5 + 0.5;
          const ripple = Math.sin(phase * 2 - t * 0.9) * 0.5 + 0.5;
          v = 0.03 + breath * 0.02 + ripple * 0.025;
        }
      }

      this._target[i] = Math.max(0, Math.min(1, v));
    }
  }
}
