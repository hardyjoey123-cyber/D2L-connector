/**
 * Microphone spectrum for the visualizer.
 *
 * Separate from speech recognition on purpose: the browser gives us a
 * transcript but no waveform, so we tap the same microphone independently just
 * to draw it. If this fails — permission denied, no AudioContext, a device
 * that won't share — the interface still works and falls back to the synthetic
 * animation in signal.js.
 */

import { BANDS } from "./signal.js";

const HALF = BANDS / 2;
const MIN_HZ = 80;
const MAX_HZ = 4000;
/** Room tone sits under this; anything below it reads as silence. */
const NOISE_FLOOR = 0.07;

export class Microphone {
  constructor() {
    this.available = false;
    this._stream = null;
    this._context = null;
    this._analyser = null;
    this._bins = null;
    this._out = new Float32Array(BANDS);
    this._map = null;
  }

  /** Requests the mic once and keeps it open; safe to call repeatedly. */
  async start() {
    if (this.available) {
      if (this._context?.state === "suspended") await this._context.resume();
      return true;
    }
    if (!navigator.mediaDevices?.getUserMedia) return false;

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      return false;
    }

    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtx) {
      this._release();
      return false;
    }

    this._context = new AudioCtx();
    if (this._context.state === "suspended") await this._context.resume();

    this._analyser = this._context.createAnalyser();
    this._analyser.fftSize = 1024;
    this._analyser.smoothingTimeConstant = 0.72;
    this._analyser.minDecibels = -85;
    this._analyser.maxDecibels = -20;

    this._context.createMediaStreamSource(this._stream).connect(this._analyser);
    this._bins = new Uint8Array(this._analyser.frequencyBinCount);
    this._map = buildBandMap(this._context.sampleRate, this._analyser.fftSize);
    this.available = true;
    return true;
  }

  /**
   * A mirrored, normalized spectrum, or null when no audio is available.
   * Mirroring is cosmetic: a symmetric ring reads as an instrument, an
   * asymmetric one reads as a bar chart bent into a circle.
   */
  spectrum() {
    if (!this.available) return null;
    this._analyser.getByteFrequencyData(this._bins);

    for (let i = 0; i < HALF; i++) {
      const [lo, hi] = this._map[i];
      let peak = 0;
      for (let bin = lo; bin <= hi; bin++) {
        if (this._bins[bin] > peak) peak = this._bins[bin];
      }
      const gated = Math.max(0, peak / 255 - NOISE_FLOOR) / (1 - NOISE_FLOOR);
      // Slight expansion: quiet speech should still be visible, room tone
      // should not.
      const v = Math.min(1, Math.pow(gated, 0.8) * 1.35);
      this._out[i] = v;
      this._out[BANDS - 1 - i] = v;
    }
    return this._out;
  }

  stop() {
    this._release();
    this._context?.close().catch(() => {});
    this._context = null;
    this._analyser = null;
    this.available = false;
  }

  _release() {
    this._stream?.getTracks().forEach((track) => track.stop());
    this._stream = null;
  }
}

/**
 * Groups FFT bins into log-spaced bands across the speech range. Linear
 * spacing wastes most of the ring on frequencies a voice never reaches.
 */
function buildBandMap(sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const maxBin = Math.floor(sampleRate / 2 / binHz) - 1;
  const map = [];

  for (let i = 0; i < HALF; i++) {
    const lowHz = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / HALF);
    const highHz = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, (i + 1) / HALF);
    const lo = Math.min(maxBin, Math.max(1, Math.floor(lowHz / binHz)));
    const hi = Math.min(maxBin, Math.max(lo, Math.ceil(highHz / binHz) - 1));
    map.push([lo, hi]);
  }
  return map;
}
