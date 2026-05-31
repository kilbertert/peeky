//! Rolling in-memory context (PRD §4.3, "记忆模块·简化版 P1").
//!
//! No RAG, no vector store — just a small fixed-window deque of the most recent
//! things the mascot has said, plus the current reading progress and the
//! current foreground app/title. `recent()` renders this into a compact text
//! block that the prompt builder embeds so the model can:
//!   * avoid repeating the same joke / fact ("不重复"),
//!   * keep continuity across consecutive observations ("延续性").
//!
//! Everything lives behind a `Mutex<RollingMemory>` in `AppState`; this type is
//! itself single-threaded and just owns the data.

use std::collections::VecDeque;

use crate::types::AppContext;

/// How many recent utterances to keep. PRD §4.3 says a small fixed window
/// ("超长就丢最旧的"); ~10 keeps the prompt cheap while giving enough context.
const MAX_ENTRIES: usize = 10;

/// Rolling context window fed into every prompt.
#[derive(Debug, Default)]
pub struct RollingMemory {
    /// Most-recent-last deque of past utterances (already `<SILENT>`-filtered
    /// by the caller — only real spoken lines are pushed).
    recent: VecDeque<String>,
    /// Free-form reading-progress note, updated on scroll (e.g. "读到约 60%"
    /// or a section title). Empty when not reading anything trackable.
    reading_progress: String,
    /// Last foreground app context we recorded, for continuity in the prompt.
    context: Option<AppContext>,
}

impl RollingMemory {
    /// Create an empty rolling memory.
    pub fn new() -> Self {
        RollingMemory::default()
    }

    /// Record a new utterance the mascot just spoke. Trims to the fixed window,
    /// dropping the oldest entry when full. Blank input is ignored.
    pub fn push(&mut self, utterance: &str) {
        let trimmed = utterance.trim();
        if trimmed.is_empty() {
            return;
        }
        self.recent.push_back(trimmed.to_string());
        while self.recent.len() > MAX_ENTRIES {
            self.recent.pop_front();
        }
    }

    /// Render a compact text block of the current rolling context for the
    /// prompt. Returns an empty string when there is nothing to say yet, so the
    /// prompt builder can omit the memory section entirely.
    pub fn recent(&self) -> String {
        let mut out = String::new();

        if let Some(ctx) = &self.context {
            if !ctx.app.is_empty() || !ctx.title.is_empty() {
                out.push_str("Current app: ");
                out.push_str(&ctx.app);
                if !ctx.title.is_empty() {
                    out.push_str(" — ");
                    out.push_str(&ctx.title);
                }
                if let Some(url) = &ctx.url {
                    if !url.is_empty() {
                        out.push_str(" (");
                        out.push_str(url);
                        out.push(')');
                    }
                }
                out.push('\n');
            }
        }

        if !self.reading_progress.is_empty() {
            out.push_str("Reading progress: ");
            out.push_str(&self.reading_progress);
            out.push('\n');
        }

        if !self.recent.is_empty() {
            out.push_str("Recently said (do not repeat):\n");
            for (i, line) in self.recent.iter().enumerate() {
                // Newest last; number them so the model sees ordering.
                out.push_str(&format!("{}. {}\n", i + 1, line));
            }
        }

        out.trim_end().to_string()
    }

    /// Update the reading-progress note (called on `Scroll` decisions, PRD §2.2
    /// / §4.3). Pass a short human-readable marker.
    pub fn set_reading_progress(&mut self, progress: &str) {
        self.reading_progress = progress.trim().to_string();
    }

    /// Current reading-progress note (empty if unset).
    pub fn get_reading_progress(&self) -> String {
        self.reading_progress.clone()
    }

    /// Update the remembered foreground app/title/url context.
    pub fn set_context(&mut self, ctx: &AppContext) {
        self.context = Some(ctx.clone());
    }

    /// Record the current foreground context and, if the APP changed since last
    /// time, drop the carried-over utterance history + reading progress. This
    /// stops Peeky from stitching two unrelated screens together ("之前提到的
    /// Peeky/tmux…" while now looking at WeChat). Returns true if it cleared.
    pub fn observe_context(&mut self, ctx: &AppContext) -> bool {
        let changed = match &self.context {
            Some(prev) => !prev.app.eq_ignore_ascii_case(&ctx.app),
            None => false,
        };
        if changed {
            self.recent.clear();
            self.reading_progress.clear();
        }
        self.context = Some(ctx.clone());
        changed
    }

    /// Current remembered foreground context, if any.
    pub fn get_context(&self) -> Option<AppContext> {
        self.context.clone()
    }

    /// Drop all recent utterances and reading progress (e.g. on mode switch or
    /// when the user explicitly resets). Keeps nothing.
    pub fn clear(&mut self) {
        self.recent.clear();
        self.reading_progress.clear();
        self.context = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_trims_to_window() {
        let mut m = RollingMemory::new();
        for i in 0..(MAX_ENTRIES + 5) {
            m.push(&format!("line {i}"));
        }
        // Only the last MAX_ENTRIES survive; oldest dropped.
        let rendered = m.recent();
        assert!(rendered.contains(&format!("line {}", MAX_ENTRIES + 4)));
        assert!(!rendered.contains("line 0\n"));
    }

    #[test]
    fn blank_push_ignored() {
        let mut m = RollingMemory::new();
        m.push("   ");
        assert!(m.recent().is_empty());
    }

    #[test]
    fn recent_includes_context_and_progress() {
        let mut m = RollingMemory::new();
        m.set_context(&AppContext {
            app: "Safari".into(),
            title: "Some Article".into(),
            url: Some("https://example.com".into()),
        });
        m.set_reading_progress("about 60%");
        m.push("nice take on rust");
        let out = m.recent();
        assert!(out.contains("Safari"));
        assert!(out.contains("Some Article"));
        assert!(out.contains("about 60%"));
        assert!(out.contains("nice take on rust"));
    }

    #[test]
    fn clear_resets_everything() {
        let mut m = RollingMemory::new();
        m.push("hello");
        m.set_reading_progress("50%");
        m.clear();
        assert!(m.recent().is_empty());
        assert!(m.get_reading_progress().is_empty());
        assert!(m.get_context().is_none());
    }
}
