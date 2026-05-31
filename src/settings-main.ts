/*
 * Entry point for the dedicated, opaque settings window (settings.html).
 *
 * Unlike the mascot overlay (main.ts / index.html, transparent + click-through),
 * this runs in its own normal macOS window with a solid background and title
 * bar. The mascot window is a separate process-side window and stays on screen
 * while this is open.
 *
 * Flow: localize -> mount the panel filling the window -> reload the live config
 * every time the window is (re)shown (`peeky://settings-shown`, emitted by the
 * Rust `show_settings_window`).
 */

import "./style.css";
import "./settings.css";
import { initI18n } from "./i18n/index";
import { mountSettings } from "./settings";

async function boot(): Promise<void> {
  await initI18n();

  const root = document.getElementById("settings-root");
  if (!root) return;

  const settings = mountSettings(root, { standalone: true });
  settings.open();

  // When the Rust side reveals the window again, refresh the form from disk.
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("peeky://settings-shown", () => settings.open());
  } catch {
    // Running outside Tauri (plain vite dev) — nothing to listen to.
  }
}

void boot();
