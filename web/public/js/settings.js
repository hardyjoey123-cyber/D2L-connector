/**
 * User settings, persisted per browser.
 *
 * Kept deliberately small and flat: everything here is something a person
 * might reasonably want to change about their own assistant, and nothing here
 * is a secret — the API key lives on the server and never reaches this file.
 */

const STORAGE_KEY = "jarvis.settings.v1";

/**
 * Swappable half of the system prompt. The rules about writing for a speech
 * synthesizer live on the server and always apply on top of these, so a
 * persona can change the manner without breaking the medium.
 */
export const PERSONAS = {
  jarvis: {
    label: "Jarvis",
    text:
      "You are JARVIS, a voice-driven assistant. Your manner is calm, precise, and " +
      "lightly dry. Do not use honorifics such as \"sir\" or \"madam\", and do not open " +
      "with filler like \"certainly\" or \"of course\".",
  },
  warm: {
    label: "Warm",
    text:
      "You are a friendly, encouraging voice assistant. You are relaxed and personable " +
      "without being saccharine, and you use contractions and everyday words.",
  },
  terse: {
    label: "Terse",
    text:
      "You are a maximally efficient voice assistant. Answer in the fewest words that " +
      "fully answer the question — often a sentence fragment. Never pad, never restate " +
      "the question, never offer follow-ups unless asked.",
  },
  witty: {
    label: "Witty",
    text:
      "You are a quick-witted voice assistant with a dry sense of humour. You are genuinely " +
      "helpful first and funny second: the joke never costs the answer its clarity, and you " +
      "drop it entirely when the question is serious.",
  },
  custom: { label: "Custom", text: "" },
};

export const DEFAULTS = {
  name: "J.A.R.V.I.S",
  /** Base accent hue in degrees; each state shifts from here. */
  hue: 190,
  persona: "jarvis",
  customPersona: "",
  /** "" means pick the best available voice automatically. */
  voiceName: "",
  rate: 1.02,
  model: "claude-opus-5",
  webSearch: true,
  /** Ignored unless the server reports Brightspace is configured. */
  courses: true,
  /** Ignored unless the server has a brokerage MCP server configured. */
  account: true,
  wakeWord: false,
  wakePhrase: "jarvis",
  memory: true,
};

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...read() };
    this._listeners = new Set();
  }

  get(key) {
    return this.values[key];
  }

  /** Applies a patch, persists it, and notifies subscribers once. */
  update(patch) {
    const before = { ...this.values };
    Object.assign(this.values, patch);
    write(this.values);
    for (const listener of this._listeners) listener(this.values, before);
  }

  reset() {
    this.update({ ...DEFAULTS });
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** The persona text to send with a request, resolving the custom option. */
  personaText() {
    if (this.values.persona === "custom") {
      return this.values.customPersona.trim() || PERSONAS.jarvis.text;
    }
    return (PERSONAS[this.values.persona] ?? PERSONAS.jarvis).text;
  }
}

function read() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Only keep keys we know about, so a stale or hand-edited entry can't
    // introduce fields the rest of the app doesn't expect.
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key in DEFAULTS)
    );
  } catch {
    // Private mode, cleared storage, corrupt JSON — defaults are fine.
    return {};
  }
}

function write(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Nothing to do: settings just won't survive a reload.
  }
}
