/*
 * Peeky webview entry (FRONTEND-GLUE).
 *
 * Boot sequence (per the frontend CONTRACT):
 *   import "./style.css"
 *   await initI18n()
 *   const mascot   = initMascot(#app)
 *   wire every peeky:// event -> drive the mascot
 *   (settings live in their own opaque OS window — opened via the
 *    `open_settings` command; see settings-main.ts / settings.html)
 *   wire interactions (hover toolbar, double-click pause, single-click bubble,
 *                      manual trigger)
 *
 * This module owns NO behaviour of its own beyond glue: it translates backend
 * events into MascotController calls and translates user gestures into Tauri
 * `invoke` commands. It must also survive running in a plain browser (vite dev
 * without Tauri) so the UI still renders — every Tauri touchpoint is guarded.
 *
 * Owns: src/main.ts  (per FILE OWNERSHIP).
 */

import "./style.css";

import { initI18n, t } from "./i18n/index";
import { initMascot, type MascotController } from "./mascot";

/* -------------------------------------------------------------------------- */
/* Tauri-environment guards                                                   */
/* -------------------------------------------------------------------------- */

/**
 * True when we're running inside a real Tauri webview. In plain `vite dev`
 * (no Tauri shell) `window.__TAURI_INTERNALS__` / `window.__TAURI__` is absent,
 * so we skip every IPC call and the UI still mounts for visual development.
 */
function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return (
    typeof w.__TAURI_INTERNALS__ !== "undefined" ||
    typeof w.__TAURI__ !== "undefined"
  );
}

/**
 * Safe `invoke`: resolves to `undefined` (never throws) when Tauri is missing
 * or the command fails. Glue code should never crash the mascot because a
 * command was unavailable.
 */
async function safeInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | undefined> {
  if (!inTauri()) return undefined;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[peeky] invoke "${cmd}" failed:`, err);
    return undefined;
  }
}

/** Event payload shapes emitted by the Rust backend (see CONTRACT). */
interface StatePayload {
  state: string;
}
interface SpeakPayload {
  mode: string;
}
interface TokenPayload {
  text: string;
  done: boolean;
}
interface ErrorPayload {
  key: string;
  detail: string;
}

type UnlistenFn = () => void;

/**
 * Subscribe to a backend event. No-op (returns a noop unlisten) outside Tauri.
 * The listener is wrapped so a throwing handler can't break the event bridge.
 */
async function safeListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!inTauri()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<T>(event, (e) => {
      try {
        handler(e.payload as T);
      } catch (err) {
        console.warn(`[peeky] handler for "${event}" threw:`, err);
      }
    });
  } catch (err) {
    console.warn(`[peeky] listen "${event}" failed:`, err);
    return () => {};
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

async function boot(): Promise<void> {
  // i18n first so the mascot toolbar tooltips + settings render localized.
  await initI18n();

  const appRoot = document.getElementById("app");
  if (!appRoot) {
    console.error('[peeky] missing #app root; aborting boot.');
    return;
  }

  const mascot = initMascot(appRoot);

  // Track paused state locally so single-/double-click + shortcuts can reflect
  // it without an extra round-trip. The backend remains the source of truth:
  // pause_toggle returns the authoritative new value.
  let paused = false;

  wireBackendEvents(mascot);
  wireInteractions(mascot, {
    isPaused: () => paused,
    setPaused: (v) => {
      paused = v;
    },
  });
}

/** Open the dedicated, opaque settings window (Rust shows window "settings"). */
function openSettings(): void {
  void safeInvoke("open_settings");
}

/* -------------------------------------------------------------------------- */
/* Backend events -> mascot                                                    */
/* -------------------------------------------------------------------------- */

function wireBackendEvents(mascot: MascotController): void {
  // "peeky://state" -> drive the animation state machine.
  void safeListen<StatePayload>("peeky://state", (p) => {
    if (p && typeof p.state === "string") mascot.setState(p.state);
  });

  // "peeky://speak" -> a new utterance begins: clear bubble, set mode accent.
  void safeListen<SpeakPayload>("peeky://speak", (p) => {
    mascot.startUtterance(p?.mode ?? "roast");
  });

  // "peeky://token" -> stream a chunk; done=true ends the utterance.
  void safeListen<TokenPayload>("peeky://token", (p) => {
    if (!p) return;
    if (p.text) mascot.appendToken(p.text);
    if (p.done) mascot.endUtterance();
  });

  // "peeky://silent" -> model had nothing to say: sparkle "has-something" cue.
  void safeListen<unknown>("peeky://silent", () => {
    mascot.showHasSomething();
  });

  // "peeky://error" -> show a localized problem (missing key, request failed,
  // capture denied) in a distinct red bubble so the core loop is debuggable.
  void safeListen<ErrorPayload>("peeky://error", (p) => {
    if (!p || !p.key) return;
    const detail = p.detail ? ` — ${p.detail.slice(0, 220)}` : "";
    mascot.showError(`${t(p.key)}${detail}`);
  });

  // "peeky://status" -> a tool is running (scrolling/typing/reading). Shows a
  // status line instead of streamed text — the agent isn't talking right now.
  // payload { key, detail }: key is localized; detail (e.g. a target) appended.
  void safeListen<ErrorPayload>("peeky://status", (p) => {
    if (!p || !p.key) return;
    const detail = p.detail ? ` ${p.detail.slice(0, 80)}` : "";
    mascot.showStatus(`${t(p.key)}${detail}`);
  });

  // "peeky://ask" -> the user pressed Ctrl+Shift+B: the backend already captured
  // their screen and is waiting for a typed question. Show the input box; submit
  // pairs the question with the parked shot, cancel drops it.
  void safeListen<unknown>("peeky://ask", () => {
    mascot.showAsk({
      onSubmit: (question) => {
        void safeInvoke("ask_submit", { question });
      },
      onCancel: () => {
        void safeInvoke("ask_cancel");
      },
    });
  });

  // "peeky://config-changed" -> language/styling may have changed.
  // Re-resolve i18n (initI18n re-reads Config.language). The settings panel
  // re-renders via its own onLanguageChange subscription, so we only refresh
  // the active language table here.
  void safeListen<unknown>("peeky://config-changed", () => {
    void initI18n();
  });
}

/* -------------------------------------------------------------------------- */
/* User interactions                                                           */
/* -------------------------------------------------------------------------- */

interface PauseTracker {
  isPaused(): boolean;
  setPaused(v: boolean): void;
}

function wireInteractions(
  mascot: MascotController,
  pause: PauseTracker,
): void {
  const character = mascot.characterEl;
  const toolbar = mascot.toolbarEl;

  // --- hover toolbar buttons (settings gear + pause) -----------------------
  toolbar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement)?.closest<HTMLElement>("[data-action]");
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.action;
    if (action === "settings") {
      openSettings();
    } else if (action === "pause") {
      void togglePause(mascot, pause);
    }
  });

  // --- single-click: toggle the current bubble -----------------------------
  // mascot.ts already suppresses the click that follows a real drag.
  character.addEventListener("click", () => {
    mascot.toggleBubble();
  });

  // --- double-click: pause / resume ----------------------------------------
  character.addEventListener("dblclick", (e) => {
    e.preventDefault();
    void togglePause(mascot, pause);
  });

  // --- manual-trigger affordance -------------------------------------------
  // The global shortcut (Ctrl+Shift+Space) is registered in Rust, but we also
  // expose it from the webview: right-click the mascot fires a manual trigger
  // (capture + call, bypassing the restraint engine — PRD §4 主动优先).
  character.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    void safeInvoke("trigger_now");
  });

  // --- keyboard fallbacks (mirror PRD §8.1 shortcuts) ----------------------
  // The OS-level global shortcuts live in Rust; these only fire when the
  // webview itself has focus, as a convenience / dev affordance.
  window.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey && e.shiftKey;
    if (!mod) return;
    switch (e.code) {
      case "Space": // Ctrl+Shift+Space -> manual trigger
        e.preventDefault();
        void safeInvoke("trigger_now");
        break;
      case "KeyP": // Ctrl+Shift+P -> pause / resume
        e.preventDefault();
        void togglePause(mascot, pause);
        break;
      case "KeyS": // Ctrl+Shift+S -> open settings
        e.preventDefault();
        openSettings();
        break;
      case "KeyM": // Ctrl+Shift+M -> cycle mode
        e.preventDefault();
        void cycleMode();
        break;
      default:
        break;
    }
  });
}

/**
 * Toggle pause via the backend and reflect it locally. pause_toggle returns the
 * authoritative new paused state; we set the mascot to "paused" (sleeping) or
 * back to "idle" accordingly (PRD §6.2/§7 — paused = the "I'm not watching"
 * privacy indicator).
 */
async function togglePause(
  mascot: MascotController,
  pause: PauseTracker,
): Promise<void> {
  const result = await safeInvoke<boolean>("pause_toggle");
  // Outside Tauri (no result) we still flip the local flag for visual feedback.
  const next = typeof result === "boolean" ? result : !pause.isPaused();
  pause.setPaused(next);
  mascot.setState(next ? "paused" : "idle");
}

/**
 * Cycle the active mode roast -> nerd -> copilot -> roast (PRD §8.1 Ctrl+Shift+M).
 * We can't read the current mode synchronously here, so we ask the backend to
 * advance by reading config; if unavailable, default-advance from roast.
 */
async function cycleMode(): Promise<void> {
  const order: Array<"roast" | "nerd" | "copilot"> = ["roast", "nerd", "copilot"];
  const cfg = await safeInvoke<{ mode?: string }>("get_config");
  const cur = (cfg?.mode as "roast" | "nerd" | "copilot") ?? "roast";
  const idx = order.indexOf(cur);
  const next = order[(idx + 1) % order.length];
  await safeInvoke("set_mode", { mode: next });
}

/* -------------------------------------------------------------------------- */
/* Kickoff                                                                     */
/* -------------------------------------------------------------------------- */

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void boot());
} else {
  void boot();
}
