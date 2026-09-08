/**
 * Browser speech in and out.
 *
 * Input uses SpeechRecognition with continuous=false, which gives us the
 * browser's own endpointing: it decides when you've stopped talking and hands
 * back a final transcript. Output uses speechSynthesis, fed sentence by
 * sentence as the reply streams in so speaking starts before the reply is
 * finished.
 */

const SpeechRecognitionImpl = window.SpeechRecognition ?? window.webkitSpeechRecognition;

/** Voices that sound closest to the reference, best first. */
const PREFERRED_VOICES = [
  "Google UK English Male",
  "Daniel",
  "Arthur",
  "Oliver",
  "Microsoft Ryan Online (Natural) - English (United Kingdom)",
  "Google UK English Female",
  "Serena",
];

export class Listener {
  constructor() {
    this.supported = Boolean(SpeechRecognitionImpl);
    this.listening = false;
    this.onInterim = () => {};
    this.onFinal = () => {};
    this.onError = () => {};
    this.onEnd = () => {};

    if (!this.supported) return;

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) this.onInterim(interim.trim());
      if (final.trim()) {
        this._final = final.trim();
        this.onFinal(this._final);
      }
    };

    recognition.onerror = (event) => {
      // "aborted" is what we cause ourselves by calling stop(); "no-speech"
      // just means the user said nothing. Neither is worth surfacing.
      if (event.error === "aborted") return;
      if (event.error === "no-speech") {
        this.onError({ code: "no-speech", message: "No speech detected." });
        return;
      }
      const message =
        event.error === "not-allowed" || event.error === "service-not-allowed"
          ? "Microphone access was denied. Enable it in your browser's site settings."
          : `Speech recognition error: ${event.error}`;
      this.onError({ code: event.error, message });
    };

    recognition.onend = () => {
      this.listening = false;
      const final = this._final;
      this._final = null;
      // abort() is caller-initiated, so the caller already knows the session
      // is over and must not be told again as if the user had gone quiet.
      const suppressed = this._suppressEnd;
      this._suppressEnd = false;
      if (!suppressed) this.onEnd(final);
    };

    this._recognition = recognition;
    this._final = null;
    this._suppressEnd = false;
  }

  start() {
    if (!this.supported || this.listening) return false;
    this._final = null;
    // Clear a suppression that was never consumed, e.g. abort() on a session
    // that had already ended and so never fired onend again.
    this._suppressEnd = false;
    try {
      this._recognition.start();
      this.listening = true;
      return true;
    } catch {
      // start() throws if the engine hasn't finished tearing down the previous
      // session yet; the caller can simply try again.
      return false;
    }
  }

  stop() {
    if (!this.supported || !this.listening) return;
    this._recognition.stop();
  }

  abort() {
    if (!this.supported) return;
    this._suppressEnd = true;
    this.listening = false;
    try {
      this._recognition.abort();
    } catch {
      /* already stopped */
    }
  }
}

export class Speaker {
  constructor(signal) {
    this.supported = "speechSynthesis" in window;
    this.muted = false;
    this.speaking = false;
    this.onStart = () => {};
    this.onEnd = () => {};

    this._signal = signal;
    this._buffer = "";
    this._queue = [];
    /** True once end() has been called: no further chunks are coming. */
    this._closed = true;
    /** True when no utterance is in flight — the queue pump is parked. */
    this._idle = true;
    this._current = null;
    this._voice = null;
    this._keepAlive = null;
    this._unlocked = false;

    if (!this.supported) return;
    this._loadVoice();
    window.speechSynthesis.addEventListener?.("voiceschanged", () => this._loadVoice());
  }

  _loadVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length === 0) return; // fires again via voiceschanged
    this._voice =
      PREFERRED_VOICES.map((name) => voices.find((v) => v.name === name)).find(Boolean) ??
      voices.find((v) => v.lang === "en-GB") ??
      voices.find((v) => v.lang?.startsWith("en")) ??
      voices[0];
  }

  /**
   * iOS refuses to synthesize speech unless the first utterance is started
   * inside a user gesture. Burning one silent utterance on the first tap buys
   * that permission for the rest of the session.
   */
  unlock() {
    if (!this.supported || this._unlocked) return;
    this._unlocked = true;
    const primer = new SpeechSynthesisUtterance(" ");
    primer.volume = 0;
    window.speechSynthesis.speak(primer);
  }

  /** Opens a new spoken response. */
  begin() {
    this._buffer = "";
    this._queue = [];
    this._closed = false;
    this._idle = true;
  }

  /** Feeds a streamed text delta; complete sentences are spoken immediately. */
  pushDelta(text) {
    this._buffer += text;
    let chunk;
    while ((chunk = takeUtterance(this._buffer)) !== null) {
      this._buffer = this._buffer.slice(chunk.length);
      this._enqueue(chunk);
    }
  }

  /** Marks the end of the response; speaks whatever is left in the buffer. */
  end() {
    this._closed = true;
    if (this._buffer.trim()) this._enqueue(this._buffer);
    this._buffer = "";
    // The queue may already have drained while the stream was still arriving,
    // in which case the pump is parked and won't close the turn on its own.
    if (this._idle && this._queue.length === 0) this._close();
  }

  /** Stops immediately without resolving the turn — the caller decides next. */
  cancel() {
    this._buffer = "";
    this._queue = [];
    this._closed = true;
    this._idle = true;
    this._current = null;
    this.speaking = false;
    this._stopKeepAlive();
    if (this.supported) window.speechSynthesis.cancel();
  }

  setMuted(muted) {
    this.muted = muted;
    if (muted) this.cancel();
  }

  _enqueue(raw) {
    const text = sanitizeForSpeech(raw);
    if (!text || this.muted || !this.supported) return;
    this._queue.push(text);
    if (this._idle) this._next();
  }

  _next() {
    const text = this._queue.shift();
    if (text === undefined) {
      this._idle = true;
      // Park until either another chunk arrives or end() closes the turn.
      if (this._closed) this._close();
      return;
    }

    this._idle = false;
    if (!this.speaking) {
      this.speaking = true;
      this._startKeepAlive();
      this.onStart();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    if (this._voice) {
      utterance.voice = this._voice;
      utterance.lang = this._voice.lang;
    }
    utterance.rate = 1.02;
    utterance.pitch = 0.92;

    // Word boundaries are the only timing information the API exposes, so
    // they drive the visualizer's speech envelope.
    utterance.onboundary = () => this._signal?.impulse(0.85);
    utterance.onend = () => {
      if (this._current === utterance) this._next();
    };
    utterance.onerror = () => {
      if (this._current === utterance) this._next();
    };

    this._current = utterance;
    window.speechSynthesis.speak(utterance);
  }

  _close() {
    this.speaking = false;
    this._current = null;
    this._stopKeepAlive();
    this.onEnd();
  }

  /**
   * Chrome silently pauses long-running synthesis. resume() is a no-op when
   * nothing is paused, so this is safe to call on a timer.
   */
  _startKeepAlive() {
    this._stopKeepAlive();
    this._keepAlive = window.setInterval(() => {
      if (window.speechSynthesis.speaking) window.speechSynthesis.resume();
    }, 8000);
  }

  _stopKeepAlive() {
    if (this._keepAlive !== null) {
      window.clearInterval(this._keepAlive);
      this._keepAlive = null;
    }
  }
}

const MIN_UTTERANCE = 16;
const MAX_UTTERANCE = 190;

/**
 * Returns the leading complete utterance in `buffer`, or null if none is ready.
 * Splitting on sentence boundaries lets speech start while the reply is still
 * streaming, which removes most of the perceived latency.
 */
export function takeUtterance(buffer) {
  const newline = buffer.indexOf("\n");
  if (newline > 0) return buffer.slice(0, newline + 1);

  // A terminator only counts when whitespace already follows it in the buffer.
  // At the very end of a partial buffer there is no way to tell the "88." of
  // "88.5 percent" from the end of a sentence — so we wait. Speaker.end()
  // flushes whatever is left once the stream closes, which costs nothing:
  // that tail is the last thing spoken either way.
  const sentence = /[.!?…]["')\]]?(?=\s)/g;
  let match;
  while ((match = sentence.exec(buffer)) !== null) {
    const end = match.index + match[0].length;
    // A lone letter or digit before the period is far more likely an initial
    // or an abbreviation ("Section A.", "J. Stark") than a sentence ending.
    if (/(^|\s)[A-Za-z0-9]$/.test(buffer.slice(0, match.index))) continue;
    if (end < MIN_UTTERANCE) continue;
    const trailing = buffer.slice(end).match(/^\s+/)[0];
    return buffer.slice(0, end + trailing.length);
  }

  // No sentence in sight but the buffer is getting long — break at a comma or
  // a space rather than letting the whole reply queue up as one utterance.
  if (buffer.length > MAX_UTTERANCE) {
    const head = buffer.slice(0, MAX_UTTERANCE);
    const cut = Math.max(head.lastIndexOf(", "), head.lastIndexOf(" "));
    if (cut > MIN_UTTERANCE) return buffer.slice(0, cut + 1);
  }
  return null;
}

/** Strips anything a synthesizer would read out as punctuation noise. */
export function sanitizeForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
