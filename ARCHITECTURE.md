# Peeky — Architecture

Peeky (探头看你屏幕的魔法小精灵) is a transparent floating macOS desktop AI
companion built with **Tauri 2** — a Rust backend (`src-tauri/`) and a vanilla
TypeScript + Vite webview frontend (`src/`). It periodically captures the
screen, decides — cheaply — whether anything meaningful changed, and, when
appropriate, asks an OpenAI-compatible model to say something through an
animated floating mascot. macOS only this milestone.

See `prd_screen_companion.md` for the full product spec.

## How to run

Prereqs: macOS, Rust (stable), Node + **pnpm**, the Tauri CLI.

```bash
pnpm install                 # install frontend deps
cp .env.example .env         # then set PEEKY_API_KEY (optional; can also be set in-app)
pnpm tauri dev               # run the desktop app (starts Vite on :1420 + Rust)
pnpm tauri build             # produce a macOS .app / .dmg
```

- Frontend dev server: `http://localhost:1420` (Vite, `clearScreen: false`).
- Production webview loads the built `dist/` directory.
- API key: provide via the settings panel **or** the `PEEKY_API_KEY` env var.
  Never hardcode a private key into the repo (PRD §1.5 / §11).

## Pipeline (PRD §2.1 main loop)

A background tokio task ticks every **500ms**. While not paused / not already
speaking:

1. **L0 event gate (zero cost)** — `trigger::front_app_context()` reads the
   frontmost app / window title / browser URL via `osascript`.
2. **L1 cheap pixel check** — `capture::capture_screen` → downsample to 128px →
   `capture::to_gray_128` → `trigger::TriggerEngine::evaluate`: pHash hamming +
   vertical cross-correlation scroll detection → `TriggerDecision`.
   - `Scroll` updates reading progress, does not speak.
   - `Meaningful` proceeds.
3. **L2 debounce** — wait ~800ms of stability before committing.
4. **Restraint** — `RestraintEngine::allow_speak` enforces speech budget/hour,
   quiet hours, macOS DND, fullscreen/meeting pause, ignore-decay (PRD §4).
5. **Speak** — emit `scanning`→`thinking`, full-quality capture,
   `modes::build_messages(mode, lang, b64, memory)`, then
   `api::stream_chat` streaming tokens to the bubble. If the model returns the
   `<SILENT>` marker, no bubble shows; otherwise the utterance is remembered and
   token stats updated.

Manual trigger (Ctrl+Shift+Space / `trigger_now`) bypasses restraint (PRD §4
主动优先).

## Modules (Rust, `src-tauri/src/`)

| File | Responsibility |
|------|----------------|
| `types.rs` | Shared types: `Config`, `ModeKind`, `PermissionMode`, `Language`/`ResolvedLang`, `Quality`, `QuietHours`, `CapturedImage`, `AppContext`, `TriggerDecision`, `ChatMessage`, `TokenStats`, mascot-state constants. |
| `error.rs` | `AppError` + `Result` alias; serializes to a string for the frontend. |
| `state.rs` | `AppState` — `parking_lot::Mutex` config/stats/engines + atomic pause/speaking flags. |
| `capture.rs` | `capture_screen` (xcap, DPI-normalize, downsample to 1280px, PNG→base64), `downsample`, `to_gray_128`. |
| `trigger.rs` | `TriggerEngine` (pHash + scroll detection), `front_app_context`. |
| `api.rs` | `stream_chat` — OpenAI `/chat/completions` SSE streaming, vision format, never disables TLS. |
| `modes.rs` | `build_messages` (loads `prompts/*.md`, text-first then image), `SILENT_MARKER`. |
| `restraint.rs` | `RestraintEngine` (budget / quiet hours / DND / meeting pause / ignore-decay). |
| `memory.rs` | `RollingMemory` — fixed ~10-entry window + reading progress. |
| `tools.rs` | Copilot tools (screenshot/scroll/click/type/key via enigo); honors the §3.3 hard-forbidden list. |
| `settings.rs` | `load_config`/`save_config`/`load_stats`/`save_stats`; `PEEKY_API_KEY` env overlay. |
| `commands.rs` | `#[tauri::command]` functions exposed to the frontend. |
| `lib.rs` | Module wiring, Tauri builder, global shortcuts, command registration, the 500ms main loop, event emission. |

## Tauri commands (JS → Rust)

`get_config`, `set_config`, `get_system_locale`, `trigger_now`, `pause_toggle`,
`set_mode`, `set_permission_mode`, `get_token_stats`, `test_api_connection`.

## Tauri events (Rust → JS)

| Event | Payload | Meaning |
|-------|---------|---------|
| `peeky://state` | `{ state }` | Drive the mascot animation state machine. |
| `peeky://speak` | `{ mode }` | A new utterance is starting (clear the bubble). |
| `peeky://token` | `{ text, done }` | Streaming token chunk; `done:true` ends it. |
| `peeky://silent` | — | Model returned `<SILENT>`. |
| `peeky://config-changed` | `Config` | Config changed (e.g. mode cycled by shortcut). |
| `peeky://open-settings` | — | Shortcut asked the frontend to open settings. |

## Global shortcuts (PRD §8.1)

`Ctrl+Shift+Space` trigger · `Ctrl+Shift+M` cycle mode · `Ctrl+Shift+P` pause ·
`Ctrl+Shift+S` settings. Plus: double-click mascot = pause, hover = tools/settings.

## Frontend (`src/`)

- `main.ts` — entry: `initI18n` → `initMascot` → `mountSettings`; subscribes to
  all `peeky://` events and drives the mascot.
- `mascot.ts` / `mascot.css` — transparent draggable character + auto-positioned
  speech bubble (typewriter, no audio).
- `settings.ts` / `settings.css` — settings panel (PRD §8.2).
- `i18n/` — `en.json` / `zh.json` / `ja.json`, default from system locale.

## Window config (`tauri.conf.json`)

One window, `360×420`, transparent, no decorations, always-on-top, non-resizable,
skip-taskbar, `macOSPrivateApi: true`, `withGlobalTauri: true`.

## Security red-lines (PRD §1.5 / §3.3 / §11)

- Never hardcode the private 4090 key (or any key) into the repo.
- Never disable TLS verification.
- Honor the §3.3 hard-forbidden tool list (delete files, quit apps, shutdown,
  system settings, sudo, send mail/messages, payments, password managers,
  install/uninstall, browser settings) — refuse, never execute.

## License

MIT (`LICENSE`).
