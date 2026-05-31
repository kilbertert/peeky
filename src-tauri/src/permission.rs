//! macOS Screen Recording permission probe + prompt.
//!
//! Screen capture (xcap / CGWindowList) silently returns a BLACK frame when the
//! app has not been granted "Screen Recording" in System Settings → Privacy &
//! Security. That black frame is indistinguishable from a real one to the model,
//! which then hallucinates — so we must detect the permission explicitly and
//! guide the user instead of sending a black image.
//!
//! `CGPreflightScreenCaptureAccess` checks the current grant without prompting;
//! `CGRequestScreenCaptureAccess` shows the system prompt (only effective the
//! first time — afterwards the user must toggle it in System Settings, which is
//! why we also expose a "open the Screen Recording pane" path in commands.rs).

#[cfg(target_os = "macos")]
mod imp {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// True if the app currently holds Screen Recording permission. No prompt.
    pub fn screen_capture_authorized() -> bool {
        // SAFETY: simple FFI to a parameterless CoreGraphics predicate.
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    /// Show the system Screen Recording prompt (first run only). Returns whether
    /// access is granted afterwards.
    pub fn request_screen_capture() -> bool {
        // SAFETY: simple FFI; triggers the one-time system permission dialog.
        unsafe { CGRequestScreenCaptureAccess() }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// Non-macOS platforms don't gate screen capture this way.
    pub fn screen_capture_authorized() -> bool {
        true
    }
    pub fn request_screen_capture() -> bool {
        true
    }
}

pub use imp::*;
