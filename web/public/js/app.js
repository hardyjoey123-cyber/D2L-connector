/**
 * Wires the pieces together: microphone → transcript → Claude → speech, with
 * the visualizer following along. Conversation state lives here, in the
 * browser; the backend is a stateless relay.
 */

import { Signal, MODES } from "./signal.js";
import { Microphone } from "./audio.js";
import { createReactor } from "./visualizer.js";
import { createAmbient } from "./ambient.js";
import { Listener, Speaker } from "./voice.js";
import { streamReply } from "./claude.js";
import { Settings, PERSONAS, DEFAULTS } from "./settings.js";
import { Memory } from "./memory.js";

/** Consecutive silent listens before standing down on its own. */
const SILENCE_LIMIT = 3;

/** Accent presets, so picking a colour doesn't require using the slider. */
const SWATCHES = [
  { hue: 190, label: "Arc cyan" },
  { hue: 212, label: "Deep blue" },
  { hue: 265, label: "Violet" },
  { hue: 320, label: "Magenta" },
  { hue: 145, label: "Emerald" },
  { hue: 35, label: "Amber" },
];

const el = {
  core: document.getElementById("core"),
  reactor: document.getElementById("reactor"),
  ambient: document.getElementById("ambient"),
  status: document.getElementById("status"),
  hint: document.getElementById("hint"),
  subtitleUser: document.getElementById("subtitle-user"),
  subtitleReply: document.getElementById("subtitle-reply"),
  brandName: document.querySelector(".hud__name"),
  modelReadout: document.getElementById("model-readout"),
  session: document.getElementById("ctl-session"),
  sessionLabel: document.getElementById("ctl-session-label"),
  mute: document.getElementById("ctl-mute"),
  logToggle: document.getElementById("ctl-log"),
  typeToggle: document.getElementById("ctl-type"),
  settingsToggle: document.getElementById("ctl-settings"),
  log: document.getElementById("log"),
  logBody: document.getElementById("log-body"),
  logClose: document.getElementById("log-close"),
  typedForm: document.getElementById("typed-form"),
  typedInput: document.getElementById("typed-input"),
  toast: document.getElementById("toast"),
  settings: document.getElementById("settings"),
  settingsClose: document.getElementById("settings-close"),
  setName: document.getElementById("set-name"),
  setHue: document.getElementById("set-hue"),
  swatches: document.getElementById("swatches"),
  setPersona: document.getElementById("set-persona"),
  setCustomPersona: document.getElementById("set-custom-persona"),
  setVoice: document.getElementById("set-voice"),
  setVoiceTry: document.getElementById("set-voice-try"),
  setRate: document.getElementById("set-rate"),
  setRateValue: document.getElementById("set-rate-value"),
  setModel: document.getElementById("set-model"),
  setModelNote: document.getElementById("set-model-note"),
  setSearch: document.getElementById("set-search"),
  fieldAccount: document.getElementById("field-account"),
  setAccount: document.getElementById("set-account"),
  fieldCourses: document.getElementById("field-courses"),
  setCourses: document.getElementById("set-courses"),
  coursesNote: document.getElementById("courses-note"),
  setWake: document.getElementById("set-wake"),
  setWakePhrase: document.getElementById("set-wake-phrase"),
  setMemory: document.getElementById("set-memory"),
  setForget: document.getElementById("set-forget"),
  setReset: document.getElementById("set-reset"),
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const settings = new Settings();
const signal = new Signal();
const microphone = new Microphone();
const listener = new Listener();
const speaker = new Speaker(signal);
const memory = new Memory({ enabled: settings.get("memory") });
const reactor = createReactor(el.reactor, signal, { reducedMotion });
const ambient = createAmbient(el.ambient, signal, { reducedMotion });

signal.setSource(() => microphone.spectrum());

const state = {
  engaged: false,
  // null rather than "idle" so the first setMode() actually applies the class.
  mode: null,
  silentTurns: 0,
  greeted: false,
  micReady: false,
  /** True while listening for the wake phrase rather than for a request. */
  waking: false,
  searching: false,
  request: null, // AbortController for the in-flight reply
};

/** What the backend says it can do, filled in at boot. */
const backend = { courses: false, account: false };

/** Pending re-arm of the recognizer, so repeated calls can't stack timers. */
let listenRetry = null;

/* ------------------------------------------------------------------ render */

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  signal.setMode(mode);
  for (const { className } of Object.values(MODES)) document.body.classList.remove(className);
  document.body.classList.add(MODES[mode].className);
  document.body.classList.toggle("is-engaged", state.engaged);
  refreshStatus();
}

function refreshStatus() {
  const labels = {
    idle: state.waking ? `Awaiting “${settings.get("wakePhrase")}”` : "Standby",
    listening: "Listening",
    thinking: state.searching || "Processing",
    speaking: "Speaking",
    error: "Fault",
  };
  el.status.textContent = labels[state.mode ?? "idle"];
}

function setSubtitle(node, text, { interim = false } = {}) {
  node.textContent = text;
  node.classList.toggle("is-shown", Boolean(text));
  node.classList.toggle("is-interim", interim);
}

function appendToLog(role, text) {
  el.logBody.querySelector(".log__empty")?.remove();
  const turn = document.createElement("p");
  turn.className = `log__turn log__turn--${role}`;
  turn.textContent = text;
  el.logBody.append(turn);
  el.logBody.scrollTop = el.logBody.scrollHeight;
  return turn;
}

function renderLogFromMemory() {
  el.logBody.replaceChildren();
  if (memory.isEmpty) {
    const empty = document.createElement("p");
    empty.className = "log__empty";
    empty.textContent = "No exchanges yet";
    el.logBody.append(empty);
    return;
  }
  for (const turn of memory.turns) appendToLog(turn.role, turn.content);
}

let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, 5200);
}

/* ---------------------------------------------------------- session control */

async function engage() {
  if (state.engaged) return;
  stopWaking();
  state.engaged = true;
  state.silentTurns = 0;
  el.session.setAttribute("aria-pressed", "true");
  el.sessionLabel.textContent = "Stand down";
  document.body.classList.add("is-engaged");

  // Fed to the visualizer while listening. Optional: without it the animation
  // falls back to a synthetic pattern, and everything else still works.
  state.micReady = await microphone.start();
  // Standing down while the permission prompt was open wins.
  if (!state.engaged) return;

  if (!state.greeted) {
    state.greeted = true;
    speaker.unlock();
    if (!speaker.muted && speaker.supported) {
      speakResponse("Online.", { record: false });
      return;
    }
  }
  startListening();
}

function standDown() {
  state.engaged = false;
  window.clearTimeout(listenRetry);
  listenRetry = null;
  state.request?.abort();
  state.request = null;
  listener.abort();
  speaker.cancel();
  el.session.setAttribute("aria-pressed", "false");
  el.sessionLabel.textContent = "Engage";
  document.body.classList.remove("is-engaged");
  setMode("idle");
  setSubtitle(el.subtitleUser, "");
  // Standing down hands the floor back to the wake word, if it's on.
  startWaking();
}

/** Core tap / Space. What it does depends on what the assistant is doing. */
function primaryAction() {
  if (!state.engaged) {
    void engage();
    return;
  }
  switch (state.mode) {
    case "speaking":
    case "thinking":
      // Barge-in: drop the current reply and hand the floor back.
      state.request?.abort();
      state.request = null;
      state.searching = null;
      speaker.cancel();
      startListening();
      break;
    default:
      standDown();
  }
}

/* --------------------------------------------------------------- wake word */

/**
 * Waits for the wake phrase without holding a session open. Only meaningful
 * once the microphone has been granted, so it is armed after the first
 * engage rather than on page load.
 */
function startWaking() {
  if (state.waking || state.engaged) return;
  if (!settings.get("wakeWord") || !listener.supported || !state.micReady) return;
  listener.wakePhrase = settings.get("wakePhrase") || DEFAULTS.wakePhrase;
  state.waking = true;
  if (!listener.start("wake")) {
    state.waking = false;
    window.setTimeout(startWaking, 400);
    return;
  }
  refreshStatus();
}

function stopWaking() {
  if (!state.waking) return;
  state.waking = false;
  listener.abort();
  refreshStatus();
}

listener.onWake = (trailing) => {
  state.waking = false;
  // "Jarvis, what's the weather" wakes and asks in one breath; a bare
  // "Jarvis" just opens the floor.
  if (trailing && trailing.split(/\s+/).length >= 2) {
    state.engaged = true;
    el.session.setAttribute("aria-pressed", "true");
    el.sessionLabel.textContent = "Stand down";
    document.body.classList.add("is-engaged");
    void send(trailing);
    return;
  }
  void engage();
};

/* -------------------------------------------------------------- voice loop */

function startListening() {
  window.clearTimeout(listenRetry);
  listenRetry = null;
  if (!state.engaged || listener.listening) return;
  if (!listener.supported) {
    setMode("idle");
    openTypedInput();
    return;
  }
  setSubtitle(el.subtitleUser, "");
  setMode("listening");
  if (!listener.start("command")) {
    // The engine is still tearing down the previous session; retry shortly.
    listenRetry = window.setTimeout(startListening, 260);
  }
}

listener.onInterim = (text) => setSubtitle(el.subtitleUser, text, { interim: true });

listener.onFinal = (text) => {
  setSubtitle(el.subtitleUser, text);
  state.silentTurns = 0;
};

listener.onEnd = (final, mode) => {
  if (mode === "wake") {
    // Continuous recognition stops on its own periodically; re-arm it.
    if (state.waking) {
      state.waking = false;
      window.setTimeout(startWaking, 250);
    }
    return;
  }
  // Only meaningful while we were actually listening; a session torn down for
  // any other reason is not a silent turn.
  if (!state.engaged || state.mode !== "listening") return;
  if (final) {
    void send(final);
    return;
  }
  // Nothing was said. Give it a couple of tries before standing down, so a
  // hands-free session doesn't listen to an empty room indefinitely.
  state.silentTurns += 1;
  if (state.silentTurns >= SILENCE_LIMIT) {
    toast("No speech detected — standing by.");
    standDown();
    return;
  }
  listenRetry = window.setTimeout(startListening, 200);
};

listener.onError = ({ code, message }) => {
  if (code === "no-speech") return; // onEnd handles the retry
  // Wake listening runs unattended; its hiccups shouldn't raise a banner.
  if (state.waking) return;
  toast(message);
  if (code === "not-allowed" || code === "service-not-allowed") {
    standDown();
    openTypedInput();
  }
};

/* ------------------------------------------------------------------- turns */

async function send(text) {
  listener.abort();
  setSubtitle(el.subtitleUser, text);
  setSubtitle(el.subtitleReply, "");
  appendToLog("user", text);

  memory.push("user", text);
  state.searching = null;
  setMode("thinking");

  const controller = new AbortController();
  state.request = controller;

  speaker.begin();
  let logLine = null;
  let started = false;

  try {
    const reply = await streamReply(memory.context(), {
      abortSignal: controller.signal,
      persona: settings.personaText(),
      model: settings.get("model"),
      webSearch: settings.get("webSearch"),
      courses: backend.courses && settings.get("courses"),
      account: backend.account && settings.get("account"),
      onStatus: (label) => {
        // The pause before an answer is much easier to sit through when the
        // interface says what it's doing.
        state.searching = { searching: "Searching", courses: "Checking courses" }[label] ?? null;
        refreshStatus();
      },
      onDelta: (delta, full) => {
        if (!started) {
          started = true;
          state.searching = null;
          logLine = appendToLog("assistant", "");
          // Speech begins on the first complete sentence, not the last token.
          if (!speaker.muted && speaker.supported) setMode("speaking");
          else refreshStatus();
        }
        setSubtitle(el.subtitleReply, full);
        if (logLine) logLine.textContent = full;
        speaker.pushDelta(delta);
      },
    });

    if (controller.signal.aborted) return;
    memory.push("assistant", reply);
    if (state.request === controller) state.request = null;
    // end() resolves the turn through speaker.onEnd — immediately if there
    // was nothing to say, otherwise once the last sentence finishes.
    speaker.end();
  } catch (error) {
    if (state.request === controller) state.request = null;
    state.searching = null;
    speaker.cancel();
    if (controller.signal.aborted || error?.name === "AbortError") return;

    toast(error instanceof Error ? error.message : String(error));
    setMode("error");
    // Drop the unanswered user turn so the history stays a valid alternation.
    memory.pop();
    window.setTimeout(() => {
      if (state.engaged) startListening();
      else setMode("idle");
    }, 1800);
  }
}

/** Speaks text that didn't come from Claude (the greeting). */
function speakResponse(text, { record = true } = {}) {
  setMode("speaking");
  speaker.begin();
  speaker.pushDelta(text);
  speaker.end();
  if (record) {
    setSubtitle(el.subtitleReply, text);
    appendToLog("assistant", text);
  }
}

function finishTurn() {
  if (state.engaged) startListening();
  else setMode("idle");
}

speaker.onStart = () => {
  if (state.mode !== "speaking") setMode("speaking");
};

speaker.onEnd = () => {
  if (state.mode === "error") return;
  finishTurn();
};

/* ----------------------------------------------------------------- typed in */

function openTypedInput() {
  el.typedForm.hidden = false;
  el.typeToggle.setAttribute("aria-expanded", "true");
  el.typedInput.focus();
}

function closeTypedInput() {
  el.typedForm.hidden = true;
  el.typeToggle.setAttribute("aria-expanded", "false");
}

el.typedForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = el.typedInput.value.trim();
  if (!text) return;
  el.typedInput.value = "";
  // Deliberately does not engage the voice loop: someone who typed probably
  // wants to keep typing. An already-engaged session stays engaged.
  speaker.unlock();
  void send(text);
});

/* ---------------------------------------------------------------- controls */

el.core.addEventListener("click", primaryAction);
el.session.addEventListener("click", () => (state.engaged ? standDown() : void engage()));

el.mute.addEventListener("click", () => {
  const muted = !speaker.muted;
  speaker.setMuted(muted);
  el.mute.setAttribute("aria-pressed", String(muted));
  el.mute.textContent = muted ? "Voice off" : "Voice on";
  if (muted && state.mode === "speaking") finishTurn();
});

/** Only one side drawer at a time; they occupy the same space. */
function toggleDrawer(which, force) {
  const target = which === "log" ? el.log : el.settings;
  const other = which === "log" ? el.settings : el.log;
  const toggle = which === "log" ? el.logToggle : el.settingsToggle;
  const otherToggle = which === "log" ? el.settingsToggle : el.logToggle;

  const open = force ?? target.hidden;
  target.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  if (open) {
    other.hidden = true;
    otherToggle.setAttribute("aria-expanded", "false");
  }
}

el.logToggle.addEventListener("click", () => toggleDrawer("log"));
el.logClose.addEventListener("click", () => toggleDrawer("log", false));
el.settingsToggle.addEventListener("click", () => toggleDrawer("settings"));
el.settingsClose.addEventListener("click", () => toggleDrawer("settings", false));
el.typeToggle.addEventListener("click", () =>
  el.typedForm.hidden ? openTypedInput() : closeTypedInput()
);

document.addEventListener("keydown", (event) => {
  const typing =
    event.target === el.typedInput ||
    el.settings.contains(event.target) ||
    event.target.tagName === "INPUT" ||
    event.target.tagName === "TEXTAREA";

  if (event.key === "Escape") {
    if (event.target === el.typedInput) {
      closeTypedInput();
      el.typedInput.blur();
    } else if (!el.settings.hidden) toggleDrawer("settings", false);
    else if (!el.log.hidden) toggleDrawer("log", false);
    else standDown();
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.code === "Space") {
    event.preventDefault();
    primaryAction();
  } else if (event.key === "/") {
    event.preventDefault();
    openTypedInput();
  } else if (event.key === "l" || event.key === "L") {
    toggleDrawer("log");
  } else if (event.key === "s" || event.key === "S") {
    toggleDrawer("settings");
  } else if (event.key === "m" || event.key === "M") {
    el.mute.click();
  }
});

/* ---------------------------------------------------------- settings panel */

function applySettings() {
  const values = settings.values;
  el.brandName.textContent = values.name;
  document.title = values.name.replace(/\./g, "") || "JARVIS";
  document.documentElement.style.setProperty("--accent-base", String(values.hue));
  signal.setBaseHue(values.hue);
  speaker.setVoiceByName(values.voiceName);
  speaker.setRate(values.rate);
  listener.wakePhrase = values.wakePhrase || DEFAULTS.wakePhrase;
  memory.setEnabled(values.memory);
  syncSwatches();
  el.setWakePhrase.hidden = !values.wakeWord;
  refreshStatus();
}

/** Highlights the preset matching the current hue, if any. */
function syncSwatches() {
  for (const [i, button] of [...el.swatches.children].entries()) {
    button.setAttribute("aria-pressed", String(SWATCHES[i].hue === settings.get("hue")));
  }
}

function buildSettingsPanel() {
  for (const [key, persona] of Object.entries(PERSONAS)) {
    el.setPersona.append(new Option(persona.label, key));
  }

  for (const swatch of SWATCHES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.title = swatch.label;
    button.setAttribute("aria-label", swatch.label);
    button.style.background = `hsl(${swatch.hue} 90% 55%)`;
    button.style.color = `hsl(${swatch.hue} 90% 60%)`;
    button.addEventListener("click", () => {
      settings.update({ hue: swatch.hue });
      syncSettingsForm();
    });
    el.swatches.append(button);
  }

  // Voices arrive asynchronously in most browsers.
  const fillVoices = () => {
    const selected = settings.get("voiceName");
    el.setVoice.replaceChildren(new Option("Automatic", ""));
    for (const voice of speaker.voices()) {
      el.setVoice.append(new Option(`${voice.name} (${voice.lang})`, voice.name));
    }
    el.setVoice.value = selected;
  };
  fillVoices();
  window.speechSynthesis?.addEventListener?.("voiceschanged", fillVoices);

  bind(el.setName, "input", () => settings.update({ name: el.setName.value || DEFAULTS.name }));
  bind(el.setHue, "input", () => settings.update({ hue: Number(el.setHue.value) }));
  bind(el.setPersona, "change", () => {
    settings.update({ persona: el.setPersona.value });
    syncSettingsForm();
  });
  bind(el.setCustomPersona, "input", () =>
    settings.update({ customPersona: el.setCustomPersona.value })
  );
  bind(el.setVoice, "change", () => settings.update({ voiceName: el.setVoice.value }));
  bind(el.setRate, "input", () => {
    settings.update({ rate: Number(el.setRate.value) });
    el.setRateValue.textContent = `${Number(el.setRate.value).toFixed(2)}×`;
  });
  bind(el.setModel, "change", () => {
    settings.update({ model: el.setModel.value });
    syncSettingsForm();
  });
  bind(el.setSearch, "change", () => settings.update({ webSearch: el.setSearch.checked }));
  bind(el.setCourses, "change", () => settings.update({ courses: el.setCourses.checked }));
  bind(el.setAccount, "change", () => settings.update({ account: el.setAccount.checked }));
  bind(el.setWake, "change", () => {
    settings.update({ wakeWord: el.setWake.checked });
    if (el.setWake.checked) startWaking();
    else stopWaking();
  });
  bind(el.setWakePhrase, "input", () =>
    settings.update({ wakePhrase: el.setWakePhrase.value.trim() || DEFAULTS.wakePhrase })
  );
  bind(el.setMemory, "change", () => settings.update({ memory: el.setMemory.checked }));

  el.setVoiceTry.addEventListener("click", () => {
    speaker.unlock();
    speaker.preview("All systems are nominal.");
  });

  el.setForget.addEventListener("click", () => {
    memory.forget();
    renderLogFromMemory();
    setSubtitle(el.subtitleUser, "");
    setSubtitle(el.subtitleReply, "");
    toast("History cleared.");
  });

  el.setReset.addEventListener("click", () => {
    settings.reset();
    syncSettingsForm();
    toast("Settings reset.");
  });
}

/** Every settings input writes through to storage, then re-applies. */
function bind(node, event, handler) {
  node.addEventListener(event, () => {
    handler();
    applySettings();
  });
}

function syncSettingsForm() {
  const values = settings.values;
  el.setName.value = values.name;
  el.setHue.value = String(values.hue);
  el.setPersona.value = values.persona;
  el.setCustomPersona.hidden = values.persona !== "custom";
  el.setCustomPersona.value = values.customPersona;
  el.setVoice.value = values.voiceName;
  el.setRate.value = String(values.rate);
  el.setRateValue.textContent = `${Number(values.rate).toFixed(2)}×`;
  el.setModel.value = values.model;
  el.setSearch.checked = values.webSearch;
  el.setWake.checked = values.wakeWord;
  el.setWakePhrase.value = values.wakePhrase;
  el.setMemory.checked = values.memory;
  el.setCourses.checked = values.courses;
  el.setAccount.checked = values.account;
  el.setWakePhrase.hidden = !values.wakeWord;
  syncSwatches();

  const notes = {
    "claude-opus-5": "Sharpest answers. Around a cent per exchange.",
    "claude-sonnet-5": "A good middle ground on both quality and cost.",
    "claude-haiku-4-5": "Fastest and cheapest, and noticeably less sharp.",
  };
  el.setModelNote.textContent = notes[values.model] ?? "";
  el.modelReadout.textContent = `◦ ${values.model}`;
}

/* ------------------------------------------------------------------- setup */

function resize() {
  reactor.resize();
  ambient.resize();
}

window.addEventListener("resize", resize);
new ResizeObserver(() => reactor.resize()).observe(el.core);

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  signal.update(dt);
  ambient.draw(dt);
  reactor.draw();
  requestAnimationFrame(frame);
}

async function boot() {
  resize();
  buildSettingsPanel();
  setMode("idle");
  renderLogFromMemory();

  if (!listener.supported) {
    el.hint.innerHTML =
      "Voice input needs Chrome, Edge or Safari — press <kbd>/</kbd> to type instead";
    toast("This browser has no speech recognition. Text input is available.");
  }

  let models = [DEFAULTS.model];
  try {
    const health = await fetch("/api/health").then((r) => r.json());
    if (Array.isArray(health.models) && health.models.length) models = health.models;
    backend.courses = health.courses === true;
    backend.account = health.account === true;
  } catch {
    el.modelReadout.textContent = "◦ offline";
    toast("Backend unreachable. Start it with: npm run jarvis");
  }
  // The server decides which models are allowed, so the picker mirrors it.
  el.setModel.replaceChildren(...models.map((id) => new Option(id, id)));
  if (!models.includes(settings.get("model"))) settings.update({ model: models[0] });

  // The toggle only appears when the server actually has Brightspace wired up;
  // offering a switch that can't do anything is worse than offering none.
  el.fieldAccount.hidden = !backend.account;
  el.fieldCourses.hidden = !backend.courses;
  el.coursesNote.textContent = backend.courses
    ? "Lets it read your Brightspace courses, coursework, grades, and announcements."
    : "";

  syncSettingsForm();
  applySettings();

  // If the microphone is already granted from a previous visit, the wake word
  // can arm itself without waiting for a first click.
  if (settings.get("wakeWord") && listener.supported) {
    try {
      const status = await navigator.permissions?.query({ name: "microphone" });
      if (status?.state === "granted") {
        state.micReady = await microphone.start();
        startWaking();
      }
    } catch {
      // Permissions API unsupported or the query name isn't recognized; the
      // wake word simply arms after the first engage instead.
    }
  }

  requestAnimationFrame(frame);
}

void boot();
