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

/** Turns kept in context. Older ones drop off to bound cost and latency. */
const HISTORY_LIMIT = 30;
/** Consecutive silent listens before standing down on its own. */
const SILENCE_LIMIT = 3;

const el = {
  core: document.getElementById("core"),
  reactor: document.getElementById("reactor"),
  ambient: document.getElementById("ambient"),
  status: document.getElementById("status"),
  hint: document.getElementById("hint"),
  subtitles: document.getElementById("subtitles"),
  subtitleUser: document.getElementById("subtitle-user"),
  subtitleReply: document.getElementById("subtitle-reply"),
  modelReadout: document.getElementById("model-readout"),
  session: document.getElementById("ctl-session"),
  sessionLabel: document.getElementById("ctl-session-label"),
  mute: document.getElementById("ctl-mute"),
  logToggle: document.getElementById("ctl-log"),
  typeToggle: document.getElementById("ctl-type"),
  log: document.getElementById("log"),
  logBody: document.getElementById("log-body"),
  logClose: document.getElementById("log-close"),
  typedForm: document.getElementById("typed-form"),
  typedInput: document.getElementById("typed-input"),
  toast: document.getElementById("toast"),
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const signal = new Signal();
const microphone = new Microphone();
const listener = new Listener();
const speaker = new Speaker(signal);
const reactor = createReactor(el.reactor, signal, { reducedMotion });
const ambient = createAmbient(el.ambient, signal, { reducedMotion });

signal.setSource(() => microphone.spectrum());

const state = {
  engaged: false,
  // null rather than "idle" so the first setMode() actually applies the class.
  mode: null,
  history: [],
  silentTurns: 0,
  greeted: false,
  request: null, // AbortController for the in-flight reply
};

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

  const labels = {
    idle: state.engaged ? "Ready" : "Standby",
    listening: "Listening",
    thinking: "Processing",
    speaking: "Speaking",
    error: "Fault",
  };
  el.status.textContent = labels[mode];
}

function setSubtitle(node, text, { interim = false } = {}) {
  node.textContent = text;
  node.classList.toggle("is-shown", Boolean(text));
  node.classList.toggle("is-interim", interim);
}

function appendToLog(role, text) {
  const empty = el.logBody.querySelector(".log__empty");
  empty?.remove();
  const turn = document.createElement("p");
  turn.className = `log__turn log__turn--${role}`;
  turn.textContent = text;
  el.logBody.append(turn);
  el.logBody.scrollTop = el.logBody.scrollHeight;
  return turn;
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
  state.engaged = true;
  state.silentTurns = 0;
  el.session.setAttribute("aria-pressed", "true");
  el.sessionLabel.textContent = "Stand down";
  document.body.classList.add("is-engaged");

  // Fed to the visualizer while listening. Optional: without it the animation
  // falls back to a synthetic pattern, and everything else still works.
  await microphone.start();
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
      speaker.cancel();
      startListening();
      break;
    default:
      standDown();
  }
}

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
  if (!listener.start()) {
    // The engine is still tearing down the previous session; retry shortly.
    listenRetry = window.setTimeout(startListening, 260);
  }
}

listener.onInterim = (text) => setSubtitle(el.subtitleUser, text, { interim: true });

listener.onFinal = (text) => {
  setSubtitle(el.subtitleUser, text);
  state.silentTurns = 0;
};

listener.onEnd = (final) => {
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
  window.setTimeout(startListening, 200);
};

listener.onError = ({ code, message }) => {
  if (code === "no-speech") return; // onEnd handles the retry
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

  state.history.push({ role: "user", content: text });
  trimHistory();
  setMode("thinking");

  const controller = new AbortController();
  state.request = controller;

  speaker.begin();
  let logLine = null;
  let started = false;

  try {
    const reply = await streamReply(state.history, {
      abortSignal: controller.signal,
      onDelta: (delta, full) => {
        if (!started) {
          started = true;
          logLine = appendToLog("assistant", "");
          // Speech begins on the first complete sentence, not the last token.
          if (!speaker.muted && speaker.supported) setMode("speaking");
        }
        setSubtitle(el.subtitleReply, full);
        if (logLine) logLine.textContent = full;
        speaker.pushDelta(delta);
      },
    });

    if (controller.signal.aborted) return;
    state.history.push({ role: "assistant", content: reply });
    if (state.request === controller) state.request = null;
    // end() resolves the turn through speaker.onEnd — immediately if there
    // was nothing to say, otherwise once the last sentence finishes.
    speaker.end();
  } catch (error) {
    if (state.request === controller) state.request = null;
    speaker.cancel();
    if (controller.signal.aborted || error?.name === "AbortError") return;

    const message = error instanceof Error ? error.message : String(error);
    toast(message);
    setMode("error");
    // Drop the unanswered user turn so the history stays a valid alternation.
    state.history.pop();
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

function trimHistory() {
  if (state.history.length <= HISTORY_LIMIT) return;
  state.history = state.history.slice(-HISTORY_LIMIT);
  // The API requires the conversation to open on a user turn.
  while (state.history.length && state.history[0].role !== "user") state.history.shift();
}

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

function toggleLog(force) {
  const open = force ?? el.log.hidden;
  el.log.hidden = !open;
  el.logToggle.setAttribute("aria-expanded", String(open));
}

el.logToggle.addEventListener("click", () => toggleLog());
el.logClose.addEventListener("click", () => toggleLog(false));
el.typeToggle.addEventListener("click", () =>
  el.typedForm.hidden ? openTypedInput() : closeTypedInput()
);

document.addEventListener("keydown", (event) => {
  const typing = event.target === el.typedInput;

  if (event.key === "Escape") {
    if (typing) {
      closeTypedInput();
      el.typedInput.blur();
    } else if (!el.log.hidden) toggleLog(false);
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
    toggleLog();
  } else if (event.key === "m" || event.key === "M") {
    el.mute.click();
  }
});

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
  setMode("idle");
  el.logBody.innerHTML = '<p class="log__empty">No exchanges yet</p>';

  if (!listener.supported) {
    el.hint.innerHTML =
      "Voice input needs Chrome, Edge or Safari — press <kbd>/</kbd> to type instead";
    toast("This browser has no speech recognition. Text input is available.");
  }

  try {
    const health = await fetch("/api/health").then((r) => r.json());
    el.modelReadout.textContent = `◦ ${health.model}`;
  } catch {
    el.modelReadout.textContent = "◦ offline";
    toast("Backend unreachable. Start it with: npm run jarvis");
  }

  requestAnimationFrame(frame);
}

void boot();
