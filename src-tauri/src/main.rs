// Prevents an extra console window on Windows in release. No-op on macOS, but
// kept for the cross-platform path Tauri leaves open (PRD §11).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    peeky_lib::run();
}
