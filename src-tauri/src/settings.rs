//! Config + stats persistence (PRD §1.5 / §8.2). Files live under
//! `dirs::config_dir()/peeky/`:
//!   - `config.json` — the user `Config`
//!   - `stats.json`   — cumulative `TokenStats`
//!
//! Secret rule (PRD §1.5, §11): the private API key is NEVER hardcoded. If the
//! persisted/default config has an empty `api_key`, we overlay the
//! `PEEKY_API_KEY` environment variable at load time. Nothing is ever written
//! back that would persist an env-supplied key into the repo or config file
//! beyond what the user explicitly set.
//!
//! All functions are infallible at the call sites in `lib.rs` (`load_config` /
//! `load_stats` fall back to defaults; saves log and swallow errors) so the app
//! never fails to start because of a malformed or missing config file.

use std::fs;
use std::path::PathBuf;

use crate::types::{Config, HistoryEntry, TokenStats};

/// Cap on persisted history entries (newest kept). Keeps the file small and the
/// settings list snappy.
const HISTORY_CAP: usize = 500;

/// Env var that may supply the API key when the config leaves it blank
/// (PRD §1.5). Never written to disk by us.
const ENV_API_KEY: &str = "PEEKY_API_KEY";

/// The `peeky/` directory under the OS config dir, creating it if needed.
/// Falls back to the current directory if no config dir is resolvable (so we
/// still degrade gracefully rather than panic).
fn peeky_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("peeky");
    // Best-effort create; errors surface later on read/write.
    let _ = fs::create_dir_all(&dir);
    dir
}

fn config_path() -> PathBuf {
    peeky_dir().join("config.json")
}

fn stats_path() -> PathBuf {
    peeky_dir().join("stats.json")
}

fn history_path() -> PathBuf {
    peeky_dir().join("history.json")
}

/// Overlay the `PEEKY_API_KEY` env var onto a config whose key is blank
/// (PRD §1.5 secret rule). Trims whitespace; an all-whitespace env value is
/// treated as unset.
fn apply_env_key(mut cfg: Config) -> Config {
    if cfg.api_key.trim().is_empty() {
        if let Ok(env_key) = std::env::var(ENV_API_KEY) {
            let env_key = env_key.trim();
            if !env_key.is_empty() {
                cfg.api_key = env_key.to_string();
            }
        }
    }
    cfg
}

/// Load the user config from disk, falling back to `Config::default()` on any
/// error (missing file, malformed JSON). Always overlays `PEEKY_API_KEY` when
/// the resulting key is empty. Never panics.
pub fn load_config() -> Config {
    let path = config_path();
    let cfg = match fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Config>(&text) {
            Ok(cfg) => cfg,
            Err(e) => {
                eprintln!(
                    "[peeky] config.json at {} is invalid ({e}); using defaults",
                    path.display()
                );
                Config::default()
            }
        },
        Err(_) => {
            // No config yet — first run. Use defaults (key may come from env).
            Config::default()
        }
    };
    apply_env_key(cfg)
}

/// Persist the user config to `peeky/config.json` (pretty-printed for human
/// inspection). Errors are logged and swallowed so a failed write never crashes
/// the app or blocks a settings change.
///
/// Note: we write whatever `cfg.api_key` holds. If the user typed a key in the
/// settings UI it persists (their choice); if they left it blank to rely on
/// `PEEKY_API_KEY`, the blank persists and the env overlay re-applies on load.
pub fn save_config(cfg: &Config) {
    let path = config_path();
    match serde_json::to_string_pretty(cfg) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                eprintln!("[peeky] failed to write {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("[peeky] failed to serialize config: {e}"),
    }
}

/// Load cumulative token stats, defaulting to a zeroed `TokenStats` on any
/// error. Never panics.
pub fn load_stats() -> TokenStats {
    let path = stats_path();
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<TokenStats>(&text).unwrap_or_else(|e| {
            eprintln!(
                "[peeky] stats.json at {} is invalid ({e}); resetting",
                path.display()
            );
            TokenStats::default()
        }),
        Err(_) => TokenStats::default(),
    }
}

/// Persist token stats to `peeky/stats.json`. Errors are logged and swallowed.
pub fn save_stats(stats: &TokenStats) {
    let path = stats_path();
    match serde_json::to_string_pretty(stats) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                eprintln!("[peeky] failed to write {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("[peeky] failed to serialize stats: {e}"),
    }
}

/// Load the utterance history (newest entries last, as stored). Returns an empty
/// vec on any error. Never panics.
pub fn load_history() -> Vec<HistoryEntry> {
    let path = history_path();
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str::<Vec<HistoryEntry>>(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Append one utterance to the history file, trimming to `HISTORY_CAP` newest.
/// Errors are logged and swallowed.
pub fn append_history(entry: HistoryEntry) {
    let mut hist = load_history();
    hist.push(entry);
    let len = hist.len();
    if len > HISTORY_CAP {
        hist.drain(0..len - HISTORY_CAP);
    }
    write_history(&hist);
}

/// Replace the whole history file (used by `clear_history`).
pub fn clear_history() {
    write_history(&[]);
}

fn write_history(hist: &[HistoryEntry]) {
    let path = history_path();
    match serde_json::to_string(hist) {
        Ok(json) => {
            if let Err(e) = fs::write(&path, json) {
                eprintln!("[peeky] failed to write {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("[peeky] failed to serialize history: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes the tests that mutate the shared `PEEKY_API_KEY` env var.
    /// Without this they race (one test's set_var leaks into the other's assert)
    /// because cargo runs tests in the same process on multiple threads.
    static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn env_key_overlays_only_when_blank() {
        let _guard = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let mut cfg = Config::default();
        assert!(cfg.api_key.is_empty());

        // Simulate a config that already has a key — env must not override it.
        cfg.api_key = "user-set-key".to_string();
        // Even if env is set, the user's key wins.
        std::env::set_var(ENV_API_KEY, "env-key");
        let out = apply_env_key(cfg.clone());
        assert_eq!(out.api_key, "user-set-key");

        // Blank key picks up the env value.
        cfg.api_key = String::new();
        let out = apply_env_key(cfg);
        assert_eq!(out.api_key, "env-key");

        std::env::remove_var(ENV_API_KEY);
    }

    #[test]
    fn whitespace_env_key_is_ignored() {
        let _guard = ENV_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(ENV_API_KEY, "   ");
        let cfg = apply_env_key(Config::default());
        assert!(cfg.api_key.is_empty());
        std::env::remove_var(ENV_API_KEY);
    }
}
