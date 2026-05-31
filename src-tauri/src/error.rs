//! Central error type for Peeky. Most internal modules use `anyhow::Result`
//! for ergonomics; `AppError` is the typed boundary error that crosses into
//! Tauri commands (so it can serialize a clean message to the frontend).

use serde::Serialize;
use thiserror::Error;

/// Top-level application error.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("configuration error: {0}")]
    Config(String),

    #[error("screen capture failed: {0}")]
    Capture(String),

    #[error("API request failed: {0}")]
    Api(String),

    #[error("tool execution refused: {0}")]
    Forbidden(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// Catch-all bridge from `anyhow`, so `?` works on anyhow results.
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

/// Crate-wide result alias.
pub type Result<T> = std::result::Result<T, AppError>;

/// Tauri commands must return errors that serialize. We serialize the
/// `Display` form (a single human-readable string) to keep the frontend simple.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
